# Tech Stack & Commands — Anime Hub

## Runtime
- **Node.js** `>=24.0.0 <25.0.0` (see `.nvmrc`)
- **npm** (use `npm ci`, never `npm install`, in CI/scripts)

## Backend
- **Express 5** (`server.js`) — single-file server, CommonJS (`"type":"commonjs"`)
- **cors** 2.x — restrictive CORS; configured origins only
- **express-rate-limit** 8.x — global (120/min), AniList-proxy (60/min), account (5/15 min)
- **axios** 1.x — all AniList GraphQL and Supabase Admin API calls
- **dotenv** 18.x — environment variables from `.env`

## Frontend
- Vanilla HTML/CSS/JS — no build step, no bundler, no framework
- Single-page app in `public/index.html` + `public/script.js` + `public/auth-ui.js`
- **Supabase JS client** loaded from CDN (`cdn.jsdelivr.net/@supabase/supabase-js@2.49.1`)
  with `integrity="sha384-..."` — must not be updated without regenerating the hash
- Google Fonts (Outfit + Inter) — loaded via `<link>` in `<head>`

## Data Sources
- **AniList GraphQL** `https://graphql.anilist.co` — live catalog, search, detail, genres
  Rate limit: ~90 req/min. All calls go through the **backend only** with in-memory caching.
- **Curated local catalog** — `ANIME_DB` array in `server.js` — fallback when AniList is down
- **Supabase** — auth (email/password), cloud watchlist, profiles (browser talks to Supabase
  directly for auth; account deletion goes through the backend only)

## Database / Schema
- `supabase-schema.sql` — versioned migration; contains watchlist and profiles tables,
  RLS policies, and account-deletion notes
- **Never run destructive SQL** without explicit user approval

## Key Commands
```
npm ci                  # install exact locked deps (use this, not npm install)
npm start               # start server (do not use in background; run manually)
npm run lint            # ESLint check
npm test                # run test-search.js && test-security.js
npm run audit           # npm audit --omit=dev
git diff --check        # verify no whitespace errors
```

## CI
- GitHub Actions `.github/workflows/ci.yml` — Node 24.x, `npm ci`, audit, lint, test
- Currently triggers on all pushes/PRs (branch filters removed on this branch)

## Key Environment Variables
See `.env.example` for the full list. Never commit `.env`.
- `PORT` — default 3000
- `SITE_URL` — canonical origin (required in production, must be HTTPS)
- `CORS_ORIGINS` — comma-separated allowed origins (required in production)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANILIST_GRAPHQL_URL` — override for tests/mocks; defaults to AniList public API
- `JUSTWATCH_REGION` — two-letter region code (default `us`)
- `TRUST_PROXY` — positive integer hop count; leave unset for direct deployments

## No New Dependencies Policy
Do not add a new npm package without: (a) stating why the existing stack cannot
do the job, (b) confirming it is actively maintained, (c) running `npm audit` afterward.
