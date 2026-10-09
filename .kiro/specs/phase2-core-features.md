# Phase 2 — Core Features (spec)

> Written before coding, per `.kiro/steering/conventions.md` → "Phase Workflow".
> Phase 0 (audit/stabilisation) and Phase 1 (visual fixes / canonical AniList ID)
> are complete and reviewed. This spec covers **Phase 2 only** and stops there.

## Requirements — features, in order

1. **Advanced filters and sorting** — Genre (multi-select), Year, Season, Format,
   Status, Minimum score, Sort (Popularity, Score, Newest, Title). Backend-validated
   with allowlists; GraphQL **variables** only (never string interpolation).
   Frontend state reflected in the URL query string; refresh/share/back-forward safe.
2. **Pagination / Load More** — one of the two; recommendation stated before coding.
3. **Server-side caching** — for the catalog endpoints.
4. **Watch statuses + episode progress + ratings** — per-user, Supabase, RLS, versioned SQL.
5. **Airing schedule** — AniList airing data, server-side, cached.
6. **Detail page upgrades.**
7. **Legal Watch page replacement** — trailers + official/legal where-to-watch only.

## Constraints (non-negotiable — from the takeover brief)

- No framework change; Vanilla JS + Express 5 + CommonJS. Minimal, targeted changes.
- No new npm dependency unless justified; `npm audit` after.
- Security must never be weakened: CSP, headers, CORS, rate limits, validation,
  auth, RLS, IDOR guards, request IDs.
- All AniList calls stay server-side; curated fallback and `X-Catalog-Source` preserved.
- Supabase schema changes → versioned SQL migration, RLS on, ownership from session
  (never a client-supplied `user_id`).
- No piracy: no pirate links, no unofficial embeds. Trailer + legal where-to-watch only.
- Truthfulness: `NOT VERIFIED` when it cannot be verified. Never weaken/delete tests.
- No commit / push / reset / deploy. Report and STOP after Phase 2.

## Design — Feature 1

### Backend
- New pure module `catalog-filters.js` (CommonJS, shared by `server.js` and tests,
  like `catalog-utils.js` / `search-utils.js`). Exports:
  - `CATALOG_SORTS`, `CATALOG_SEASONS`, `CATALOG_FORMATS`, `CATALOG_STATUSES`,
    `CATALOG_PER_PAGE`, `CATALOG_MAX_PAGE_FILTERS` — allowlists/limits.
  - `parseCatalogFilters(query, { knownGenres, maxYear })` → `{ filters, errors }`.
    Syntactic validation + enum allowlists; unknown enum/genre → error (400).
  - `buildCatalogGraphQL(filters)` → `{ query, variables }` with every user value
    bound as a GraphQL variable (`$genre_in`, `$season`, `$seasonYear`, `$format`,
    `$status`, `$minScore`, `$sort`, `$page`, `$perPage`).
  - `filterCatalogLocally(items, filters)` → curated-fallback filtering + sorting
    using the same semantics as the AniList query.
  - `normalizeStatus(value)` → canonical enum, understanding both AniList
    (`FINISHED`) and curated (`Completed`) labels.
- New route `GET /api/catalog`:
  - params: `genre` (comma list), `year`, `season`, `format`, `status`, `minScore`,
    `sort`, `page`.
  - 400 `{ message }` on any invalid parameter.
  - `proxyLimiter` (forwards to AniList) + global limiter.
  - In-memory cache (TTL 10 min, bounded) keyed by normalized filters; single-flight.
  - Curated local fallback on AniList failure; `X-Catalog-Source` header names the
    answering source (`anilist` | `curated`).

### Frontend (`public/index.html`, `public/script.js`)
- Extend the existing Popular-page `#catalog-filter-form`: multi-select genre,
  year, **season**, **status**, minimum score, format, and the four required sorts.
- Filter state is mirrored into the URL query string (`?page=popular&genre=…&sort=…`).
- `initPage()` rehydrates filters from the URL; clearing filters rewrites the URL;
  `popstate` (Back/Forward) re-applies the URL state.
- Invalid URL parameters are ignored safely (server rejects → client falls back to
  unfiltered and normalises the URL).

## Task list

- [ ] Write `catalog-filters.js`
- [ ] Wire `GET /api/catalog` in `server.js` (validation, cache, fallback, header)
- [ ] Unit tests for `parseCatalogFilters` / `filterCatalogLocally` / query builder
- [ ] HTTP tests for `/api/catalog` (valid, invalid, fallback, cache)
- [ ] Frontend: markup + URL state + fetch integration
- [ ] Run `npm run lint` / `npm test` / `npm run audit` / `git diff --check`
- [ ] Browser verification (or `NOT VERIFIED — BROWSER CHECK REQUIRED`)
- [ ] Repeat per feature 2–7, then the Phase 2 report

