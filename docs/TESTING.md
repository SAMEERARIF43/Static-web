# TESTING — current test, lint and CI setup

> Snapshot: 2026-10-07 (Phase 2). Documents the suites as they exist. `test-security.js` was added on 2026-10-07; `test-search.js` was last extended in Phase 1.
> Legend: **CURRENT** · **GAP** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Commands (CURRENT)

| Command | What it runs |
| --- | --- |
| `npm test` | `node test-search.js` (search/catalog/SEO/legal/CORS + account-deletion success) **then** `node test-security.js` (Phase 2: headers/CSP, rate limits, AniList-outage fallback, account-deletion failure codes) — each starts its own server, runs its assertions and exits non-zero on failure |
| `npm run lint` | `eslint .` with `.eslintrc.json` (`eslint:recommended`, `no-undef: error`, `no-unused-vars: warn`) |
| `npm start` | `node server.js` (development/manual use) |

- The test harness spawns `server.js` on `TEST_PORT` (default **3001**, or `process.env.TEST_PORT`) and waits for `AnimeHub server listening on port <PORT>.` on stdout before asserting, with a 10-second timeout. `test-security.js` runs its scenarios on ports 3011-3014, one server each, so an exhausted rate-limit window cannot leak between scenarios.
- Environment for the spawned server: `PORT=TEST_PORT`, `SITE_URL=https://animehub.example`, `CORS_ORIGINS=http://localhost:<TEST_PORT>`, and Supabase keys pointing at the in-process **mock Supabase auth server** created in `run()`. `test-security.js` additionally points `ANILIST_GRAPHQL_URL` or `SUPABASE_URL` at a closed local port so failures happen immediately instead of waiting for a real timeout.
- The harness kills the server in a `finally` block; failures set `process.exitCode = 1`.

## 2. Coverage — what is asserted today (CURRENT)

