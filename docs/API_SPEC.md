# API_SPEC — HTTP API reference (current implementation)

> Snapshot: 2026-10-06 — **Phase 1 landed** (single canonical AniList ID; the catalog endpoints are live-backed). Documents `server.js` exactly as it behaves today.
> Legend: **CURRENT** — implemented and reachable in `server.js` today · **NOT IMPLEMENTED** — absent (§3) ·
> **PLANNED** — recorded in `docs/ROADMAP.md`, not built · **NOT FOUND / NEEDS CONFIRMATION** — cannot be determined from the repository.
> Endpoints are **not** fixed, renamed, or removed by this document.
> Flags: 🔴 **DUPLICATE / CONFLICTING** · 🟡 **UNUSED by the frontend** · ⚪ **ADDITIONAL ENDPOINT RATE LIMIT** · ⚫ **NO CACHE** · 🆕 **NOT IMPLEMENTED**

## Summary table

| Method | Path | Purpose | Data source | Auth | Cache | Flags |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/` , `/index.html` | SPA shell with `__SITE_URL__` substituted | `public/index.html` read once at boot | none | none (no `Cache-Control`) |
| GET | `/*` | Static files from `public/` | filesystem | none | `public, max-age=0`; ETag/Last-Modified validators |
| GET | `/robots.txt` | Crawler rules + sitemap URL | generated | none | none |
| GET | `/sitemap.xml` | 5-URL sitemap | generated | none | none |
| GET | `/api/site-config` | Public site settings | env | none | `no-store` |
| GET | `/api/config` | Public Supabase client config | env | none | `no-store` |
| DELETE | `/api/account` | Self-service account deletion | Supabase Auth + Admin API | Bearer token (Supabase) | n/a | ⚪ |
| GET | `/api/trending` | Trending list (live) | AniList `TRENDING_DESC` + curated | none | 10-min in-memory |
| GET | `/api/popular` | Merged popular catalog | AniList `POPULARITY_DESC` + curated | none | 10-min in-memory |
| GET | `/api/movies` | Anime films (live) | AniList `format_in: [MOVIE]` + curated | none | 10-min in-memory |
| GET | `/api/series` | TV series (live) | AniList `format_in: [TV, TV_SHORT]` + curated | none | 10-min in-memory |
| GET | `/api/browse?…` | Strict browse backing the Popular page + **Load more**: `genre`, `year` (1960…current+1), `season`, `format` (TV/MOVIE/OVA/ONA/SPECIAL), `status` (RELEASING/FINISHED/NOT_YET_RELEASED), `minScore` 0–100, `sort` (MediaSort enums), `page` 1–50, `perPage` ≤30; repeated params rejected | AniList filtered page → curated fallback | none | 5-min in-memory (≤100, single-flight) | ⚪ |
| GET | `/api/search?q=` | Title search (10 results); 1-100 characters, empty or control-character query → **400** | AniList → curated fallback | none | ⚫ ⚪ |
| GET | `/api/genre/:genre` | Genre filter (optional `?type=series\|movies`) | AniList genre query → curated fallback | none | 10-min in-memory (≤30 genres) |
| GET | `/api/detail/:id` | **Retired** — permanent redirect to `/api/anime/:id` | — | none | n/a | 🟡 |
| GET | `/api/genres` | Genre list (adult genres excluded) | AniList `GenreCollection` + curated | none | 10-min in-memory | 🟡 |
| GET | `/api/anime/:id` | Detail by **AniList** id (staff, characters, relations, recommendations, trailer); a curated entry answers (HTTP **200**) when AniList is down, labelled `X-Catalog-Source: curated` instead of `anilist` | AniList → curated fallback | none | ⚫ ⚪ |
| POST | `/api/anime/search` | **Retired** — returns 404 | — | — | — | — |

Global middleware: CORS allowlist (`CORS_ORIGINS`; foreign origins → **403**; in production the list is validated at boot — see `docs/ENVIRONMENT.md` §3), security headers including CSP, `express.json({ limit: '16kb' })`, rate limits, and a JSON error handler.

Rate limits are process-local fixed windows: `/api` allows 120 requests per minute per client IP, except `/api/site-config` and `/api/config`; `/api/search` and `/api/anime/:id` additionally allow 60 per minute; `/api/account` allows 5 per 15 minutes. Set `TRUST_PROXY` to the actual proxy hop count in production so the limiter sees client IPs; counters are not shared across server instances.

Those security headers apply to **every** response, including the JSON 404 for unknown routes (`{ "message": "Not found." }`), the CORS **403** and the rate-limit **429**; `Strict-Transport-Security` is added only when `NODE_ENV=production`. A throttled client receives `429 { "message": "Too many requests. Please slow down." }`.

## 1. Endpoint details

### `GET /` and `GET /index.html`
- **Purpose:** serve the SPA shell with absolute-URL templating.
- **Parameters:** none.
- **Response:** `text/html`; every `__SITE_URL__` replaced by the configured origin (`SITE_URL`, else `http://localhost:<PORT>`).
- **Errors:** none specific.
- **Notes:** `index.html` is read from disk **once at boot**; editing it requires a server restart.

### `GET /*` (static)
- **Purpose:** serve `public/` only (`express.static`).
- **Not served (verified 404):** `/server.js`, `/package.json`, `/supabase-schema.sql`, `/test-search.js`, `/catalog-utils.js`, `/.env`, `/.freebuff/project-id` (dotfiles ignored by default).
- **Caching:** Express responds with `Cache-Control: public, max-age=0` and ETag/Last-Modified validators; the browser can revalidate, but there is no long-lived max-age or CDN configuration in this repository.

### `GET /robots.txt`
- **Response:** `text/plain` — allow all, `Sitemap: {SITE_URL}/sitemap.xml`.

### `GET /sitemap.xml`
- **Response:** `application/xml`; URLs: `/`, `/privacy.html`, `/terms.html`, `/contact.html`, `/dmca.html` with changefreq/priority.
- **Note:** legal pages publish **relative** canonical/OG URLs of their own, while the SPA uses absolute templated URLs.

### `GET /api/site-config`
- **Response:** `{ siteUrl, contactEmail, dmcaEmail, justWatchRegion }`; `Cache-Control: no-store`.
- **Guarantee:** never exposes Supabase settings (asserted by tests).

### `GET /api/config`
- **Response:** exactly `{ SUPABASE_URL, SUPABASE_ANON_KEY }`; `Cache-Control: no-store`.
- **Guarantee:** the service-role key is never returned.

### `DELETE /api/account`
- **Auth:** `Authorization: Bearer <supabase access token>`; malformed or missing → **401**. Token length capped at 8192.
- **Config required:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; otherwise **503** `{ message: 'Account deletion is not configured on this server.' }`.
- **Validation:** `SUPABASE_URL` must be HTTPS (or HTTP on `localhost`/`127.0.0.1`) with no credentials.
- **Flow:** verify token with `GET {supabase}/auth/v1/user` (10 s) → 401 on 401/403, 502 on other failures → validate UUID → `DELETE {supabase}/auth/v1/admin/users/{id}` (15 s) with the service-role key → **200** `{ message: 'Your account has been deleted.' }`; failure → 502.
- **Security:** the request body is ignored; the deleted user is always the token-verified user.
- **Cascades:** `profiles` and `watchlist` rows are removed by `ON DELETE CASCADE`.

### Catalog endpoints (shared behaviour)
`/api/trending`, `/api/popular`, `/api/movies`, `/api/series` and `/api/genre/:genre` are all served from live AniList queries merged with the curated catalog, and share one caching/fallback scheme:

- **Caching:** in-memory, 10-minute TTL, single-flight (concurrent requests share one upstream call). Genre results are cached per `genre|type` key, capped at 30 entries.
- **Fallback:** on AniList failure the last good cached list is served; with no cache the curated catalog answers. Each fallback logs whether it used `cached` or `curated` data.
- **Errors:** these endpoints never surface an error — they always return something.
- **Canonical ID:** every item carries `id === anilistId`. **Verified 2026-10-06** across all five endpoints.

### `GET /api/trending`
- **Response:** array of catalog items; AniList `Page(perPage: 20, sort: TRENDING_DESC, isAdult: false)` merged with curated entries that the live page did not cover.
- **Verified 2026-10-06:** 30 items (20 live + curated), 18 not in the curated catalog — i.e. genuinely computed from live AniList trending data (the old fixed local slice is gone).

### `GET /api/popular`
- **Response:** AniList `Page(perPage: 50, sort: POPULARITY_DESC, isAdult: false)` plus curated entries not present in that page. **Observed 51 items** (47 TV + 3 films + curated).
- **Fields per item:** `id`, `anilistId`, `title`, `genre[]`, `year`, `rating` (10-point), `episodes`, `type`, `studio`, `language`, `status`, `image`, `poster`, `banner`, `description`.
- **Note:** live AniList metadata is authoritative, so a curated title's displayed name is AniList's — e.g. curated "Jujutsu Kaisen" is returned as **"JUJUTSU KAISEN"**.

### `GET /api/movies`
- **Response:** AniList `format_in: [MOVIE]`, popularity-sorted, merged with curated entries — then re-filtered so the list contains films only.
- **Verified 2026-10-06:** 50 items, every one `format: MOVIE`. (The Movies page previously filtered the mixed `/api/popular` page and showed ~3 films.)

### `GET /api/series`
- **Response:** AniList `format_in: [TV, TV_SHORT]`, popularity-sorted, merged with curated entries, then re-filtered to television formats only.
- **Verified 2026-10-06:** 51 items, all `TV`, zero film titles.

### `GET /api/search?q=`
- **Parameters:** `q` — required, trimmed, 1–100 characters; otherwise **400** `{ message: 'Enter an anime name of 1 to 100 characters.' }`.
- **Response:** up to 10 AniList results (deduped, descriptions sanitised). On GraphQL errors or network failure: local matches mapped into the AniList shape.
- **Timeouts:** 15 s.
- **Caching:** ⚫ none server-side (the browser caches suggestions for 50 queries).

### `GET /api/genre/:genre`
- **Parameters:** `genre` — trimmed, 1–50 characters; otherwise **400**. Optional `?type=series|movies` restricts the result to that format group (any other value is ignored).
- **Response:** AniList genre query (popularity-sorted, 30 items), merged with curated entries, then re-filtered so every item really carries the requested genre (and the requested format, when `type` is given).
- **Curated-only genres:** a genre AniList does not define (e.g. `Shounen`, a demographic) is answered from the curated catalog instead of returning nothing.
- **Adult genres:** `Hentai` returns `[]` — the catalog is non-adult throughout.
- **Unknown genre:** `[]` with HTTP 200 (no 404).
- **Verified 2026-10-06:** `Comedy` → 30 items, all tagged Comedy (was **0** before Phase 1) · `Comedy?type=series` → TV only · `Comedy?type=movies` → films only · `Shounen` → 4 curated titles · `DefinitelyNotAGenre` → `[]` · `Hentai` → `[]`.

### `GET /api/detail/:id` 🟡 (retired)
- **Response:** **308 permanent redirect** to `/api/anime/:id` for a positive integer id; otherwise **404** `{ message: 'Anime not found.' }`.
- **Why:** the route used to serve the hand-assigned local id space, which collided with AniList IDs. **Verified 2026-10-06:** `/api/detail/1` → `308` `Location: /api/anime/1` → Cowboy Bebop, where it previously returned Jujutsu Kaisen.
- **Unused:** the frontend calls `/api/anime/:id` directly.

### `GET /api/genres` 🟡
- **Response:** alphabetically sorted union of AniList's `GenreCollection` (with adult genres removed) and genres present only in the curated catalog. **Observed 19 items** including `Comedy` and `Shounen`, excluding `Hentai`.
- **Used by:** the Popular page's genre multi-select (`loadCatalogGenreOptions()` in `public/script.js`) fetches this list on first visit, so the options are not derived client-side from `/api/popular`.

### `GET /api/catalog` — removed (Task 2A follow-up, 2026-10-08)
Superseded by `GET /api/browse`, which the Popular page had already switched to and which validates strictly (fixed enums, `page` 1–50, `perPage` ≤30, repeated params rejected). Nothing called this route — not the frontend, and no test after their migration — so the route, its `proxyLimiter` mount, its private cache and `parseCatalogFilters` were removed before any commit. The historical contract lives in git history and in the Feature 1–2 entries of `docs/CHANGELOG.md`.

### `GET /api/browse` (Task 2A, 2026-10-08)
- **Purpose:** the strict browse endpoint behind the Popular page's filter form and **Load more** button: fixed enum spellings, a tight year range, a small page window, and repeated parameters rejected outright.
- **Parameters** (all optional; each has an allowlist or a numeric range — the first violation answers **400** `{ message }`):
  - `genre` — comma-separated multi-select (max 10, each ≤50 chars, letters/digits/`'.-` charset), allowlisted against the live+curated genre list with adult genres excluded from that list, so `genre=Hentai` → **400** `Unknown genre: "Hentai".`
  - `year` — whole number **1960 … (current year + 1)**; otherwise **400**.
  - `season` — `WINTER | SPRING | SUMMER | FALL` (case-normalized); otherwise **400**.
  - `format` — `TV | MOVIE | OVA | ONA | SPECIAL` (case-normalized); otherwise **400**.
  - `status` — `RELEASING | FINISHED | NOT_YET_RELEASED` (case-normalized); otherwise **400**.
  - `minScore` — whole number **0–100**; otherwise **400**.
  - `sort` — `POPULARITY_DESC | SCORE_DESC | START_DATE_DESC | TITLE_ROMAJI` (default `POPULARITY_DESC`, case-normalized). The catalog's friendly keys (`score` …) are **not** accepted here; otherwise **400**.
  - `page` — whole number **1–50** (default 1); otherwise **400**. The SPA's `?page=popular` is an unknown *value* and answers **400** — the client builds its API query separately and never sends the route marker.
  - `perPage` — whole number **1–30** (default 30); otherwise **400**.
  - A parameter supplied more than once (`?year=2020&year=2021`) → **400** `year must not be provided more than once.` Unrelated parameter names are ignored.
- **Response / headers:** a plain list body; `X-Catalog-Source: anilist | curated`, `X-Catalog-Page` (AniList `pageInfo.currentPage`), `X-Catalog-Per-Page`, `X-Catalog-Total-Pages`, `X-Catalog-Has-Next` (AniList `pageInfo.hasNextPage`, or the curated fallback's local arithmetic), `X-Catalog-Total` when known. Adult content is excluded (`isAdult: false`) and every user value is bound as a GraphQL **variable**.
- **Rate limiting:** the AniList-proxy limit (`60;w=60`, same as `/api/search`) in addition to the global `/api` limit.
- **Caching:** **5-minute** in-memory TTL, **max 100 entries**, single-flight, keyed by a **normalized** `browseCacheKey` (genres lowercased + sorted, all filters, `page`, `perPage`) — `?genre=Comedy,Action&sort=POPULARITY_DESC` and `?genre=action,comedy&sort=popularity_desc` share one entry. Fallback chain: fresh cache → AniList → stale cache → curated catalog filtered and paged locally with the requested `perPage`; a fallback is never cached, so the next request retries AniList.
- **Frontend:** the Popular page fetches this route; filters are mirrored into the shareable URL (`?page=popular&genre=…&sort=SCORE_DESC`), the **Load more** button appends `page + 1` with client-side dedupe by `id`, and the Previous/Next control is gone. Legacy `sort=score`-style links still rehydrate; out-of-range URL values (e.g. `year=2100`, `format=TV_SHORT`) are dropped client-side before the request.
- **Verified 2026-10-08:** default → 30 items, `X-Catalog-Source: anilist`, `X-Catalog-Total: 5000` (AniList caps `pageInfo.total`), `RateLimit-Policy: 60;w=60` · `?page=2` → no overlap with page 1 · `?perPage=10` → 10 items · `?format=MOVIE` → films only · `?year=2024` → all 2024 · `?page=popular`, `?perPage=31`, `?page=51`, `?year=1959`, `?sort=score`, `?genre=Hentai`, `?year=2020&year=2021` → **400** · AniList outage → curated list with `X-Catalog-Source: curated`, `?page=2` → empty + `X-Catalog-Has-Next: false` · browser: Load more 30 → 60 cards with 0 duplicate ids.

### `GET /api/anime/:id`
- **Parameters:** `id` — positive decimal AniList `Int` (1–2,147,483,647); non-numeric or non-integer path values → **400**. IDs above 100,000 are accepted; the former arbitrary cap incorrectly rejected catalog titles such as AniList ID `206949`.
- **Response:** AniList Media with title, cover, banner, description (sanitised), episodes, status, score, genres, season/year, format, start date, duration, source, country, main studios, 6 staff edges, 6 characters with first Japanese voice actor, YouTube trailer (if any), relations, 6 recommendations.
- **Errors:** malformed/out-of-range ID → **400**; AniList GraphQL error → **500**; not found → **404**; upstream/network failure → **500** `{ message: 'Could not connect to AniList API.' }`.
- **Caching:** ⚫ none; called on every detail view and for cloud-watchlist hydration.

### Global error handler
Returns JSON `{ message }`:
- CORS rejection → **403** `This origin is not allowed.`
- `413` → `Request body is too large.` · `400` → `Invalid request.` · otherwise **500** `An internal server error occurred.`

## 2. Duplicate / conflicting endpoints — RESOLVED (Phase 1, 2026-10-06)

| Conflict | Resolution |
| --- | --- |
| `/api/detail/:id` vs `/api/anime/:id` (two ID spaces) | The local id space is gone: `ANIME_DB` entries carry `anilistId` only, every catalog item leaves with `id === anilistId`, and `/api/detail/:id` is a 308 redirect to `/api/anime/:id`. |
| `/api/genre/:genre` + `/api/genres` vs client-side filtering | `/api/genre/:genre` and `/api/genres` are live-backed from the same AniList source the client filters. Genre buttons on Home/Series use the endpoint. As of Phase 2 (2026-10-08) the Popular page's catalog form no longer filters client-side: it uses `GET /api/browse` (Task 2A), which validates every filter server-side, binds each value as a GraphQL variable and paginates from AniList `pageInfo`. |
| `/api/trending` vs `/api/popular` | `/api/trending` is now a real AniList `TRENDING_DESC` query, so the name matches the behaviour. |

## 3. Missing endpoints 🆕

Needed for features currently absent (see `docs/FEATURES.md`, `docs/WATCH_SYSTEM.md`) — **none exist today**:

- Episodes: list/numbering/air dates per title.
- Watch progress / continue watching (per user, per title, per episode).
- Watch history.
- Favorites.
- Admin/management endpoints.
- Health/readiness endpoint.

## 4. Cross-cutting gaps

- **Rate limiting is process-local:** counters reset on restart and are not shared across instances; configure `TRUST_PROXY` to match the actual production proxy topology.
- **No server-side caching** for `/api/search` and `/api/anime/:id` (the four catalog lists and genre queries are cached for 10 minutes; `/api/browse` for 5 minutes).
- **Fixed-size list endpoints** return 20–50 items; `/api/browse` pages 30 titles at a time (`page` 1–50, `perPage` ≤30), but no endpoint supports `offset`.
- **No API versioning** and no machine-readable schema (OpenAPI) — a candidate for a future `docs/` addition.
- **Request correlation is minimal:** every response carries an `X-Request-ID` and the shared error handler logs it, but there is no structured request logging — only ad-hoc `console.log`/`console.error`/`console.warn`.

## 5. Phase 0 route/frontend audit (2026-10-07)

> Added as part of Phase 0 items 1–5. Audited every `app.get/delete/use` in
> `server.js` against every `fetch()` in `public/script.js` and `public/auth-ui.js`.

### 5.1 Frontend fetch inventory

`baseURL = '/api'` (relative, `script.js` line 4).

| File | Line | Full URL called |
|------|------|-----------------|
| script.js | 21 | `GET /api/site-config` |
| script.js | 446 | `GET /api/trending` |
| script.js | 465 | `GET /api/popular` |
| script.js | 610 | `GET /api/search?q=<query>` |
| script.js | 702 | `GET /api/anime/<id>` |
| script.js | 1029 | `GET /api/genre/<genre>[?type=series\|movies]` |
| script.js | 1127 | `GET /api/movies` |
| script.js | 1152 | `GET /api/series` |
| script.js | 1374 | `GET /api/search/suggestions?q=<query>` |
| auth-ui.js | 67 | `GET /api/anime/<id>` (cloud watchlist hydration) |
| auth-ui.js | 246 | `GET /api/config` |
| auth-ui.js | 373 | `DELETE /api/account` |

### 5.2 Cross-reference: all frontend calls matched ✅

Every one of the 11 (12 including the duplicate `/api/anime/:id` in auth-ui.js)
frontend fetch calls has an exact matching Express route. **No mismatches.**

The previously reported browser error `"Cannot GET /api/anime/search"` referred
to a retired `POST /api/anime/search` removed in a prior phase. `test-search.js`
line 193–194 asserts it returns 404 — confirmed passing.

### 5.3 Routes not called by the frontend

| Route | Reason |
|-------|--------|
| `GET /api/health` | Internal health check — not needed by the browser |
| `GET /robots.txt`, `GET /sitemap.xml` | Crawlers only |
| `GET /api/detail/:id` | Retired; frontend calls `/api/anime/:id` directly |

All remaining API routes are called by the frontend or exercised by the tests.

### 5.4 Rate-limit prefix note

`app.use('/api/search', proxyLimiter)` is a **prefix** match — it covers both
`/api/search` and `/api/search/suggestions`, which is intentional: both involve
AniList quota. Express 5 route matching for `app.get(path, …)` is exact, so the
two search routes do not conflict.

### 5.5 localStorage ↔ Supabase interaction

Three storage keys, all correct:

| Key | Storage | Lifecycle |
|-----|---------|-----------|
| `anime_hub_watchlist` | localStorage | Guest watchlist array; removed after successful cloud migration |
| `anime_hub_watchlist_<userId>` | localStorage | Per-user display cache for cloud watchlist rows |
| `anime_hub_watchlist_migration_declined_<userId>` | **sessionStorage** | Per-tab migration decline flag; cleared when tab closes |

No stale `ah_watchlist` or `ah_continue` keys exist in the current code.

Guest → sign-in migration path: consent dialog → upsert missing rows → verify
by read-back → merge display cache → remove `anime_hub_watchlist`. On failure
local data is kept intact and a toast is shown. On decline the flag is set for
the session only.

Known design limitation: if a session expires silently the user may accumulate
items in `anime_hub_watchlist` again; these are merged (union) on the next
sign-in via the same dialog. No data loss.

RLS enforcement: `watchlist` and `profiles` tables both have `ENABLE ROW LEVEL
SECURITY` with `auth.uid() = user_id` policies. Account deletion is backend-only
(`DELETE /api/account`); the browser never holds the service-role key.

### 5.6 Detail page and Watch page

**Detail page** (`GET /api/anime/:id`): renders title, poster/banner, genres,
rating, format, episodes, status, season/year, studio, source, country, release
date, episode length, staff, characters + Japanese voice actors, related titles,
and recommendations. Trailer is an `<a>` link to
`https://www.youtube.com/watch?v=<id>` (no iframe/embed). "Find legal viewing
options" links to JustWatch. **Legally clean.**

NOT VERIFIED end-to-end in a browser. Manual steps: `npm start` → open
`http://localhost:3000` → click a card → confirm poster/banner/genres/rating
displayed → confirm trailer link and JustWatch link present → add to watchlist.

**Watch page: does not exist.** No `<iframe>`, `<video>`, `<embed>`, no
page-watch SPA view, no streaming endpoint anywhere in the current codebase.
The earlier continue-watching UI was deleted in the `public/` restructure (see
`docs/WATCH_SYSTEM.md §3`). Legal risk is zero for the current code.

### 5.7 gitignore status

```
git check-ignore -v .kiro/steering/product.md  →  exit 1, no output
```

`.kiro/` is **not** gitignored. Steering files are version-tracked.
