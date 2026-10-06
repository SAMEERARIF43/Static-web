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
| GET | `/api/search?q=` | Title search (10 results) | AniList → curated fallback | none | ⚫ ⚪ |
| GET | `/api/genre/:genre` | Genre filter (optional `?type=series\|movies`) | AniList genre query → curated fallback | none | 10-min in-memory (≤30 genres) |
| GET | `/api/detail/:id` | **Retired** — permanent redirect to `/api/anime/:id` | — | none | n/a | 🟡 |
| GET | `/api/genres` | Genre list (adult genres excluded) | AniList `GenreCollection` + curated | none | 10-min in-memory | 🟡 |
| GET | `/api/anime/:id` | Detail by **AniList** id (staff, characters, relations, recommendations, trailer) | AniList | none | ⚫ ⚪ |
| POST | `/api/anime/search` | **Retired** — returns 404 | — | — | — | — |

Global middleware: CORS allowlist (`CORS_ORIGINS`; foreign origins → **403**; in production the list is validated at boot — see `docs/ENVIRONMENT.md` §3), security headers including CSP, `express.json({ limit: '16kb' })`, rate limits, and a JSON error handler.

Rate limits are process-local fixed windows: `/api` allows 120 requests per minute per client IP, except `/api/site-config` and `/api/config`; `/api/search` and `/api/anime/:id` additionally allow 60 per minute; `/api/account` allows 5 per 15 minutes. Set `TRUST_PROXY` to the actual proxy hop count in production so the limiter sees client IPs; counters are not shared across server instances.

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
- **Unused:** the frontend derives the catalog page's genre options client-side from `/api/popular`.

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
| `/api/genre/:genre` + `/api/genres` vs client-side filtering | `/api/genre/:genre` and `/api/genres` are now live-backed from the same AniList source the client filters. Genre buttons on Home/Series use the endpoint; the Popular page still filters client-side over `/api/popular` (same live data). |
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
- **No server-side caching** for `/api/search` and `/api/anime/:id` (the four catalog lists and genre queries are cached for 10 minutes).
- **Every list endpoint is capped** at 20–50 items and there is no pagination or `offset` support.
- **No API versioning** and no machine-readable schema (OpenAPI) — a candidate for a future `docs/` addition.
- **No request logging**; only ad-hoc `console.log`/`console.error`/`console.warn`.
