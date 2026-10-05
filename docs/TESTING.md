# TESTING — current test, lint and CI setup

> Snapshot: 2026-10-05. Documents the suite as it exists. **No tests were restored or rewritten in this pass.**
> Legend: **CURRENT** · **GAP** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Commands (CURRENT)

| Command | What it runs |
| --- | --- |
| `npm test` | `node test-search.js` (398 lines) — starts its own server, runs all assertions, exits non-zero on failure |
| `npm run lint` | `eslint .` with `.eslintrc.json` (`eslint:recommended`, `no-undef: error`, `no-unused-vars: warn`) |
| `npm start` | `node server.js` (development/manual use) |

- The test harness spawns `server.js` on `TEST_PORT` (default **3001**, or `process.env.TEST_PORT`) and waits for the string `Server: <baseURL>` on stdout before asserting, with a 10-second timeout.
- Environment for the spawned server: `PORT=TEST_PORT`, `SITE_URL=https://animehub.example`, `CORS_ORIGINS=http://localhost:<TEST_PORT>`, `SUPABASE_URL=https://example.invalid`, dummy Supabase keys.
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
| Account deletion | **Only** the unauthenticated case: `DELETE /api/account` without a token → 401 |
| Client source guards | `script.js` still reads `anime_hub_watchlist`; never removes `anime_hub_continue_watching`; search-filter `change`/`reset` listeners exist; search race guard present; canonical update present; quote escaping present |
| CORS | Foreign origin → 403 (**live assertion**); configured origin → 200 with matching `access-control-allow-origin` |
| `/api/trending` | 200; Jujutsu Kaisen carries `anilistId` 113415, studio `MAPPA`, language `Japanese` |
| `/api/popular` | 200; array; ≥ 12 entries; every entry has an integer `anilistId > 0`; no duplicate IDs |
| Merge/mapping unit tests | `mapAniListMediaToCatalogItem` (ID, year fallback, 10-point rating, status label, studio, language); `mergeAniListCatalog` dedupe/preserve; malformed entries skipped; live-AniList-wins for every authoritative field; local-only keys survive; local `id` stays stable; sparse-AniList fallback to local values; empty media list leaves the local catalog unchanged |
| Local search unit tests | `searchAnimeLocal` genre match; `mapLocalAnimeToAniList` shape (id, title, cover, genres, studio, country) |

## 3. Removed coverage (accurate record — 2026-10-05)

An edit on 2026-10-05 (file mtime 22:59) **removed the authenticated account-deletion assertions** from `test-search.js` (file went 446 → 398 lines). Removed:

- the in-process **mock Supabase auth server** that recorded requests,
- the positive authenticated deletion test (`DELETE /api/account` with `Bearer test-access-token` → 200),
- the assertion that **no** Supabase request happens for unauthenticated deletion,
- the assertions that the token is verified at `/auth/v1/user` with the anon key,
- the assertions that the Admin API call targets **the verified user's ID** (not a body-supplied `user_id`) and uses the service-role credentials,
- the assertion that the response does not leak the service-role marker.

Also changed: `SUPABASE_URL` for the spawned server is now the dummy `https://example.invalid`.

**Consequence (GAP):** the server's account-deletion verification path — its most sensitive server flow — is currently **untested**. `DELETE /api/account` behaviour is documented in `docs/API_SPEC.md`; restoring coverage is task P6 in `docs/TASKS.md`.

## 4. Untested endpoints and paths (GAP)

- `GET /api/anime/:id` (success, 400, 404, 500, network failure).
- `GET /api/detail/:id` (success and 404).
- `GET /api/genre/:genre` (including the empty-result case).
- `GET /api/genres`.
- Authenticated `DELETE /api/account` (see §3) and its 503/502 paths.
- `/api/search` **offline fallback path** and `/api/popular` AniList-failure fallback (only their pure functions are unit-tested).
- Global error middleware paths (400/413/500 payloads), unknown-route 404.
- Frontend behaviour end-to-end (no browser tests exist; UI was verified manually during the audit).

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
