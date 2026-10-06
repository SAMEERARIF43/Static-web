# Deployment

AnimeHub is a Node.js/Express application that serves its frontend and API from the same process. It is intended for a managed host that runs a persistent Node.js web service; it is not a static-only site.

## Requirements

- Node.js 24.x or a compatible version allowed by `package.json`.
- npm.
- A managed Node.js host that provides HTTPS, injects a `PORT`, and supports runtime environment variables.

## Install and start

From the project root, install the lockfile-defined dependencies and run the existing start script:

```sh
npm ci
npm start
```

There is no build step. The host should use `npm start` as its start command and route HTTPS traffic to the port provided in `PORT`. Keep the Node process running; the API and frontend are served together.

## Environment variables

Configure these in the hosting provider's environment-variable settings. `.env.example` lists variable names only; it intentionally contains no sample values.

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Set to `production` | Enables HTTPS, CORS, contact-address, and Supabase startup checks and production HSTS. |
| `PORT` | Host-provided; optional locally | Port for the Express listener. The local default is `3000`. |
| `SITE_URL` | Required in production | The exact public HTTPS origin, without a path, query, or fragment. Supply the real URL after choosing a host/domain; do not use a placeholder value. |
| `CORS_ORIGINS` | Required in production | Comma-separated, exact public HTTPS origins. Include the `SITE_URL` origin; add other origins only when an additional browser origin is intentionally used. |
| `CONTACT_EMAIL` | Required in production | Monitored public contact address shown by the site configuration. |
| `DMCA_EMAIL` | Required in production | Monitored copyright/DMCA address shown by the site configuration. |
| `SUPABASE_URL` | Required in production | Public HTTPS Supabase project origin. |
| `SUPABASE_ANON_KEY` | Required in production | Public client key used by browser authentication and RLS-protected queries. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required in production | Server-only Admin API credential used for verified account deletion. Never expose it to frontend code or public endpoints. |
| `TRUST_PROXY` | Set when behind a trusted reverse proxy | Positive integer proxy-hop count. Determine the correct value from the selected host's topology; leave unset when the app is reached directly. Do not set it to `true`. |
| `ANILIST_GRAPHQL_URL` | Optional | AniList GraphQL endpoint override for tests or controlled environments. Production overrides must use HTTPS unless they point to localhost. |
| `JUSTWATCH_REGION` | Optional | Region slug for availability links; defaults to `us` if unset or invalid. |

The server intentionally refuses to start in production when required values are missing or invalid. It does not contain a production domain or email address; provide the real values in the host configuration.

## Supabase setup

Use the intended production Supabase project, and configure its Auth site URL, redirect URLs, email/SMTP settings, and security controls in the Supabase dashboard. Apply the existing `supabase-schema.sql` to the correct project before enabling cloud watchlists.

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are public client configuration. `/api/config` returns only these two values.
- `SUPABASE_SERVICE_ROLE_KEY` is a privileged server credential. Store it only in the hosting provider's server environment. It is not returned to the browser and must not be placed in `public/`, `.env.example`, documentation, or Git.
- Keep RLS enabled. The browser uses the public key; user data access is constrained by the project's RLS policies.

## CORS and public URL

Set `SITE_URL` to the exact production HTTPS origin. Set `CORS_ORIGINS` to a comma-separated allowlist of exact HTTPS origins that includes that origin. Production startup rejects localhost, non-HTTPS origins, paths, and origins that do not match `SITE_URL`.

The production domain and host are not selected in this repository. Supply them after choosing the provider; do not copy a sample/placeholder hostname into production configuration.

## Reverse proxy and rate limits

Express rate limiting uses the request IP. When a managed host or reverse proxy sits in front of the app, set `TRUST_PROXY` to the provider-documented number of trusted proxy hops. A wrong value can cause clients to share a limiter IP or allow spoofed forwarded addresses. The value must be a positive integer; the server rejects other configured values. Rate-limit counters are in-memory and are not shared between service instances.

## Static files, caching, and health checks

The frontend is served directly from `public/`. There is no asset fingerprinting or compilation pipeline. Express sends validators (`ETag`/`Last-Modified`) and `Cache-Control: public, max-age=0` for static files, so browsers can revalidate rather than retaining stale JavaScript or HTML for long periods. The hosting/CDN cache policy is provider-specific and should preserve this conservative behavior unless assets become fingerprinted.

There is no dedicated readiness endpoint. A successful `GET /` can be used as a basic HTTP liveness check; it does not verify AniList or Supabase availability.

## Generic managed-host checklist

1. Create a persistent Node.js web service from this repository; do not configure it as static-only hosting.
2. Select Node.js 24.x (or a version accepted by `package.json`).
3. Set the install command to `npm ci` and the start command to `npm start`; no build command is needed.
4. Add the production environment variables above using the actual domain, monitored email addresses, and production Supabase project's credentials.
5. Set `TRUST_PROXY` using the provider's proxy-hop documentation. Configure HTTPS at the host or its supported ingress.
6. Confirm Supabase Auth redirect settings and schema in the production project, then test registration/login, watchlist access, and account deletion with a non-production test account.
7. Confirm the service starts in production mode and that `/`, `/api/config`, `/api/anime/206949`, and the legal pages behave as expected before directing public traffic.

Do not deploy until the production domain, environment variables, Supabase project configuration, and proxy topology have been supplied and verified.
