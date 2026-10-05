# ANIME_DATA — where anime data comes from and how it is combined

> Snapshot: 2026-10-05. Verified against code and a live run.
> Legend: **CURRENT** · **PLANNED** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Sources (CURRENT)

### 1.1 AniList GraphQL (primary, live)
- URL: `https://graphql.anilist.co` — public, **keyless**, called only by the server via `axios` (timeouts 10–15 s).
- Queries used:
  - `/api/popular`: `Page(page: 1, perPage: 50, sort: POPULARITY_DESC, isAdult: false)`.
  - `/api/search`: `Page(perPage: 10, sort: SEARCH_MATCH)` with a `search` variable.
  - `/api/anime/:id`: single `Media`, including studios, staff (6), characters + first JP voice actor (6), trailer, relations, recommendations (6), start date, duration, source, country.
- Rate limits/quotas are managed by AniList; **the app does not implement client-side rate limiting or retry**.

### 1.2 Local curated catalog (secondary, static)
- `ANIME_DB` in `server.js`: **12 hand-written entries** with a 10-point `rating`, human-readable `status`, AniList CDN artwork URLs.
- Entries (local `id` → AniList `anilistId`):

| local id | title | anilistId |
| --- | --- | --- |
| 1 | Jujutsu Kaisen | 113415 |
| 2 | Solo Leveling | 151807 |
| 3 | One Piece | 21 |
| 4 | Demon Slayer | 101922 |
| 5 | Attack on Titan | 16498 |
| 6 | Naruto | 20 |
| 7 | Death Note | 1535 |
| 8 | Fullmetal Alchemist: Brotherhood | 5114 |
| 9 | Bleach | 269 |
| 10 | Vinland Saga | 101348 |
| 11 | Steins;Gate | 9253 |
| 12 | Hunter x Hunter | 11061 |

- Used by: `/api/trending`, `/api/genre/:genre`, `/api/genres`, `/api/detail/:id`, as the merge overlay for `/api/popular`, and as the **offline fallback** when AniList fails.

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
   - `anilistId` always comes from AniList; the local `id` stays stable for matched entries.
4. Any local entry with no AniList match is appended unchanged.
5. If AniList is unavailable, `getPopularCatalog()` returns the untouched local catalog (or the stale cache) — **no field ever depends on AniList being reachable**.

**Normalisation details** (`mapAniListMediaToCatalogItem`): rating = `averageScore / 10` (10-point scale), `year = seasonYear || startDate.year`, `status` mapped (`FINISHED→Completed`, `RELEASING→Airing`, `HIATUS→Hiatus`, `NOT_YET_RELEASED→Upcoming`), `language` derived from `countryOfOrigin` (`JP→Japanese`, `KR→Korean`, `CN/TW→Chinese`, else `Unknown`), studio = first main studio name.

## 3. The two ID spaces (CURRENT — the key modelling problem)

| ID space | Meaning | Example | Used by |
| --- | --- | --- | --- |
| **Local catalog `id`** | Hand-assigned 1–12 in `ANIME_DB` | `1` = Jujutsu Kaisen | `/api/detail/:id` |
| **AniList `id` / `anilistId`** | AniList's own ID (large integers) | `113415` = Jujutsu Kaisen | `/api/anime/:id`, cards' `data-id`, detail links, cloud watchlist rows (`watchlist.anime_id`) |

Two endpoints accept an `:id` and mean different things — verified: `/api/detail/1` → Jujutsu Kaisen, `/api/anime/1` → Cowboy Bebop.

### Why this must be resolved before Watch Progress / History
- The watchlist already stores **AniList IDs** (`watchlist.anime_id`), and the client card ID is `anilistId || id` — so local-only entries would be stored under their `anilistId` (present in `ANIME_DB`), but `/api/trending` and `/api/genre/:genre` serve objects whose displayed `id` is the local one.
- Any future progress/history/continue-watching record needs one canonical key that is stable forever. If it is not chosen now, records written under one ID space will be unresolvable or wrongly resolved after the catalog unification.
- **Decision required (PLANNED, not made):** adopt the AniList ID as the single canonical anime identifier (recommended by the audit), document the migration for any existing local-ID data, and remove or explicitly re-document `/api/detail/:id`.

## 4. How each surface gets its data (CURRENT)

| Surface | Source | Behaviour |
| --- | --- | --- |
| Trending (home) | local only | fixed first 5 entries; not live |
| Popular (home preview + catalog page) | AniList + local merge | live, 10-min cached |
| Movies page | `/api/popular` | client filter `type === MOVIE` (3 movies observed) |
| TV Series page | `/api/popular` | **no filter** — renders all types |
| Genre buttons (home / series / movies) | `/api/genre/:genre` (local) except Popular page (client-side over live data) | inconsistent; `Comedy` → 0 results |
| Search results | AniList → local fallback | live; 10 results; client-side filters/sort |
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
| AniList down / error during `/api/popular` | stale cache if present, else the untouched 12-entry local catalog; warning logged |
| AniList down during `/api/search` | local `searchAnimeLocal` (title/genre/studio/type matching with relevance ranking) mapped to the AniList response shape |
| AniList down during `/api/anime/:id` | **500 error** — no local fallback for detail pages |
| Invalid/missing image | placeholder image |

## 8. NOT FOUND / NEEDS CONFIRMATION

- Whether the curated 12-item catalog should grow, shrink, or be retired once the catalog is unified.
- Whether AniList should remain the only metadata provider long-term.
- Intended refresh policy for "Trending" (no policy exists because the endpoint is static).
