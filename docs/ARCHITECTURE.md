# ARCHITECTURE — current system design

> Snapshot: 2026-10-05. Describes the code as it exists. Problems are recorded, not fixed.
> Legend: **CURRENT** · **PLANNED** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. High-level diagram (CURRENT)

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Browser                                                              │
│  index.html (SPA shell) ─ script.js (UI, routing, catalog, SEO)      │
│                        └ auth-ui.js (Supabase auth + cloud watchlist) │
│                        └ legal.js (contact/DMCA email injection)      │
│  State: localStorage + sessionStorage + in-memory JS                 │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ same-origin fetch()           │ supabase-js (CDN, SRI)
                ▼                               ▼
┌───────────────────────────────┐   ┌──────────────────────────────────┐
│ Express server (server.js)    │   │ Supabase                         │
│  ├─ static host: public/      │   │  ├─ Auth (email/password)        │
│  ├─ SEO: /, robots, sitemap   │   │  └─ Postgres + PostgREST + RLS   │
│  ├─ config: /api/config,      │   │       profiles, watchlist        │
│  │   /api/site-config         │   └──────────────────────────────────┘
│  ├─ catalog proxy:            │                ▲
│  │   popular, trending,       │                │ Admin API (service-role)
│  │   movies, series, genre    │────────────────┘
│  ├─ retired: /api/detail/:id  │
│  │   → 308 /api/anime/:id     │
│  ├─ account deletion:         │
│  │   DELETE /api/account      │        ┌──────────────────────────┐
│  └─ in-memory cache (10 min)  │───────►│ AniList GraphQL API      │
└───────────────────────────────┘        │ (public, keyless)        │
                                         └──────────────────────────┘
