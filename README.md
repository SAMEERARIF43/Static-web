# Anime Hub

Anime Hub is a discovery catalog for anime and movies. It displays third-party metadata, lets visitors keep a local watchlist, links to trailers on YouTube when metadata provides one, and points visitors to legal viewing availability. Optional playback is limited to operator-configured, authorized HLS/MP4 sources; the app does not scrape public streaming sites, host copyrighted files, or provide downloads.

## Run locally

Requirements: Node.js and npm.

```powershell
npm install
npm start
```

Open <http://localhost:3000>. `npm test` runs the deterministic Node contract chain in sequence: `test-content-utils.js`, `test-manga-api.js`, `test-search.js`, `test-security.js`, `test-watchlist.js`, and `test-reading-list.js` — covering content classification, catalog/search/API behavior, security headers and outage fallbacks, watchlist, and reading-list contracts. `npm run lint` runs ESLint. The Playwright browser suite (`npx playwright test`) runs 475 tests across five Chromium projects against a hermetic local server; verified 475 passed, 0 failed. It does not require live AniList or Supabase.

## Configuration

The server loads a `.env` file from the project root automatically when one is present (via `dotenv`); otherwise it reads configuration from the process environment. Use `.env.example` as a reference when configuring your `.env` file, shell, or hosting provider. Values already set in the environment take precedence over `.env`.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (defaults to `3000`) |
| `CORS_ORIGINS` | Comma-separated list of allowed browser origins; defaults to localhost on the selected port |
| `SITE_URL` | Public site origin used when generating the sitemap and robots file |
| `CONTACT_EMAIL` | Monitored address shown on the contact and privacy pages |
| `DMCA_EMAIL` | Monitored copyright-notice address shown on the copyright page |
| `SUPABASE_URL` | Supabase project URL, used by server and browser |
| `SUPABASE_ANON_KEY` | Public Supabase anon/publishable key, returned to the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Admin API credential for account deletion; never expose it to browser code |
| `STREAM_PROVIDER_URL` | Optional authorized provider endpoint. Use `{animeId}` and `{episode}` placeholders, or the server appends `animeId` and `episode` query parameters. |
| `STREAM_PROXY_ALLOWED_HOSTS` | Comma-separated provider/CDN hostnames allowed for playback and HLS segment proxying. |
| `STREAM_PROXY_SECRET` | Optional signing secret for short-lived stream tokens. |
| `STREAM_PROXY_REFERER` / `STREAM_PROXY_ORIGIN` | Optional upstream headers required by an authorized provider. |
| `STREAM_PROXY_USER_AGENT` | Optional upstream User-Agent override. |
| `STREAM_PROXY_TIMEOUT_MS` | Upstream stream request timeout in milliseconds (default `15000`). |

Before public launch, set `NODE_ENV=production`, set `SITE_URL` to the real HTTPS origin, and configure working contact and copyright addresses. Set `CORS_ORIGINS` to include the exact deployed origin. The server refuses to start in production if those values are missing or invalid. Use HTTPS at the hosting platform or reverse proxy.

For managed Node.js hosting instructions, production environment-variable requirements, Supabase key handling, CORS, and reverse-proxy configuration, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## Data and privacy notes

- Guest watchlists are stored in the visitor's browser; signed-in watchlists are stored in Supabase, with an optional verified migration from local storage.
- Search terms are sent to this server and forwarded to AniList for catalog results.
- Catalog pages load live, non-adult AniList data and cache it in memory for 10 minutes: Trending (live trending), Popular (top 50 by popularity), Movies (films only) and TV Series (television formats only). Each list merges in curated titles, and falls back to the last cached list or the curated catalog when AniList is unavailable.
- Every anime is identified by its AniList ID; the older `/api/detail/:id` route now redirects to `/api/anime/:id`.
- The Popular page displays 30 titles per page; filters apply to the complete loaded catalog, and the selected page is shareable through the URL.
- Title details include available AniList metadata, staff and Japanese voice-actor credits, related titles, recommendations, official YouTube trailer links, and an optional authorized episode player when stream gateway variables are configured.
- Fonts are loaded from Google Fonts.
- Analytics and advertisements are not included. Playback is disabled unless an operator configures an allowlisted authorized provider.

Review the privacy, terms, contact, and copyright pages against the actual deployment and applicable law before launch. The legal pages are starting drafts, not legal advice. In particular, a DMCA page does not itself register a designated agent or establish statutory safe-harbor eligibility.

For authenticated account deletion, apply `supabase-schema.sql` to the Supabase project and configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the server hosting environment. `DELETE /api/account` verifies the caller's bearer token with Supabase Auth and deletes only the user identified by that verified token through the Supabase Admin API. The service-role key must remain server-side. Deploy the updated server and configure those environment variables before advertising deletion as operational; the profile button cannot complete deletion when they are missing.

## Project layout

- `public/` — static catalog UI and legal pages
- `server.js` — Express API, metadata proxy, and sitemap/robots endpoints
- `stream-proxy.js` — allowlisted authorized-source extractor, signed HLS proxy, and segment passthrough
- `test-search.js` — search/SEO/CORS API assertions, catalog merge unit tests, and unauthenticated and authenticated account-deletion checks using a local mock Supabase server (see `docs/TESTING.md`)
- `docs/` — product and technical documentation (start with `docs/ARCHITECTURE.md`)
