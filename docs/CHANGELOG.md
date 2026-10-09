# CHANGELOG

> Documentation status legend used across `docs/`:
> **CURRENT** — exists and works in the codebase today · **PLANNED** — agreed to be built, not built ·
> **NOT IMPLEMENTED** — absent from the codebase · **NOT FOUND / NEEDS CONFIRMATION** — cannot be determined from the repository.
>
> Snapshot: 2026-10-06, branch `agents/anime-movie-website-audit-and-build`.
> This changelog reconstructs known history from git. It is not a release changelog; no version tags exist.

## 2026-10-08 — Phase 2 (core features): Task 2A — strict browse endpoint + Load more

Features 1 and 2 proved the filter/pagination contract on `/api/catalog`. Task 2A hardens that contract for the UI: the Popular page now talks to a new, stricter sibling endpoint and accumulates pages with a **Load more** button instead of a Previous/Next pager.

- **New endpoint `GET /api/browse` (`server.js`):** same filter vocabulary as `/api/catalog`, strictly validated — fixed enum allowlists (`season`, `format`, `status`, and the four AniList `sort` spellings), `year` 1960…current+1, `minScore` 0–100, `page` 1–50, `perPage` 1–30, comma-separated `genre` allowlisted against the live+curated genre list with adult genres excluded (`genre=Hentai` → 400), and a parameter supplied twice (`?year=2020&year=2021`) rejected outright. The first violation answers `400 { message }`; unrelated parameters are ignored. Every value is bound as a GraphQL **variable** and the document keeps `isAdult: false`.
- **Pagination contract:** the body stays a plain list; `X-Catalog-Page`, `X-Catalog-Per-Page`, `X-Catalog-Total-Pages`, `X-Catalog-Has-Next` and `X-Catalog-Total` carry AniList's `pageInfo` (or the curated fallback's local arithmetic), and `X-Catalog-Source` keeps naming the answering source.
- **Cache:** 5-minute TTL, **max 100 entries** with FIFO eviction (no unbounded growth), single-flight, keyed by a normalized `browseCacheKey` — genre order and case differences (`genre=Comedy,Action&sort=POPULARITY_DESC` vs `genre=action,comedy&sort=popularity_desc`) share one entry, while a different page, page size or filter does not. A fallback is never cached, so the next request retries AniList.
- **Rate limiting:** the AniList-proxy limit (`60;w=60`, same as `/api/search`) in addition to the global `/api` limit — no weaker path.
- **Frontend (`public/index.html`, `public/script.js`, `public/style.css`):** the Previous/Next pager and its `catalogPage` URL writing are replaced by a **Load more** button that fetches `page + 1` and appends it to the grid, deduplicating by `id` so a title can never appear twice. Filters stay mirrored in the shareable URL (`?page=popular&genre=…&sort=SCORE_DESC`, defaults omitted), so refresh, shared links and Back/Forward restore the same view; legacy `sort=score` and `catalogPage` links still rehydrate; out-of-range URL values are dropped client-side before the request. The existing skeleton loader, empty state, error state and card components are reused — no page redesign.
- **Tests:** `test-search.js` adds unit coverage (`parseBrowseFilters` valid set, defaults, every rejection range, repeated params in both object and `URLSearchParams` form, cache-key normalization, `isAdult: false` + variable binding) and a live block (headers + `RateLimit-Policy`, page 2 disjoint from page 1, `perPage` cap, format/year filters, thirteen invalid queries → 400 with no leakage, equivalent-spelling cache normalization, page 50 inside the window). `test-security.js` asserts the curated fallback contract during an AniList outage (honest page headers, `page=2` empty, composed filters, `SCORE_DESC` descending) plus fifteen invalid queries → 400 **with full security headers** on the outage path.
- **Documentation:** `docs/API_SPEC.md` documents `GET /api/browse` (parameters, allowlists, validation, caching, fallback, examples); the other docs were updated where they still described the Previous/Next UI or named `/api/catalog` as the page's data source.
- **`/api/catalog` removed (still Task 2A, pre-commit):** a follow-up audit found nothing called it — the Popular page had switched to `/api/browse` — and it was the less strict path (first-of-repeated params, adult genres silently dropped, a 1–5000 page window). The route, its `proxyLimiter` mount, its private cache (`getFilteredCatalog`), `parseCatalogFilters` (with `readParam`, `MIN_YEAR`, `MAX_CATALOG_PAGE`, `CATALOG_SEASONS`, `CATALOG_FORMATS`) and its HTTP/unit tests were removed; the shared query builder, `pageMeta`, `normalizeStatus` and `filterCatalogLocally` stay because `/api/browse` uses them. The Feature 1–2 entries above remain the historical record, and `GET /api/browse` is now the only filtered catalog endpoint.

## 2026-10-08 — Phase 2 (core features): Feature 1 — advanced filters and sorting

The takeover brief redefined Phase 2 as the major **core-feature** phase. Feature 1 is implemented and verified; features 2–7 follow in the same phase.

