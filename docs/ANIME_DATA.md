# ANIME_DATA — where anime data comes from and how it is combined

> Snapshot: 2026-10-06 — **Phase 1 landed** (single canonical AniList ID; catalog endpoints live-backed). Verified against code and a live run.
> Legend: **CURRENT** · **PLANNED** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Sources (CURRENT)

### 1.1 AniList GraphQL (primary, live)
- URL: `https://graphql.anilist.co` — public, **keyless**, called only by the server via `axios` (timeouts 10–15 s).
- Queries used (the four catalog lists share one media-field selection built by `buildCatalogQuery`):
  - `/api/popular`: `Page(page: 1, perPage: 50, sort: POPULARITY_DESC, isAdult: false)`.
  - `/api/trending`: `Page(page: 1, perPage: 20, sort: TRENDING_DESC, isAdult: false)`.
  - `/api/movies`: the popular query with `format_in: [MOVIE]`.
  - `/api/series`: the popular query with `format_in: [TV, TV_SHORT]`.
  - `/api/genre/:genre`: the popular query with `genre: $genre` (a GraphQL variable, never interpolated) at 30 items; `?type=series|movies` adds the matching format group.
  - `/api/genres`: `query { GenreCollection }`.
  - `/api/search`: `Page(perPage: 10, sort: SEARCH_MATCH)` with a `search` variable.
  - `/api/anime/:id`: single `Media`, including studios, staff (6), characters + first JP voice actor (6), trailer, relations, recommendations (6), start date, duration, source, country.
- Timeouts: 10 s for the catalog/genre queries, 15 s for search and detail.
- Rate limits/quotas are managed by AniList; **the app does not implement client-side rate limiting or retry** — but every catalog list is cached for 10 minutes, which bounds the request volume.

### 1.2 Local curated catalog (secondary, static)
- `ANIME_DB` in `server.js`: **12 hand-written entries** with a 10-point `rating`, human-readable `status`, AniList CDN artwork URLs.
- Each entry carries **`anilistId` only**. The hand-assigned `id: 1–12` field was removed in Phase 1 (2026-10-06), and `catalog-utils.withCanonicalId` sets `id` from `anilistId` on every outgoing item.

| title | anilistId |
| --- | --- |
| Jujutsu Kaisen | 113415 |
| Solo Leveling | 151807 |
| One Piece | 21 |
| Demon Slayer | 101922 |
| Attack on Titan | 16498 |
| Naruto | 20 |
| Death Note | 1535 |
| Fullmetal Alchemist: Brotherhood | 5114 |
| Bleach | 269 |
| Vinland Saga | 101348 |
| Steins;Gate | 9253 |
| Hunter x Hunter | 11061 |

- Used by: as the curation overlay for `/api/trending`, `/api/popular`, `/api/movies`, `/api/series` and `/api/genre/:genre`; as the source for `/api/genres`; as the answer for genres AniList does not define; and as the **offline fallback** for every catalog endpoint when AniList fails. No route addresses it by ID any more (§3).

### 1.3 No other data source
There is **no** database of anime titles, no CMS, no scraper, no local JSON catalog file (`public/data.js` was removed as dead code). Anime titles live only in `ANIME_DB` (12) and in live AniList responses.

## 2. Merge behaviour (CURRENT) — `catalog-utils.js`

`mergeAniListCatalog(localCatalog, mediaList)`:

1. Build an index of local entries by `anilistId` (or `id` when `anilistId` is absent).
2. For each AniList media item: validate `id` (integer ≥ 1, else skip), map to the catalog shape via `mapAniListMediaToCatalogItem`, skip duplicates, then merge with a matching local entry if one exists.
3. **Merge policy** (`mergeCuratedItem`):
   - Live AniList is authoritative for every field in `ANILIST_AUTHORITATIVE_FIELDS`: `title, description, image, poster, banner, episodes, status, studio, year, rating, genre, type, language`.
   - The local value is kept only when the AniList value is unusable (`null`/`undefined`/`0`/empty string/empty array/`"unknown"`/`"n/a"`).
   - Local-only keys (custom tags, editorial badges, link metadata) always survive — that is where site-specific curation belongs.
   - The AniList ID is the single canonical identity: `mergeCuratedItem` sets **both** `id` and `anilistId` from the AniList item, so a matched entry can never expose a local key.
4. Any local entry with no AniList match is appended with its curated fields intact and is keyed by its AniList ID (`withCanonicalId`).
5. Format- and genre-filtered lists re-apply their own filter *after* the merge, so a curated entry only appears in a list it actually belongs to (a films list can never carry a curated series).
6. If AniList is unavailable, each catalog loader returns the stale cache, else the curated catalog — **no field ever depends on AniList being reachable**.