---

# Task 2A — `GET /api/browse`: filters, sort and Load-more pagination

Owner-assigned refinement of Features 1–2. Adds a second, stricter browse
endpoint and moves the Popular page's grid to a **Load more** flow. The
older `GET /api/catalog` endpoint was removed later in this task (pre-commit
follow-up): nothing called it, and it was the less strict path. `GET /api/browse`
is now the only filtered catalog endpoint.

## Requirements

### Backend — `GET /api/browse` (`server.js` + `catalog-filters.js`)
- Params, each with an allowlist or numeric range check; unknown value →
  **400 `{ message }`** (first error only):
  - `genre` — comma-separated multi-select, allowlist = live+curated genres
    (adult genres excluded from the allowlist → rejected as unknown), ≤10 names,
    ≤50 chars each, `GENRE_PATTERN` charset.
  - `year` — integer, **1960 … current year + 1**.
  - `season` — `WINTER|SPRING|SUMMER|FALL` (case-normalized).
  - `format` — `TV|MOVIE|OVA|ONA|SPECIAL` (case-normalized).
  - `status` — `RELEASING|FINISHED|NOT_YET_RELEASED` (case-normalized).
  - `minScore` — integer **0…100**.
  - `sort` — `POPULARITY_DESC|SCORE_DESC|START_DATE_DESC|TITLE_ROMAJI`
    (case-normalized; default `POPULARITY_DESC`).
  - `page` — integer **1…50** (default 1). Note: the SPA's `?page=popular`
    therefore answers 400 on this endpoint — the client never sends it here.
  - `perPage` — integer **1…30** (default 30).
  - **Repeated (array-valued) params are rejected** with
    "`<name> must not be provided more than once.`"; unrelated param names are
    ignored.
- AniList query: `isAdult: false`, every user value bound as a GraphQL
  **variable** (reuses `buildCatalogGraphQL`); response carries AniList
  `pageInfo` → headers `X-Catalog-Page` (currentPage), `X-Catalog-Has-Next`
  (hasNextPage), `X-Catalog-Per-Page`, `X-Catalog-Total-Pages`,
  `X-Catalog-Total` (when known), plus `X-Catalog-Source: anilist|curated`.
- Rate limit: `proxyLimiter` mounted on `/api/browse` (like `/api/search`),
  on top of the global `/api` limiter.
- Cache: **5-minute TTL, max 100 entries**, single-flight, **normalized key**
  (genres lowercased + sorted, all filters + page + perPage). `browseCacheKey`
  lives in `catalog-filters.js` so tests can assert normalization directly.
- Fallback: stale cache → curated catalog filtered/paged with the same
  semantics (`filterCatalogLocally`, local slicing by `perPage`), never cached.

### Frontend — Popular page (`index.html`, `script.js`, `style.css`)
- The filter form now fetches **`/api/browse`**; form option lists narrowed to
  the browse allowlists (drop TV Short/Music, Hiatus/Cancelled; year min 1960).
- **Previous/Next pagination is replaced by a `Load more` button** below the
  grid: first fetch loads page 1, each click fetches `page+1` and appends;
  items are **deduplicated by id** across pages.
- URL keeps only the shareable **filters** (`?page=popular&genre=…&sort=SCORE_DESC…`);
  sort is written as the browse enum (legacy `sort=score`-style URLs still
  rehydrate). Refresh restores the filters and reloads page 1.
- Reuses the existing skeleton loader, empty state, error message and the
  one-shot 400 recovery.

### Tests
- `test-search.js`: unit block for `parseBrowseFilters`/`browseCacheKey`
  (valid set, defaults, every allowlist/range rejection, repeated/array params,
  oversize values, cache-key normalization); live `/api/browse` block (200 +
  headers, page 2 disjoint from page 1, `perPage`, valid filters, invalid → 400,
  rate-limit policy, normalized-equivalence).
- `test-security.js` (outage): curated fallback + `X-Catalog-Source: curated`,
  pagination contract, filter enforcement, invalid params → 400 with security
  headers and no upstream leakage.

## Task list
- [ ] `parseBrowseFilters` + `browseCacheKey` in `catalog-filters.js`
- [ ] `GET /api/browse` route in `server.js` (validation → cache → fallback → headers)
- [ ] Frontend: Load more flow + URL state + narrowed controls
- [ ] Tests: `test-search.js`, `test-security.js`
- [ ] `docs/API_SPEC.md` (+ stale rows elsewhere)
- [ ] `npm run lint` / `npm test` / `npm run audit` / `git diff --check`
