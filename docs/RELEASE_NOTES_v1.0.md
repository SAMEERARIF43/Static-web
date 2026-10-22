# Anime Hub — Release Notes v1.0

## Executive Summary

Anime Hub v1.0 is a discovery catalog for anime, movies, manga, manhwa, and manhua. It displays third-party metadata (AniList), lets visitors keep a local/cloud watchlist and reading list, links to trailers, and points visitors to legal viewing availability. It does **not** host, stream, or provide downloads of copyrighted video.

The platform is built on Node.js/Express, serves its frontend and API from a single persistent process, and is designed for managed Node.js hosting (Node 24.x). All 59 planned features across the anime/manga catalog, animated movies, recommendations, release calendar, watchlists, profiles, reviews, and art gallery are implemented and verified.

---

## Platform Overview

| Layer | Technology |
|---|---|
| Runtime | Node.js `>=22.0.0 <25.0.0` |
| Framework | Express 5 |
| HTTP client | axios |
| CORS / rate limiting | cors, express-rate-limit |
| Frontend | Vanilla JS SPA (`public/`), served statically |
| Styling | Custom CSS (CSS variables, no framework) |
| Browser tests | Playwright 1.64.0 (Chromium) |
| Backend data | AniList public GraphQL API; Supabase (auth + cloud watchlist) |
| Local persistence | `localStorage` (guest watchlist, settings, ratings/reviews, follows) |

---

## Feature Breakdown (59 Features)

### Anime & Manga Catalog
1. Home page with hero, search, Top Searches, genre bar, Trending grid, Popular preview
2. Trending catalog (live AniList `TRENDING_DESC`, non-adult, curated merge)
3. Popular catalog (live AniList top-50, curated merge)
4. Movies catalog (live `format_in: [MOVIE]`, films only)
5. TV Series catalog (live `format_in: [TV, TV_SHORT]`, series only)
6. Anime detail pages (studios, staff, characters, JP voice actors, relations, recommendations, trailer)
7. Manga / Manhwa / Manhua discovery (isolated AniList content pipeline)
8. Comic detail pages with chapter/volume metadata
9. Search (`/api/search`, AniList `SEARCH_MATCH`, local fallback)
10. Genre browsing (`/api/genre/:genre`, live + curated-only genres like Shounen)
11. Genre list (`/api/genres`, adult genres excluded)
12. Canonical AniList ID identity (`id === anilistId`)

### Catalog Filters & Sorting (Item 2A / `/api/browse`)
13. Multi-select genre filtering (allowlisted)
14. Year filter (1960–current+1)
15. Season filter (WINTER/SPRING/SUMMER/FALL)
16. Format filter (TV/MOVIE/OVA/ONA/SPECIAL)
17. Status filter (RELEASING/FINISHED/NOT_YET_RELEASED)
18. Minimum score filter (0–100)
19. Four sort modes (popularity, score, newest, title)
20. Repeated-parameter rejection
21. GraphQL variable binding (no interpolation)
22. Bounded 5-minute cache (max 100 entries, FIFO eviction)
23. Curated fallback during AniList outage

### Animated Movies (Items 42–50)
42. Art Gallery page (`#page-gallery`)
43. Official posters, banners, key visuals, character art, wallpapers
44. Filter categories: Official Art, Key Visuals, Character Wallpapers, Fan Art
45. Gallery search
46. Artist attribution labels
47. Copyright disclosures per item
48. DMCA takedown report links per item
49. Country-of-origin cover (Japanese Anime, Chinese Donghua, Western, International)
50. `countryOfOrigin` GraphQL filter on `/api/browse`

### Recommendations (Item 32)
32. Personalized recommendations (watchlist genre weights + favorite entries)
33. Star ratings (1–10) and text reviews on detail pages
34. Click-to-reveal `||spoiler||` protection on review/comment text

### Release Calendar (Item 33)
33. `#page-calendar` displaying upcoming TV releases grouped Monday–Sunday
33. Season + year filtering (`season`, `seasonYear`)
33. Load-more pagination honoring `X-Catalog-Has-Next`
33. URL rehydration (`?page=calendar&season=SPRING&year=2026`)