- **New module `catalog-filters.js`:** a pure, testable parser/validator/query-builder. `parseCatalogFilters` validates every catalog parameter (multi-select genre against the live genre list, year range, season/format/status enums, 0–100 minimum score, sort allowlist, bounded page) and returns either normalized filters or an explanatory error. `buildCatalogGraphQL` emits a GraphQL document in which **every** user value is a bound variable (`$genre_in`, `$season`, `$seasonYear`, `$format`, `$status`, `$minScore`, `$sort`, `$page`, `$perPage`) — never interpolated. Unset filters are omitted from both the document and the payload, because AniList rejects `averageScore_greater: null` with “Illegal operator and value combination” and treats a null `status` as a filter.
- **New endpoint `GET /api/catalog` (`server.js`):** filters (`genre`, `year`, `season`, `format`, `status`, `minScore`, `sort`) plus pagination (`catalogPage`), 30 per page, 10-minute in-memory cache (bounded, single-flight), the AniList-proxy rate limit, and `X-Catalog-Source: anilist|curated`. It returns the AniList page as-is (merged with an empty catalog only to normalize the item shape and `id === anilistId`); unlike the fixed home-page catalogs it deliberately does **not** append curated entries, which would inflate a page beyond `perPage` and repeat the same curated titles on every page. During an AniList outage it answers from the curated catalog filtered with the same semantics.
- **The pagination parameter is `catalogPage`, not `page`:** the SPA already uses `?page=` for its own routes (`?page=popular`), so a pagination argument of that name would collide. Unrelated parameters are ignored, and a regression test asserts `?page=popular` is not read as a page number.
- **Frontend (`public/index.html`, `public/script.js`, `public/style.css`):** the Popular page's catalog filter form now offers a multi-select genre list (populated from `/api/genres`), a release-year input, season, format, status, minimum score and the four required sorts (Popularity, Score, Newest, Title). Filter state is mirrored into the query string, so a refresh, a shared link and Back/Forward all reproduce the same view (`pushState` for user-initiated changes, `replaceState` when rehydrating); unknown or invalid URL values are ignored and the URL is normalized; “Clear filters” rewrites the URL; a rejected request recovers once by clearing the filters. The previous client-side filtering over the 50-title popular list (and its studio/language/type selects) was replaced by this server-side path.
- **Tests:** `test-search.js` adds unit coverage for the parser, the query builder (including the unset-argument rule and the route-parameter guard) and the curated fallback filter; `test-security.js` adds HTTP coverage for the endpoint during an AniList outage (genre multi-select, score and title sorts, minimum score, a curated status label, honest empty results for unmatched format/season, combined filters, thirteen invalid-parameter rejections with security headers, and the `?page=popular` route-parameter case).
- **Verification:** `npm run lint`, `npm test`, `npm run audit` and `git diff --check` all exit 0; a browser check on a development server confirmed live filtering (30 cards per page, `X-Catalog-Source: anilist`), filter rehydration from a shared URL, pagination to page 2, Back restoring page 1 with the filters intact, “Clear filters” resetting the URL, and invalid URL parameters being ignored.

## 2026-10-08 — Phase 2 (core features): Feature 2 — pagination

**Recommendation: Pagination, not Load More.** The Popular page already had a Previous/Next control wired to `catalogPage`, the `/api/catalog` endpoint is page-based, and each page is a distinct URL that is shareable, refresh-safe and reproduced by Back/Forward. Load More would require client-side accumulation and a single URL that cannot be shared to the same view. Pagination was completed rather than replaced.

- **Real totals (`catalog-filters.js`, `server.js`):** the filtered query now requests AniList `pageInfo { total perPage currentPage lastPage hasNextPage }`, and `fetchAniListPage` returns the media and pageInfo together. `/api/catalog` reports pagination in headers — `X-Catalog-Page`, `X-Catalog-Per-Page`, `X-Catalog-Total-Pages`, `X-Catalog-Has-Next`, and `X-Catalog-Total` when known — so the response body stays a plain list exactly like every other catalog endpoint.
- **Honest page state (`public/script.js`):** the client reads those headers instead of guessing from how full a page looks, so a filtered page that legitimately returns fewer than 30 titles is no longer mistaken for the last page. It shows “page N of M”, disables Next on the last page, hides the controls when there is only one page, and pulls a hand-edited out-of-range `catalogPage` back to page 1.
- **Offline parity (`server.js`):** the curated fallback paginates locally with the same page size, so page boundaries behave identically during an AniList outage and the same headers are always present.
- **Regression found and fixed during browser verification:** the fresh-cache path returned the cached entry without its `meta`, so every request served from the warm `/api/catalog` cache crashed with **500** (`Cannot read properties of undefined (reading 'page')`). The cached entry is now returned whole, and both suites assert that a repeated request returns the same pagination metadata.
- **Tests:** `test-search.js` asserts the live contract (30-item pages, canonical IDs, no repeated title within a page, a real multi-page total, page 2 not overlapping page 1, an out-of-range page reporting “no next”, and the cached-repeat case); `test-security.js` asserts the curated contract (`total-pages: 1`, `has-next: false`, page 2 honestly empty).
- **Verified 2026-10-08 (browser):** `/api/catalog?genre=Action&sort=score` renders “5000 titles — showing 30 on page 1 of 166” with Previous disabled; Next loads page 2 with a different first title; Back restores page 1 with the filters intact.

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
