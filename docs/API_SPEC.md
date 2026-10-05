# API_SPEC — HTTP API reference (current implementation)

> Snapshot: 2026-10-05. Documents `server.js` exactly as it behaves today.
> Legend: **CURRENT** — implemented and reachable in `server.js` today · **NOT IMPLEMENTED** — absent (§3) ·
> **PLANNED** — recorded in `docs/ROADMAP.md`, not built · **NOT FOUND / NEEDS CONFIRMATION** — cannot be determined from the repository.
> Endpoints are **not** fixed, renamed, or removed by this document.
> Flags: 🔴 **DUPLICATE / CONFLICTING** · 🟡 **UNUSED by the frontend** · ⚪ **NO RATE LIMIT** · ⚫ **NO CACHE** · 🆕 **NOT IMPLEMENTED**

## Summary table

| Method | Path | Purpose | Data source | Auth | Cache | Flags |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/` , `/index.html` | SPA shell with `__SITE_URL__` substituted | `public/index.html` read once at boot | none | none (no `Cache-Control`) | ⚪ |
| GET | `/*` | Static files from `public/` | filesystem | none | ETag/Last-Modified only (no `max-age`) | ⚪ |
| GET | `/robots.txt` | Crawler rules + sitemap URL | generated | none | none | ⚪ |
| GET | `/sitemap.xml` | 5-URL sitemap | generated | none | none | ⚪ |
| GET | `/api/site-config` | Public site settings | env | none | `no-store` | ⚪ |
| GET | `/api/config` | Public Supabase client config | env | none | `no-store` | ⚪ |
| DELETE | `/api/account` | Self-service account deletion | Supabase Auth + Admin API | Bearer token (Supabase) | n/a | ⚪ |
| GET | `/api/trending` | "Trending" list — fixed local slice | local `ANIME_DB` | none | ⚫ | ⚪ |
| GET | `/api/popular` | Merged popular catalog (≤51 items) | AniList + local | none | 10-min in-memory | — |
| GET | `/api/search?q=` | Title search (10 results) | AniList → local fallback | none | ⚫ | ⚪ |
| GET | `/api/genre/:genre` | Genre filter | local `ANIME_DB` only | none | ⚫ | 🔴 (see §2) ⚪ |
| GET | `/api/detail/:id` | Detail by **local** id | local `ANIME_DB` only | none | ⚫ | 🔴 🟡 ⚪ |
| GET | `/api/genres` | Genre list | local `ANIME_DB` only | none | ⚫ | 🔴 🟡 ⚪ |
| GET | `/api/anime/:id` | Detail by **AniList** id (staff, characters, relations, recommendations, trailer) | AniList | none | ⚫ | ⚪ |
| POST | `/api/anime/search` | **Retired** — returns 404 | — | — | — | — |

Global middleware: CORS allowlist (`CORS_ORIGINS`; foreign origins → **403**; in production the list is validated at boot — see `docs/ENVIRONMENT.md` §3), security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`), `express.json({ limit: '16kb' })`, and a JSON error handler.

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
- **Caching:** express defaults (ETag/Last-Modified); **no `max-age`** configured.

### `GET /robots.txt`
- **Response:** `text/plain` — allow all, `Sitemap: {SITE_URL}/sitemap.xml`.

### `GET /sitemap.xml`
- **Response:** `application/xml`; URLs: `/`, `/privacy.html`, `/terms.html`, `/contact.html`, `/dmca.html` with changefreq/priority.
- **Note:** legal pages publish **relative** canonical/OG URLs of their own, while the SPA uses absolute templated URLs.

### `GET /api/site-config`
- **Response:** `{ siteUrl, contactEmail, dmcaEmail }`; `Cache-Control: no-store`.
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

### `GET /api/trending` 🔴 (semantics)
- **Response:** `ANIME_DB.slice(0, 5)` — a **fixed five-item local list**, not computed from AniList popularity/trending.
- **Verified example:** Jujutsu Kaisen, Solo Leveling, One Piece, Demon Slayer, Attack on Titan.

### `GET /api/popular`
- **Response:** array of catalog items; merged from AniList `Page(perPage: 50, sort: POPULARITY_DESC, isAdult: false)` plus local entries not present in that page. **Observed 51 items** at audit time.
- **Fields per item:** `id`, `anilistId`, `title`, `genre[]`, `year`, `rating` (10-point), `episodes`, `type`, `studio`, `language`, `status`, `image`, `poster`, `banner`, `description`.
- **Caching:** in-memory, 10-minute TTL, single-flight; on AniList failure falls back to the stale cache, then the untouched local catalog.
- **Errors:** never surfaces an error to the client — always returns something.

### `GET /api/search?q=`
- **Parameters:** `q` — required, trimmed, 1–100 characters; otherwise **400** `{ message: 'Enter an anime name of 1 to 100 characters.' }`.
- **Response:** up to 10 AniList results (deduped, descriptions sanitised). On GraphQL errors or network failure: local matches mapped into the AniList shape.
- **Timeouts:** 15 s.
- **Caching:** ⚫ none server-side (the browser caches suggestions for 50 queries).

### `GET /api/genre/:genre` 🔴
- **Response:** local `ANIME_DB` entries whose genres include `:genre` (case-insensitive). Unknown genre → `[]` (no 404).
- **Verified examples:** `Action` → many, `Sci-Fi` → 1, **`Comedy` → 0** — though the live catalog contains comedies.
- **Conflict:** the Popular page filters genres client-side over live data; home/series/movie genre buttons hit this local-only endpoint. Same button, different data.

### `GET /api/detail/:id` 🔴 🟡
- **Response:** the local catalog object for local `id` (1–12); otherwise **404** `{ message: 'Anime not found.' }`.
- **Conflict:** `/api/anime/:id` uses AniList IDs. Verified: `/api/detail/1` → Jujutsu Kaisen (local id 1); `/api/anime/1` → Cowboy Bebop (AniList id 1).
- **Unused:** the frontend never calls this.

### `GET /api/genres` 🔴 🟡
- **Response:** sorted-by-insertion array of genres found in the local catalog. Observed: Action, Supernatural, Shounen, Adventure, Fantasy, Drama, Mystery, Psychological, Sci-Fi, Thriller.
- **Unused:** the frontend derives genres client-side from `/api/popular`.

### `GET /api/anime/:id`
- **Parameters:** `id` — integer AniList id; non-numeric → **400** `{ message: 'Invalid Anime ID.' }`.
- **Response:** AniList Media with title, cover, banner, description (sanitised), episodes, status, score, genres, season/year, format, start date, duration, source, country, main studios, 6 staff edges, 6 characters with first Japanese voice actor, YouTube trailer (if any), relations, 6 recommendations.
- **Errors:** AniList GraphQL error → **500**; not found → **404**; network failure → **500** `{ message: 'Could not connect to AniList API.' }`.
- **Caching:** ⚫ none; called on every detail view and for cloud-watchlist hydration.

### Global error handler
Returns JSON `{ message }`:
- CORS rejection → **403** `This origin is not allowed.`
- `413` → `Request body is too large.` · `400` → `Invalid request.` · otherwise **500** `An internal server error occurred.`

## 2. Duplicate / conflicting endpoints

| Conflict | Detail |
| --- | --- |
| `/api/detail/:id` vs `/api/anime/:id` | Same-looking route, two different ID spaces. Any consumer must know which catalog it is addressing. |
| `/api/genre/:genre` + `/api/genres` vs client-side filtering | Two implementations of genre filtering with different data sources and different results. |
| `/api/trending` vs `/api/popular` | "Trending" implies computed popularity; it is a static local slice. |

## 3. Missing endpoints 🆕

Needed for features currently absent (see `docs/FEATURES.md`, `docs/WATCH_SYSTEM.md`) — **none exist today**:

- Episodes: list/numbering/air dates per title.
- Watch progress / continue watching (per user, per title, per episode).
- Watch history.
- Favorites.
- Admin/management endpoints.
- Health/readiness endpoint.
- Rate limiting / abuse protection for the public AniList proxy.

## 4. Cross-cutting gaps

- **No rate limiting** anywhere.
- **No server-side caching** for `/api/search` and `/api/anime/:id` (only `/api/popular` is cached).
- **No API versioning** and no machine-readable schema (OpenAPI) — a candidate for a future `docs/` addition.
- **No request logging**; only ad-hoc `console.log`/`console.error`/`console.warn`.