### Watchlists
- Guest watchlist (localStorage: `anime_hub_watchlist`)
- Five statuses (plan_to_watch, watching, completed, on_hold, dropped)
- Title-level current/total episode counts
- Cloud watchlist (Supabase `public.watchlist`, RLS `auth.uid() = user_id`)
- Guest → cloud migration on sign-in
- Custom sorting (date added, title, rating, progress)
- Custom tags/lists per item
- JSON import/export with schema validation
- In-app notifications (toast + notifications panel) for watchlist updates

### Profiles & Privacy (Item 38)
- Profile page (email, email-verified status)
- Watchlist public/private toggle
- Watch activity sharing preference
- Danger Zone account deletion (Supabase Admin API, service-role key)
- Supabase `public.profiles` table + auto-creation trigger

### Reviews & Spoiler Protection (Items 39–40)
- 1–10 star rating selector
- Text review textarea
- Local persistence + cloud sync
- `||spoiler||` blurred overlays with click-to-reveal

### Art Gallery (Items 42–50)
See Animated Movies section above.

---

## API Security & Reliability Hardening

| Finding | Severity | Status | Fix |
|---|---|---|---|
| AH-01: `/api/browse` called AniList before validating invalid requests | Medium | Fixed | Structural validation (page/perPage/year/minScore/sort/format/status/season/genre/genre membership) runs before `getGenreList()`; provider allowlist loaded only for syntactically-valid genre requests |
| AH-02: Browse metadata advertised pages beyond `BROWSE_MAX_PAGE=50` | Medium-High | Fixed | `pageMeta` caps `totalPages` at 50 and forces `hasNext=false` at page 50; page 51 still returns 400 |
| AH-04: `/api/search` and `/api/genre/:genre` hid the answering source | Low-Medium | Fixed | Truthful `X-Catalog-Source` (`anilist`/`cached`/`curated`/`local`) on all paths; consistent with `/api/browse` and `/api/anime/:id` |

Security headers (`nosniff`, `DENY`, `Referrer-Policy`, `Permissions-Policy`, CSP, `X-Request-ID`) are set on **every** response including CORS 403s, 404s, 429s, and 5xx. HSTS only in production. Rate limiting: 120/min global `/api`, 60/min AniList proxy, 5/15min account deletion.

---

## Performance Optimizations

- WebP background image (`websites picture.webp`) replacing `assets/images/background.png` — approximately 1.8 MB payload reduction; original PNG preserved untouched.
- Bounded in-memory caches (catalog 10 min, browse 5 min, search/detail, genre list, genre catalog, manga) with FIFO eviction.
- Single-flight deduplication for concurrent identical requests.
- Curated catalog fallback keeps the site operational during AniList outages.

---

## Test Verification Evidence

### Playwright E2E Browser Suite
- **475 passed / 0 failed** across five Chromium projects (desktop 1920×1080, 1440×900, 1366×768; mobile 375×667; reduced motion)
- Hermetic: AniList pointed at a closed port; all external requests aborted; no live AniList/Supabase required

### Node Unit Test Chain (`npm test`)
- **6/6 scripts passing** (`test-content-utils.js`, `test-manga-api.js`, `test-search.js`, `test-security.js`, `test-watchlist.js`, `test-reading-list.js`)
- `NPM_TEST_EXIT_CODE=0`
- Covers: content classification, catalog/search/API behavior, security headers & outage fallbacks, rate limits, account-deletion failure paths, search/detail caching, watchlist, reading-list contracts

### Static Analysis
- **ESLint: 0 errors / 0 warnings** (`npm run lint`)
- `node -c` syntax valid on `server.js`, `catalog-filters.js`, `public/script.js`

---

## Deployment Readiness

Review `docs/DEPLOYMENT_CHECKLIST.md` before directing public traffic. Key production requirements:

- Node.js 24.x, `npm ci` + `npm start` (no build step)
- `SITE_URL`, `CORS_ORIGINS`, `CONTACT_EMAIL`, `DMCA_EMAIL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` configured
- `TRUST_PROXY` set only behind a trusted reverse proxy
- Supabase schema (`supabase-schema.sql`) applied with RLS policies enabled
- `SUPABASE_SERVICE_ROLE_KEY` never exposed to frontend/Git/docs

---

## What's Not Included (By Design or Planned)

- No video hosting, streaming, or downloads
- No analytics or advertisements
- Favorites, Watch History, per-episode Watch Progress, Admin roles — approved but not built
- Live authenticated Supabase E2E tests, legal-page journey tests, cross-account RLS tests — not implemented
- Test coverage measurement, live AniList compatibility tests, automated accessibility checks — not implemented
