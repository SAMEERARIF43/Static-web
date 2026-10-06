# TESTING — current test, lint and CI setup

> Snapshot: 2026-10-05. Documents the suite as it exists. **No tests were restored or rewritten in this pass.**
> Legend: **CURRENT** · **GAP** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Commands (CURRENT)

| Command | What it runs |
| --- | --- |
| `npm test` | `node test-search.js` (563 lines) — starts its own server, runs all assertions, exits non-zero on failure |
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

**Verification of the restoration:** `npm test` passes (exit 0), and an instrumented run (assertion wrapper loaded with `--require`) recorded **8 account-deletion-related assertions executing**, including the Admin-API-target check; the success message showed `auth requests: 2`. At that point `test-search.js` was back to **446 lines** with CRLF endings preserved (it grew to **563 lines** when the Phase 1 catalog assertions were added on 2026-10-06, §2).

## 4. Untested endpoints and paths (GAP)

- `GET /api/anime/:id` — success for ID 1 is now covered; **400, 404, 500 and network failure are still untested**.
- `GET /api/detail/:id` (redirect + malformed id), `GET /api/genre/:genre` (incl. `?type=`, curated-only, unknown and adult genres) and `GET /api/genres` were added in Phase 1 (2026-10-06).
- The catalog fallback paths (AniList failure → stale cache → curated catalog) are **not** exercised: the assertions require a reachable AniList. Only the pure functions are unit-tested.
- `DELETE /api/account` failure paths (503 when unconfigured, 502 when Supabase is unreachable) — the success and IDOR-guard paths are covered again (§3).
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
