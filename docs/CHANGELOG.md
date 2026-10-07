# CHANGELOG

> Documentation status legend used across `docs/`:
> **CURRENT** — exists and works in the codebase today · **PLANNED** — agreed to be built, not built ·
> **NOT IMPLEMENTED** — absent from the codebase · **NOT FOUND / NEEDS CONFIRMATION** — cannot be determined from the repository.
>
> Snapshot: 2026-10-06, branch `agents/anime-movie-website-audit-and-build`.
> This changelog reconstructs known history from git. It is not a release changelog; no version tags exist.

## 2026-10-07 — Phase 2: rate limiting, CSP and failure-path coverage

Phase 2 (security + production readiness) is complete. Rate limiting, the CSP/HSTS headers, the `TRUST_PROXY` client-IP control, the AniList endpoint override and the curated detail fallback had already been built and verified; this pass closed the remaining gaps and locked the behaviour down with tests.

- **Security headers now cover error responses (`server.js`):** the header middleware was moved ahead of the CORS middleware, so CORS **403** replies, rate-limit **429**s and error-handler **5xx** responses carry the full set. Verified by HTTP: a foreign-origin request to `/api/site-config` now returns 403 **with** CSP and `X-Request-ID`.
- **Unknown routes return JSON, not Express’s HTML 404 (`server.js`):** the default page replaced the application policy with Express’s own `Content-Security-Policy: default-src 'none'`; a final `app.use` now answers `404 { "message": "Not found." }` with the application headers intact.
- **Search input validation is real (`server.js`):** `/api/search?q=` previously carried a dead `if (query.length < 1)` branch after the empty check; it now rejects C0/DEL control characters (`codePoint < 0x20 || 0x7F`) while leaving punctuation, accents and CJK untouched. GraphQL variables stay parameterized.
- **Live vs fallback detail responses are labelled (`server.js`):** `/api/anime/:id` returns `X-Catalog-Source: anilist` for live data and `X-Catalog-Source: curated` when a curated entry answers during an AniList outage, without changing the JSON shape.
- **Request IDs are usable in logs (`server.js`):** `crypto` is hoisted, and the shared error handler logs `Request failed (<status>) [<request-id>]: <message>` so a response id can be correlated with a server log line.
- **New suite `test-security.js` (Phase 2, ~460 lines):** security headers and CSP on 200/404/403/429/502 responses, HSTS absent outside production, `script-src` without `unsafe-inline`, `connect-src` scoped to the configured Supabase origin (and *not* to a cleartext origin), dotfile/traversal exposure, the AniList-outage fallback contract (`/api/anime/:id` curated 200 + header, unknown id still 500, non-numeric 400), catalog + search degradation, the three rate-limit scopes and their 429 payloads, and every `DELETE /api/account` outcome (**503** unconfigured, **504** timeout, **502** unreachable/upstream-failure/invalid-identity/admin-failure, 401 unauthenticated/malformed/expired, 200 success with the IDOR guard). `npm test` now runs both suites.
- **Verification:** `npm test` (both suites) and `npm run lint` pass. A browser check on a local production-shaped instance rendered Home, a detail page and search with **no console errors and no CSP violations**, loaded the pinned Supabase UMD build from `cdn.jsdelivr.net` (`window.supabase` present) and its AniList artwork. A `NODE_ENV=production` boot serves `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
- **Not done by design:** `.env.example` → `.gitignore`, production `.env` values, CSRF tokens, JustWatch region changes and Node version pinning were out of scope for this pass.

## 2026-10-06 — Phase 1: one canonical AniList ID and a live catalog

Owner greenlit Phase 1 and resolved the three open Phase-4 sub-decisions: favourites = one `watchlist` table with a `kind` column; episodes = numbered `(anime_id, episode_number)` records first; history = derived from progress rows.

- **Canonical ID (`catalog-utils.js`, `server.js`):** the hand-assigned `id: 1–12` field was deleted from `ANIME_DB`; the new `withCanonicalId` sets `id` from `anilistId`, and the merge policy guarantees `id === anilistId` for matched, curated-only and AniList entries alike. `getAnimeById` (the local-id lookup) was removed with its last caller.
- **`/api/detail/:id` retired:** now **308** → `/api/anime/:id` for a positive integer id, still **404** otherwise. Verified: `/api/detail/1` → Cowboy Bebop (previously Jujutsu Kaisen).
- **Live catalog (`server.js`):** one `buildCatalogQuery` + `fetchLiveCatalog` + `createCatalogLoader` path (10-minute in-memory cache, single-flight, stale-then-curated fallback) now backs `/api/trending` (`TRENDING_DESC`, 20), `/api/popular` (50), and the new `/api/movies` (`format_in: [MOVIE]`, 50) and `/api/series` (`format_in: [TV, TV_SHORT]`, 50). Filtered lists re-apply their filter after the curated merge, so a films list cannot carry a series.
- **Genre filtering is live (`/api/genre/:genre`, `/api/genres`):** live AniList genre query (30 items, the genre passed as a GraphQL variable), optional `?type=series|movies`, curated matches for genres AniList does not define (e.g. `Shounen`), adult genres excluded, per-genre bounded cache. Verified: `Comedy` → 30 (was **0**).
- **Frontend (`public/script.js`):** Movies/Series load from the new endpoints with a client-side format guard; genre clicks pass the page's type so the TV Series page cannot show films; `All` restores each page's own catalog (Home restores Trending).
- **Tests (`test-search.js`, 563 lines):** the Trending assertions were retargeted away from the retired local-slice contract (the curated-entry checks now run against `/api/popular`, located by `anilistId`), and coverage was added for the canonical-ID contract, the retired route, movies/series format purity, genre filtering (incl. `?type=`, curated-only, unknown and adult genres) and the genre list. `npm test` and `npm run lint` pass, and a browser check confirmed 50 film-only cards on Movies, 51 film-free cards on Series, 30 Comedy cards on Home, and detail navigation to `?id=21`.

## 2026-10-05 — documentation baseline, recorded decisions, restored test coverage

- Created the `docs/` baseline (18 documents) and corrected the README's `.env`/dotenv contradiction.
- Recorded 12 product/architecture decisions with the owner (see `docs/PRD.md` §7): AniList ID canonical; Favorites, Watch History, Continue Watching and Episode-level progress approved; Admin deferred; hybrid catalog; Node 24.x LTS; persistent Node hosting; separate dev/production environments; Supabase environment to be verified.
- Restored the authenticated account-deletion assertions in `test-search.js` (mock Supabase auth server, token verification, Admin API target = verified user, service-role header checks, no-contact-when-unauthenticated). File is 446 lines; `npm test` passes and an instrumented run confirms 8 deletion-related assertions execute.
- **No application code, database schema, or API behaviour was changed in this step.**

## Known history (from git log)

| Date | Commit | Change |
| --- | --- | --- |
| 2026-08-31 | `1e47897`, `b8c2448`, `6ac9782`, `358eebf`, `6e09d44` | Early scaffold uploads, formatting/syntax fixes, `data.js` edits (early learning commits). |
| 2026-08-31 | `bc463f2` | Deleted `anime.jpeg`. |
| 2026-08-31 → 2026-09-12 | `d4b039a`, `e3c5de1`, `b73f928`, `52c92bc`, `206561c` | README updates (project description, spelling, formatting). |
| 2026-10-03 | `bddbdf5` | Added Anime Hub frontend and AniList backend (the Express server + SPA foundation). |
| 2026-10-03 | `b306fff` | Added dynamic anime details page (AniList detail endpoint and detail UI). |
| 2026-10-03 | `420a4e8` | Improved homepage UI and fixed anime images. |
| 2026-10-03 | `816af2e` | **"Add continue watching feature"** — implemented in the *then-current root* `index.html`, `script.js`, `style.css` (441 inserted lines). **That code no longer exists**: the root duplicates were deleted during the `public/` restructure. No continue-watching UI or logic exists in the current `public/` implementation. Historical record only. |
| 2026-10-04 | `dc15de9`, `fdade94` | Agent-host checkpoint commits (repository reorganization to `public/`, removal of root duplicate files, test/debug script cleanup). |
| 2026-10-05 | `8158752` | "Complete Anime Hub audit and security fixes": removed dead `public/data.js`, `debug-api.js`, `debug-test.js`, `test-api.js`, `test-route.js`, `test-schema.js`, `quick-test.js`, `run-test.js`, root duplicates (`index.html`, `script.js`, root `websites picture.png`), added security-header middleware, CORS allowlist behaviour, static-root protection, SEO/canonical corrections, social preview image, favicon, merge-policy rewrite in `catalog-utils.js`, expanded `test-search.js`. |
| 2026-10-05 | `979e893` | "Harden Supabase schema and RLS policies": `watchlist` and `profiles` tables, RLS enablement, own-row policies, `handle_new_user()` signup trigger, account-deletion documentation in SQL comments. |
| 2026-10-05 | `50e9d1f` | Agent-host checkpoint commit. |

## Working tree state at this snapshot

Ten files are modified but **not committed** (concurrent work by more than one editor):

```
.env.example, catalog-utils.js, package-lock.json, package.json,
public/auth-ui.js, public/index.html, public/script.js, public/style.css,
server.js, test-search.js
```

Notable uncommitted changes observed:

- `SITE_URL` templating (`__SITE_URL__`) for absolute canonical/Open Graph URLs; `/api/site-config` now returns `siteUrl`.
- Hardened production startup guards in `server.js`: `SITE_URL` must be `https:` and non-localhost; `CORS_ORIGINS` must be explicitly configured and contain only valid public HTTPS origins, including `SITE_URL`.
- `dotenv` dependency added and `require('dotenv').config()` in `server.js` (this contradicts the current README — see README correction in this documentation pass).
- Supabase CDN script pinned to `@supabase/supabase-js@2.49.1` with a Subresource Integrity hash (verified correct during the audit).
- Search response race guard (`searchRequestId`), quoted-attribute escaping in `escapeHtml`, safe local-watchlist parsing, canonical updates in `updatePageSeo`.
- `test-search.js`: **the authenticated account-deletion assertions were removed** (the mock Supabase auth server and the checks on `/auth/v1/user` + Admin API targeting). Only the unauthenticated `401` case remains, and `SUPABASE_URL` is now a dummy `https://example.invalid`. See `docs/TESTING.md`.

## NOT FOUND / NEEDS CONFIRMATION

- No version numbers, tags, or release process exist.
- Commit scope for the three `Agent Host changes…` commits is machine-generated and not documented.

## PLANNED

- A real release changelog (semantic versions + dated entries) once the project has a release process.
