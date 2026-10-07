# Folder & File Layout — Anime Hub

```
Static-web/                     ← project root (git repo)
├── server.js                   ← Express 5 backend (single file, CommonJS)
├── search-utils.js             ← search, ranking, fuzzy match helpers (shared by server + tests)
├── catalog-utils.js            ← AniList → catalog mapping, merge policy (shared by server + tests)
├── package.json
├── package-lock.json
├── .env                        ← local secrets (gitignored, never committed)
├── .env.example                ← template with all required variable names
├── .eslintrc.json              ← ESLint config (eslint:recommended, no-undef: error)
├── .nvmrc                      ← Node version pin
├── supabase-schema.sql         ← versioned SQL migration (watchlist, profiles, RLS, trigger)
├── test-search.js              ← integration tests (catalog, search, suggestions, auth, CORS, headers)
├── test-security.js            ← security / resilience tests (CSP, rate limits, outage fallback)
├── test-search.js.orig         ← backup, do not edit
│
├── public/                     ← served by express.static; the ONLY directory served as static
│   ├── index.html              ← SPA shell (all pages via JS); __SITE_URL__ replaced at runtime
│   ├── script.js               ← main frontend JS (vanilla, no build)
│   ├── auth-ui.js              ← Supabase auth modal, cloud watchlist, account deletion
│   ├── style.css               ← all styles (single file, no preprocessor)
│   ├── legal.css               ← styles for legal/contact pages
│   ├── legal.js                ← contact form behaviour
│   ├── privacy.html            ← static legal page
│   ├── terms.html              ← static legal page
│   ├── contact.html            ← static contact page
│   ├── dmca.html               ← DMCA / copyright page
│   ├── favicon.svg
│   ├── social-preview.jpg      ← OG/Twitter image
│   └── assets/
│       ├── favicon-64.png
│       └── images/
│           └── background.png  ← 1672×941 site background (committed, uncommitted on this branch)
│
├── docs/                       ← reference docs only; never served
│   ├── API_SPEC.md
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   ├── TESTING.md
│   └── …
│
├── .github/
│   └── workflows/
│       └── ci.yml              ← CI pipeline
│
└── .kiro/
    ├── steering/               ← these files
    │   ├── product.md
    │   ├── tech.md
    │   ├── structure.md
    │   └── conventions.md
    └── specs/                  ← per-phase implementation specs (created before coding)
```

## Routing Summary
| Route | Handler |
|-------|---------|
| `GET /` | Serves `public/index.html` with `__SITE_URL__` replaced |
| `GET /api/health` | Status JSON, no-cache |
| `GET /api/config` | Public Supabase URL + anon key only |
| `GET /api/site-config` | siteUrl, contactEmail, dmcaEmail, justWatchRegion |
| `GET /api/trending` | Live AniList → curated fallback |
| `GET /api/popular` | Live AniList → curated fallback |
| `GET /api/movies` | Live AniList (MOVIE format) → curated fallback |
| `GET /api/series` | Live AniList (TV/TV_SHORT) → curated fallback |
| `GET /api/genres` | Live AniList genre list + curated genres |
| `GET /api/genre/:genre` | Genre-filtered live catalog, optional `?type=series|movies` |
| `GET /api/search?q=` | AniList search → local fallback |
| `GET /api/search/suggestions?q=` | AniList suggestions + local fuzzy, cached 60 s |
| `GET /api/anime/:id` | AniList detail by AniList ID → curated fallback |
| `GET /api/detail/:id` | **Retired** — 308 → `/api/anime/:id` |
| `DELETE /api/account` | Server-side account deletion via Supabase Admin API |
| `GET /robots.txt`, `GET /sitemap.xml` | Generated |
| `GET /public/*` | express.static |

## What Is NOT in This Repo
- No Watch page / episode streaming — legal stance forbids it
- No admin panel
- No database ORM (raw SQL in migration file only)
- No build artifacts / dist folder
