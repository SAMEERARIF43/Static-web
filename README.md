# Anime Hub

Anime Hub is a discovery catalog for anime and movies. It displays third-party metadata, lets visitors keep a local watchlist, links to trailers on YouTube when metadata provides one, and points visitors to legal viewing availability. It does not host, stream, or provide downloads of copyrighted video.

## Run locally

Requirements: Node.js and npm.

```powershell
npm install
npm start
```

Open <http://localhost:3000>. `npm test` starts the server and runs the search API assertions.

## Configuration

The server reads configuration from environment variables; it does not load `.env` files automatically. Use `.env.example` as a reference when configuring your shell or hosting provider.

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

Before public launch, set `NODE_ENV=production`, set `SITE_URL` to the real HTTPS origin, and configure working contact and copyright addresses. Set `CORS_ORIGINS` to include the exact deployed origin. The server refuses to start in production if those values are missing or invalid. Use HTTPS at the hosting platform or reverse proxy.

## Data and privacy notes

- Guest watchlists are stored in the visitor's browser; signed-in watchlists are stored in Supabase, with an optional verified migration from local storage.
- Search terms are sent to this server and forwarded to AniList for catalog results.
- The Popular page loads up to 50 non-adult anime entries from AniList, adds curated local titles outside that page, caches the merged catalog in memory for 10 minutes, and falls back to the local catalog if AniList is unavailable.
- The Popular page displays 24 titles per page; filters apply to the complete loaded catalog, and the selected page is shareable through the URL.
- Title details include available AniList metadata, staff and Japanese voice-actor credits, related titles, recommendations, and official YouTube trailer links; Anime Hub does not host or stream video.
- Fonts are loaded from Google Fonts.
- Analytics, advertisements, and video playback are not included.

Review the privacy, terms, contact, and copyright pages against the actual deployment and applicable law before launch. The legal pages are starting drafts, not legal advice. In particular, a DMCA page does not itself register a designated agent or establish statutory safe-harbor eligibility.

For authenticated account deletion, apply `supabase-schema.sql` to the Supabase project and configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the server hosting environment. `DELETE /api/account` verifies the caller's bearer token with Supabase Auth and deletes only the user identified by that verified token through the Supabase Admin API. The service-role key must remain server-side. Deploy the updated server and configure those environment variables before advertising deletion as operational; the profile button cannot complete deletion when they are missing.

## Project layout

- `public/` — static catalog UI and legal pages
- `server.js` — Express API, metadata proxy, and sitemap/robots endpoints
- `test-search.js` — API and account-deletion assertions