| Area | Assertions |
| --- | --- |
| Search API | `One Piece` and `Naruto` return 200 with at least one title-matching result (uses the **live AniList API**) |
| Search validation | Empty query → 400 with the exact message; 101-character query → 400 |
| Retired route | `POST /api/anime/search` → 404 |
| Robots / sitemap | 200; robots points at the sitemap; sitemap includes privacy and DMCA URLs |
| Legal pages | All four return 200 and include title, meta description, Open Graph title, Twitter card, JSON-LD, and the non-hosting/discovery statement |
| Home page / SEO | 200; title; `og:site_name`; **absolute canonical** `https://animehub.example/`; absolute `og:image` and `twitter:image`; no leftover `__SITE_URL__`; JSON-LD present; no "4K Ultra HD" claim; no `data-nav="account"`/`page-account` |
| Static protection | `/server.js` → 404 |
| Security header | `X-Content-Type-Options: nosniff` on `/` |
| `/api/site-config` | 200; `siteUrl` = configured origin; does **not** expose Supabase settings |
| `/api/config` | 200; key set is exactly `['SUPABASE_ANON_KEY', 'SUPABASE_URL']`; `Cache-Control: no-store` |
| Account deletion | Unauthenticated `DELETE /api/account` → 401 **and** (restored 2026-10-05) authenticated deletion → 200 with token verification at `/auth/v1/user`, the Admin API targeted at the verified user (not a body-supplied `user_id`), service-role header checks and a no-leak assertion |
| Client source guards | `script.js` still reads `anime_hub_watchlist`; never removes `anime_hub_continue_watching`; search-filter `change`/`reset` listeners exist; search race guard present; canonical update present; quote escaping present |
| CORS | Foreign origin → 403 (**live assertion**); configured origin → 200 with matching `access-control-allow-origin` |
| `/api/trending` | 200; ≥ 5 entries; every entry has `id === anilistId`; no duplicate IDs; **at least one entry outside the curated ID set** — proves the list is live rather than the old fixed local slice |
| `/api/popular` | 200; array; ≥ 12 entries; every entry has an integer `anilistId > 0` **and** `id === anilistId`; no duplicate IDs; the curated Jujutsu Kaisen entry (113415) keeps studio `MAPPA` and language `Japanese` |
| `/api/movies` | 200; > 0 entries; every entry is `MOVIE`; canonical IDs |
| `/api/series` | 200; > 0 entries; every entry is `TV`/`TV_SHORT` (no films) |
| `/api/genre/:genre` | 200; `Comedy` is non-empty and every result actually carries `Comedy`; canonical IDs; `?type=series` returns television only; curated-only `Shounen` still returns titles; unknown genre → `[]`; `Hentai` → `[]` |
| `/api/genres` | 200; non-empty; includes live `Comedy`; excludes `Hentai` |
| `/api/detail/:id` (retired) | `308` with `Location: /api/anime/1`; a malformed id still returns 404 |
| `/api/anime/:id` | 200 for ID 1 with `id === 1` and title Cowboy Bebop — the direct regression test for the retired local id space |
| Merge/mapping unit tests | `mapAniListMediaToCatalogItem` (ID, year fallback, 10-point rating, status label, studio, language); `mergeAniListCatalog` dedupe/preserve; malformed entries skipped; live-AniList-wins for every authoritative field; local-only keys survive; **the AniList ID replaces any local key** (`withCanonicalId`, matched and unmatched); sparse-AniList fallback to local values; empty media list leaves curated content intact, keyed by AniList ID |
| Local search unit tests | `searchAnimeLocal` genre match; `mapLocalAnimeToAniList` shape (id, title, cover, genres, studio, country) |
| Security headers / CSP (`test-security.js`) | 200, 404, CORS 403, 429 and 502 responses all carry `nosniff`, `DENY`, `Referrer-Policy`, `Permissions-Policy`, a CSP and a UUID `X-Request-ID`; HSTS is **absent** outside production; `script-src` is `self` plus the pinned jsdelivr CDN with no `unsafe-inline`; `connect-src` includes the configured **HTTPS** Supabase origin and **excludes** a cleartext one |
| Exposure guards (`test-security.js`) | `/server.js`, `/.freebuff/project-id`, `/.env`, `/%2e%2e/server.js` and `/../server.js` are never served with 200 and never echo repository content |
| AniList outage (`test-security.js`) | `/api/anime/113415` returns 200 with `X-Catalog-Source: curated` and a canonical ID; an unknown id returns **500** with no fabricated entry and no connection detail in the body; `/api/anime/abc`, `/0` and `/2147483648` return 400; `/api/trending` and `/api/search` degrade to curated data with `id === anilistId`; `q=Re%3AZero` is still 200 while `q=abc%00def` and `q=` are 400 |
| Rate limits (`test-security.js`) | `RateLimit-Policy` is `120;w=60` on `/api`, `60;w=60` on `/api/search` and `5;w=900` on `/api/account`, and absent on `/api/site-config`; exhausting the global allowance returns **429** with the security headers and a neutral message, and the client stays limited for the window |
| Account deletion failures (`test-security.js`) | 401 (no header, `Bearer` with no token, upstream 401) with **no upstream contact** when unauthenticated or malformed; **502** (unreachable Supabase, upstream 500, invalid user identity, Admin API failure); **503** (a server booted without Supabase credentials); **504** (a mock Supabase that never answers, exercising the 10-second verification timeout); 200 success with the IDOR guard; and the 5-per-15-min **429**. No body leaks the service-role key |

## 3. Account-deletion coverage — removed, then restored (2026-10-05)

**Historical record.** An edit on 2026-10-05 (file mtime 22:59) removed the authenticated account-deletion assertions from `test-search.js` (446 → 398 lines): the in-process mock Supabase auth server, the positive authenticated deletion test, the "no Supabase request when unauthenticated" assertion, the token-verification assertions at `/auth/v1/user`, the assertions that the Admin API targets **the verified user's ID** (not a body-supplied `user_id`) with the service-role credentials, and the no-leak assertion. For a period `SUPABASE_URL` pointed at the dummy `https://example.invalid`.

**Current state — restored 2026-10-05** (decision recorded in `docs/PRD.md` §7; task P6.1 marked done). All of the above are back:

- the mock Supabase auth server is created in `run()` and closed in the `finally` block;
- the spawned server's `SUPABASE_URL` points at that mock;
- unauthenticated `DELETE /api/account` → **401** with `authRequests.length === 0` (no Supabase contact);
- authenticated deletion (`Bearer test-access-token`, body carrying a *different* `user_id`) → **200** with exactly two upstream calls;
- call 1 = `GET /auth/v1/user` with the anon key and the caller's token;
- call 2 = `DELETE /auth/v1/admin/users/<verifiedUserId>` with the service-role credentials — the **IDOR guard**;
- the response body does not leak the service-role marker.