**Normalisation details** (`mapAniListMediaToCatalogItem`): rating = `averageScore / 10` (10-point scale), `year = seasonYear || startDate.year`, `status` mapped (`FINISHED→Completed`, `RELEASING→Airing`, `HIATUS→Hiatus`, `NOT_YET_RELEASED→Upcoming`), `language` derived from `countryOfOrigin` (`JP→Japanese`, `KR→Korean`, `CN/TW→Chinese`, else `Unknown`), studio = first main studio name.

## 3. One canonical ID space (CURRENT — RESOLVED 2026-10-06)

| Identity | Meaning | Example | Used by |
| --- | --- | --- | --- |
| **AniList ID** (`id` and `anilistId`) | AniList's own ID; the only anime identity the site exposes | `113415` = Jujutsu Kaisen | `/api/anime/:id`, `/api/trending`, `/api/popular`, `/api/movies`, `/api/series`, `/api/genre/:genre`, cards' `data-id`, detail links, cloud watchlist rows (`watchlist.anime_id`) |

- The hand-assigned local `id` (1–12) **no longer exists**. `ANIME_DB` entries declare `anilistId`, and `withCanonicalId` guarantees `id === anilistId` on every item leaving a catalog endpoint.
- `/api/detail/:id` is **retired**: a positive integer id now returns `308` to `/api/anime/:id`, so an old `?id=` link resolves to the same AniList title. Verified: `/api/detail/1` → `/api/anime/1` → Cowboy Bebop (it previously returned Jujutsu Kaisen).
- Because the canonical key is now decided and enforced, watch progress, history, continue-watching and favourites records have one stable key (`watchlist.anime_id` already stores AniList IDs, so **no migration of existing watchlist rows is required**).

## 4. How each surface gets its data (CURRENT)

| Surface | Source | Behaviour |
| --- | --- | --- |
| Trending (home) | `/api/trending` | live `TRENDING_DESC` (20) + curated; 10-min cached. **Verified 30 items, 18 outside the curated set** |
| Popular (home preview + catalog page) | `/api/popular` | live merge; 10-min cached |
| Movies page | `/api/movies` | `format_in: [MOVIE]`, films only. **Verified 50 films** (was 3) |
| TV Series page | `/api/series` | `format_in: [TV, TV_SHORT]`, television only, plus a client-side format check. **Verified 51 titles, 0 films** (previously rendered every type) |
| Genre buttons (home / series) | `/api/genre/:genre` (+ `?type=series` on the Series page) | live genre query; `Comedy` → 30 (was 0). The Popular page's catalog form filters server-side through `/api/browse` (Task 2A, 2026-10-08) |
| Search results | AniList → curated fallback | live; 10 results; client-side filters/sort |
| Detail page | AniList | live per view; no cache |

## 5. Images (CURRENT)

- Poster/banner URLs come from AniList's CDN (`s4.anilist.co`) and are hot-linked by the browser.
- The client only accepts `https:` URLs (`safeImageUrl`); anything else (or empty) becomes `https://placehold.co/300x450/0f172a/ff7200?text=No+Poster`.
- `onerror` handlers swap failed images for the same placeholder.
- Local `ANIME_DB` entries also point at AniList CDN URLs (hardcoded).
- No image proxy, resizing, or caching layer exists.

## 6. Episodes (CURRENT limitation)

- The only episode data is a **total count** (`episodes`), plus a duration in minutes on the detail page.
- There is no episode list, numbering, titles, air dates, thumbnails, or per-episode endpoint.
- AniList's `streamingEpisodes` field is **not requested** anywhere.
- Consequence: episode-level tracking (progress per episode, "next episode", continue watching) cannot be built without first choosing and implementing an episode data model — see `docs/WATCH_SYSTEM.md`.

## 7. Fallback behaviour (CURRENT)

| Failure | Result |
| --- | --- |
| AniList down / error during any catalog endpoint (`/api/trending`, `/api/popular`, `/api/movies`, `/api/series`, `/api/genre/:genre`, `/api/genres`) | stale cache if present, else the curated catalog (or the curated genre matches); warning logged naming which was used. `/api/movies` is empty offline — the curated catalog has no films |
| AniList down during `/api/search` | local `searchAnimeLocal` (title/genre/studio/type matching with relevance ranking) mapped to the AniList response shape |
| AniList down during `/api/anime/:id` | a **curated** entry answers with **200** and `X-Catalog-Source: curated` (the AniList ID stays canonical); an ID that is not curated still fails honestly — **500** for an outage, **404** when AniList answers without that media, **400** for a non-numeric or out-of-range ID. Verified by `test-security.js` (2026-10-07) |
| Invalid/missing image | placeholder image |

## 8. NOT FOUND / NEEDS CONFIRMATION

- Whether the curated 12-item catalog should grow, shrink, or be retired now that every catalog list is live-backed.
- Whether AniList should remain the only metadata provider long-term.
- Whether the 10-minute catalog TTL is the right refresh policy (there is still no per-list override).
- Whether curated titles belong in `/api/trending` at all, or whether trending should be purely live.
