# FEATURES — inventory of the current codebase

> Statuses: **IMPLEMENTED** · **PARTIAL** · **MISSING** · **PLANNED** · **NEEDS CONFIRMATION**.
> Snapshot: 2026-10-05. Every row was verified against code and, where marked, a live run of the app.

## Feature inventory

| Feature | Status | Current implementation | Relevant files | Dependencies |
| --- | --- | --- | --- | --- |
| Home | IMPLEMENTED | SPA page `#page-home`: hero, search, Top Searches, genre bar, Trending grid (5), Popular preview (5) | `public/index.html`, `public/script.js`, `public/style.css` | `/api/trending`, `/api/popular` |
| Trending | PARTIAL | `GET /api/trending` returns a fixed `ANIME_DB.slice(0, 5)` from the **local** catalog — not computed from AniList; no caching | `server.js`, `public/script.js` | local `ANIME_DB` |
| Popular | IMPLEMENTED | `GET /api/popular`: AniList top-50 (non-adult, popularity) merged with local curation; 10-min in-memory cache; falls back to cached/local data if AniList fails | `server.js`, `catalog-utils.js` | AniList GraphQL |
| Catalog filters & sorting | IMPLEMENTED | 7 filters (genre, year, min rating, studio, language, type) + 4 sorts (popularity, rating, year, title) applied client-side over the loaded catalog | `public/index.html`, `public/script.js` | `/api/popular` |
| Pagination | IMPLEMENTED | 24 titles/page, Previous/Next + "Page X of Y", URL state `?page=popular&catalogPage=n` | `public/script.js`, `public/index.html` | none |
| Movies | IMPLEMENTED (derived) | Client filters the loaded catalog for `type === MOVIE`; empty state when none. Live catalog held **3** movies at audit time | `public/script.js` | `/api/popular` |
| TV Series | PARTIAL | Page exists but `loadSeries()` renders the **entire catalog with no TV filter**, so movies appear; its genre buttons then switch to the 12-item local source | `public/script.js` | `/api/popular`, `/api/genre/:genre` |
| Search | IMPLEMENTED | `GET /api/search?q=`: AniList top-10 (SEARCH_MATCH) with local-DB fallback; validates 1–100 chars; results page with count, empty state, filter-empty state, error state with Retry | `server.js`, `search-utils.js`, `public/script.js` | AniList GraphQL |
| Search autocomplete | IMPLEMENTED | Debounced (280 ms) suggestions on hero + navbar inputs; ARIA combobox/listbox; keyboard navigation; 50-entry client cache; aborts in-flight requests | `public/script.js`, `public/index.html` | `/api/search` |
| Search filters | IMPLEMENTED | Genre, format, minimum rating, 4 sort modes; "Clear filters"; result counts | `public/script.js`, `public/index.html` | `/api/search` |
| Anime Details | IMPLEMENTED | `GET /api/anime/:id`: AniList Media incl. studios, staff (6), characters + JP voice actors (6), relations, recommendations (6), trailer, start date, duration, source; rich detail page + dynamic JSON-LD | `server.js`, `public/script.js` | AniList GraphQL |
| Watchlist (guest) | IMPLEMENTED | Browser-local array under `localStorage` key `anime_hub_watchlist`; card star toggles; watchlist page with empty state | `public/script.js` | none |
| Watchlist (signed-in / cloud) | IMPLEMENTED | Supabase `public.watchlist` rows `(user_id, anime_id)`; per-user local cache `anime_hub_watchlist_<userId>`; hydration of uncached entries via `/api/anime/:id`; upsert with `onConflict user_id,anime_id` | `public/auth-ui.js`, `supabase-schema.sql` | Supabase Auth + Postgres + RLS |
| Watchlist migration (guest → cloud) | IMPLEMENTED | On sign-in, if a local watchlist exists, a `confirm()` asks to sync; upsert of missing IDs, verification read-back, cache merge, then local key removal. Decline is remembered per session (`sessionStorage`); failure keeps local data and shows a toast | `public/auth-ui.js` | Supabase |
| Authentication | IMPLEMENTED | Email/password sign-up, sign-in, password-reset email, session persistence, logout; modal with focus trap, Escape/backdrop close; verification state shown on Profile | `public/auth-ui.js`, `public/index.html` | Supabase JS CDN 2.49.1 (SRI), `/api/config` |
| Profile | IMPLEMENTED | Email, email-verified status, Danger Zone account deletion with confirmation and server verification | `public/index.html`, `public/auth-ui.js` | Supabase, `DELETE /api/account` |
| Account deletion | IMPLEMENTED | `DELETE /api/account`: bearer token verified against Supabase Auth, then the **verified** user is deleted through the Admin API with the service-role key; profile + watchlist removed by `ON DELETE CASCADE`. 503 when unconfigured | `server.js`, `supabase-schema.sql`, `public/auth-ui.js` | Supabase service-role key (server only) |
| Favorites | **MISSING** | No table, endpoint, storage key, or UI | — | — |
| Watch History | **MISSING** | No table, endpoint, storage key, or UI | — | — |
| Watch Progress | **MISSING** | No progress/resume model anywhere | — | — |
| Continue Watching | **MISSING** | Not present in the current app. Implemented once in commit `816af2e` inside the since-deleted root `script.js`/`index.html`; only a test assertion keeps the legacy key from being cleared | `test-search.js` (guard only) | — |
| Episode-level tracking | **MISSING** | `episodes` is a total count only | — | — |
| Admin | **MISSING** | No roles, routes, UI, or tables. "admin" in `server.js` refers to the Supabase Admin API used for self-deletion | — | — |
| SEO | IMPLEMENTED | Per-page title/description/OG/Twitter/canonical via `updatePageSeo()`; dynamic JSON-LD for detail pages; `robots.txt`; `sitemap.xml`; absolute URLs via `SITE_URL` templating | `public/script.js`, `public/index.html`, `server.js` | `SITE_URL` |
| Legal pages | IMPLEMENTED | Privacy, Terms, Contact, Copyright/DMCA with shared styling and configuration-driven email injection | `public/*.html`, `public/legal.css`, `public/legal.js` | `/api/site-config` |
| Footer / compliance messaging | IMPLEMENTED | Non-hosting statement + legal-link navigation on the SPA and legal pages | `public/index.html`, `public/*.html` | none |
| Toast notifications | IMPLEMENTED | Single toast element; messages inserted as text nodes (never HTML) | `public/script.js`, `public/style.css` | none |
| Responsive layout | IMPLEMENTED | Breakpoints at 1024 px, 768 px, 480 px; `prefers-reduced-motion` honoured; mobile nav drawer | `public/style.css`, `public/script.js` | none |
| Loading skeletons | IMPLEMENTED | Skeleton grids for trending, popular, movies, series, search, watchlist | `public/script.js`, `public/style.css` | none |
| Empty states | IMPLEMENTED | Watchlist empty, Movies empty, Search no-results, Search filter-empty, Detail error | `public/index.html`, `public/script.js` | none |
| Security controls | IMPLEMENTED | CORS allowlist (403 on foreign origin), `nosniff`/`DENY`/`Referrer-Policy`/`Permissions-Policy` headers, static root protection, server-side description sanitisation, HTTPS-only image URLs client-side, SRI on the CDN script | `server.js`, `public/script.js`, `public/index.html` | — |
| Rate limiting | **MISSING** | No middleware on any endpoint, including the public AniList proxy | — | — |
| CSP | **MISSING** | No `Content-Security-Policy` header; inline `onerror=` attributes are generated in card HTML | `server.js`, `public/script.js` | — |
| Analytics / ads | **MISSING (by design)** | Explicitly documented as not included | README, `public/privacy.html` | — |
| Tests | PARTIAL | `npm test` → `test-search.js`: API smoke + SEO + legal + CORS + merge-policy unit tests. Several endpoints untested; authenticated deletion assertions were removed on 2026-10-05 | `test-search.js` | live AniList for search/popular |
| Lint | IMPLEMENTED | `npm run lint` → ESLint (`eslint:recommended`, `no-undef: error`) — passes | `.eslintrc.json`, `package.json` | eslint 8 |
| CI | PARTIAL | GitHub Actions: `npm ci`, lint, test on Node 18/20 — but only on `main`/`master`, so the working branch gets no signal | `.github/workflows/ci.yml` | — |
| Documentation | PARTIAL (previously MISSING) | This `docs/` set + a README correction. Before this pass the only doc was README | `docs/*`, `README.md` | — |

## Notes

- "IMPLEMENTED" means present and verified in code; for live endpoints it was also exercised against the running app during the audit.
- Favorites, Watch History, Watch Progress, Continue Watching, episode tracking, and Admin are **not** built. Nothing in the UI claims they are.
- `PLANNED` is used only where `docs/ROADMAP.md` records an explicit, not-yet-approved direction.