```

## 2. Frontend ↔ backend relationship (CURRENT)

- The server exposes **one origin**: static assets from `public/`, a templated `index.html`, SEO files, and JSON APIs under `/api/*`.
- The frontend never renders server-side; `index.html` is a single document with 8 page sections toggled by `script.js` (`navigateToPage()`), plus client-side URL routing (`?page=`, `?q=`, `?id=`, `?catalogPage=`).
- All catalog traffic goes through the server — the browser never calls AniList directly.
- All user-data traffic (auth, watchlist rows) goes **browser → Supabase** using the public anon key; only account deletion is server-mediated.

## 3. Request/API flow (CURRENT)

| Flow | Path |
| --- | --- |
| Page load | Browser → `GET /` → templated `index.html` (every `__SITE_URL__` replaced with the configured origin at startup) → static assets from `public/` |
| Trending | Browser → `GET /api/trending` → cache hit (≤10 min) or AniList `TRENDING_DESC` → `catalog-utils` merge with curated overlay → cached in memory → JSON |
| Movies / TV Series | Browser → `GET /api/movies` or `GET /api/series` → AniList `format_in` query → merge → re-filter to the page's own format group → JSON |
| Genre filter | Browser → `GET /api/genre/:genre` (Series adds `?type=series`) → AniList genre query (or curated matches for a genre AniList does not define) → merge → re-filter → JSON |
| Popular | Browser → `GET /api/popular` → cache hit (≤10 min) or AniList top-50 → `catalog-utils` merge with local curation → cached in memory → JSON |
| Search | Browser → `GET /api/search?q=` → AniList (10 results) → dedupe + description sanitisation → JSON; on failure → local `search-utils` fallback mapped to the AniList shape |
| Detail | Browser → `GET /api/anime/:id` → AniList Media (staff, characters, relations, recommendations, trailer) → sanitised description → JSON |
| SEO | Browser fetches `/robots.txt`, `/sitemap.xml` (crawlers); `script.js` updates title/meta/canonical/JSON-LD per page |

## 4. Authentication flow (CURRENT)

1. `auth-ui.js` → `GET /api/config` → `{SUPABASE_URL, SUPABASE_ANON_KEY}` (public values only).
2. If both present → `supabase.createClient(...)` → `auth.getSession()` → `handleAuthState(session)`; `onAuthStateChange` keeps UI in sync.
3. Sign-up / sign-in / password reset run entirely in the browser against Supabase Auth; the modal reports success/error text.
4. Session tokens persist in the browser (supabase-js default storage).
5. If Supabase config is missing, auth initialises to a signed-out state; the modal reports "Supabase is not configured."

## 5. Watchlist flow (CURRENT)

- **Guest:** `localStorage['anime_hub_watchlist']` — an array of card objects; toggled by the card star and detail-page button.
- **Signed in:** Supabase `public.watchlist` rows `(user_id, anime_id)` guarded by RLS (`auth.uid() = user_id`); a per-user browser cache `anime_hub_watchlist_<userId>` stores display data.
- **Hydration:** cloud rows without cached display data are fetched via `/api/anime/:id`.
- **Migration:** on sign-in with a non-empty local watchlist, a `confirm()` asks to sync; missing rows are upserted, verified by read-back, the cache is merged, then the local key is removed. Declining is remembered for the session; failures keep local data.

## 6. Storage layers (CURRENT)

| Layer | Key / table | Contents | Scope |
| --- | --- | --- | --- |
| `localStorage` | `anime_hub_watchlist` | Guest watchlist (and migration source) | per browser |
| `localStorage` | `anime_hub_watchlist_<userId>` | Cloud-watchlist display cache | per browser + user |
| `sessionStorage` | `anime_hub_watchlist_migration_declined_<userId>` | "Do not ask again this session" | per browser session |
| Supabase | `public.profiles` | id, email, created_at | per user |
| Supabase | `public.watchlist` | id, user_id, anime_id, added_at | per user |
| Server memory | `popularCatalogCache` | merged popular catalog, 10-minute TTL, single-flight `pending` promise, stale fallback | process |

> Legacy key `anime_hub_continue_watching` may exist in some browsers from the deleted feature (commit `816af2e`). Nothing reads it; `test-search.js` only asserts it is never cleared.

## 7. Account deletion flow (CURRENT)

1. Profile → Danger Zone → confirm dialog → `DELETE /api/account` with `Authorization: Bearer <access_token>`.
2. Server validates the header shape, requires Supabase env vars, validates `SUPABASE_URL` (HTTPS, or HTTP on localhost), then verifies the token with `GET {supabase}/auth/v1/user` using the anon key.
3. Server validates the returned user id is a UUID and deletes **that** user via `DELETE {supabase}/auth/v1/admin/users/{id}` using the service-role key.
4. `profiles` and `watchlist` rows cascade. Client clears local keys, signs out locally, returns home.

## 8. Security boundaries (CURRENT)

- **Static root:** only `public/` is served; project source, `.env`, and `supabase-schema.sql` return 404 (verified).
- **CORS:** allowlist from `CORS_ORIGINS` (default `http://localhost:<PORT>` in development); unlisted origins get 403. In production every entry must be a public HTTPS origin and include `SITE_URL` (see `docs/ENVIRONMENT.md` §3).
- **Secrets:** anon key is public by design; service-role key is server-only and never returned by any endpoint (`/api/config` whitelists exactly two keys).
- **Untrusted data:** AniList descriptions are tag-stripped server-side; client escapes text into HTML (including quotes) and restricts image URLs to HTTPS.
- **Account deletion:** only the token-verified user can be deleted; the request body is ignored for targeting.

## 9. Architectural problems (CURRENT — recorded, not fixed)

1. ~~**Split catalog sources.**~~ **FIXED 2026-10-06 (Phase 1).** Every catalog list — trending, popular, movies, series, genre, genres — is now served from live AniList plus the curated overlay, and the endpoint used no longer changes the answer.
2. ~~**Duplicate ID spaces.**~~ **FIXED 2026-10-06 (Phase 1).** `ANIME_DB` no longer holds a local id; every catalog item leaves with `id === anilistId`, and `/api/detail/:id` is a 308 redirect to `/api/anime/:id`.
3. **Single-process server.** One Node process, in-memory cache only, no shared cache, no horizontal-scale story; restarting clears the catalog cache.
4. **No rate limiting** on any endpoint, including the public AniList-backed proxy.
5. **No API versioning** (`/api/*` unversioned) and no documented error schema beyond `{ message }`.
6. **Two data owners for watchlist display data** (browser cache + Supabase) that must be reconciled by the hydration/migration logic — correct today, but the most complex part of the app.
7. **No observability** — no structured logging, metrics, or health endpoint.

## 10. PLANNED (not built)

- Unify catalog sourcing and IDs before any watch-progress feature (see `docs/TASKS.md` Phase 1, `docs/ANIME_DATA.md` §ID spaces).
- Episode-aware data model and watch system (see `docs/WATCH_SYSTEM.md`).
- Rate limiting, caching for `/api/search` and `/api/anime/:id`, CSP (see `docs/TASKS.md` Phase 5).

## 11. NOT FOUND / NEEDS CONFIRMATION

- Production topology (host, proxy/CDN, TLS, process manager).
- Whether a second instance would ever run (would make the in-memory cache per-instance).
- Monitoring/logging platform.