**Verification of the restoration:** `npm test` passes (exit 0), and an instrumented run (assertion wrapper loaded with `--require`) recorded **8 account-deletion-related assertions executing**, including the Admin-API-target check; the success message showed `auth requests: 2`. At that point `test-search.js` was back to **446 lines** with CRLF endings preserved (it grew on 2026-10-06 with the Phase 1 catalog assertions, §2; the Phase 2 assertions live in the separate `test-security.js`).

## 4. Untested endpoints and paths (GAP)

- DONE `GET /api/anime/:id` — success for ID 1 plus **400** (non-numeric, `0`, above the AniList range), the AniList-outage fallback and the unknown-ID **500** are all covered by `test-security.js` (2026-10-07).
- `GET /api/detail/:id` (redirect + malformed id), `GET /api/genre/:genre` (incl. `?type=`, curated-only, unknown and adult genres) and `GET /api/genres` were added in Phase 1 (2026-10-06).
- DONE The **curated** half of the catalog fallback is now exercised: `test-security.js` points `ANILIST_GRAPHQL_URL` at a closed port and asserts the curated answer for `/api/trending` and `/api/search`. The stale-cache half (AniList failing after a successful load) is still only unit-tested.
- DONE `DELETE /api/account` failure paths — **503** (server booted without Supabase credentials), **504** (a mock Supabase that never answers, exercising the 10-second verification timeout), **502** (unreachable Supabase, upstream 500, invalid identity, Admin API failure), **401** (missing/malformed/expired session) and the account **429** are all covered by `test-security.js`. The only branch still unexercised is the 15-second **Admin API** timeout (the same code path as the tested verification timeout).
- DONE `/api/search` **offline fallback path** is covered (curated fallback, validation, punctuation). The `/api/popular` AniList-failure fallback is still only unit-tested.
- Unknown-route **404 JSON** is covered; the error middleware 413 payload and the `/api/search/suggestions` 502 path remain untested.
- Frontend behaviour end-to-end: still no automated browser tests. The CSP surface was verified manually on 2026-10-07 — Home, a detail page and search rendered from live data with an **empty console** and no CSP violations, and the pinned Supabase UMD build loaded from `cdn.jsdelivr.net`.

## 5. Brittleness and dependencies (CURRENT)

| Issue | Detail |
| --- | --- |
| **Live AniList dependency** | Search assertions and `/api/popular` expectations call the real AniList API; network outages or AniList changes make `npm test` flaky or failing. No mocks/fixtures for these paths |
| **Source string matching** | Several client tests assert substrings of `script.js` (e.g. exact listener text, `link[rel="canonical"]`). Harmless refactors break tests even when behaviour is correct |
| **No unit-test runner** | Tests are a single imperative script using `node:assert`; no test framework, no per-test isolation, no coverage report |
| **Implicit ordering** | Assertions run sequentially against one shared server instance; a single failure aborts the rest |
| **Port sensitivity** | A locally running server on the test port collides with the harness (mitigated by `TEST_PORT`) |

## 6. CI (CURRENT)

`.github/workflows/ci.yml`:

- Triggers: `push` and `pull_request` to **`main`/`master` only**.
- Matrix: Node **18.x** and **20.x**; `npm ci` → `npm run lint` → `npm test`.
- Because the working branch is `agents/anime-movie-website-audit-and-build`, CI does **not** run for current work until merged/PR'd.
- CI inherits the live-AniList dependency, so a network-restricted runner can fail on upstream issues.

## 7. NOT IMPLEMENTED

- Frontend/E2E tests (Playwright/Cypress/etc.).
- Test coverage measurement.
- Fixture/mocked AniList server for deterministic tests.
- Contract/schema tests for API responses.
- Performance tests.
- Accessibility automated checks.

## 8. NOT FOUND / NEEDS CONFIRMATION

- Required Node version for the suite (no `engines`).
- Whether CI should be extended to the active branch(es).
- Whether a test framework is acceptable to introduce (currently zero test dependencies).
