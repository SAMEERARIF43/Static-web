# Deployment

AnimeHub is a Node.js/Express application that serves its frontend and API from the same process. It is intended for a managed host that runs a persistent Node.js web service; it is not a static-only site.

## Requirements

- Node.js 24.x, as pinned by `.nvmrc` and the bounded `package.json` engine range.
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

Set `SITE_URL` to the exact production HTTPS origin. Set `CORS_ORIGINS` to a comma-separated allowlist of exact HTTPS origins that includes that origin. Production startup rejects localhost, non-HTTPS origins, and non-origin entries such as values containing a path; cross-origin browser requests are accepted only from the configured allowlist.

The Render service URL is not known until the service is created. Configure the generated URL in Render's environment settings; do not copy a sample or placeholder hostname into production configuration.

## Reverse proxy and rate limits

Express rate limiting uses the request IP. When a managed host or reverse proxy sits in front of the app, set `TRUST_PROXY` to the provider-documented number of trusted proxy hops. A wrong value can cause clients to share a limiter IP or allow spoofed forwarded addresses. The value must be a positive integer; the server rejects other configured values. Rate-limit counters are in-memory and are not shared between service instances.

## Static files, caching, and health checks

The frontend is served directly from `public/`. There is no asset fingerprinting or compilation pipeline. Express sends validators (`ETag`/`Last-Modified`) and `Cache-Control: public, max-age=0` for static files, so browsers can revalidate rather than retaining stale JavaScript or HTML for long periods. The hosting/CDN cache policy is provider-specific and should preserve this conservative behavior unless assets become fingerprinted.

`GET /api/health` is a fast unauthenticated liveness check and returns `{"status":"ok"}` without contacting AniList or Supabase. It does not verify those external services.

## Render Deployment

This project runs as a Render **Web Service** (Node.js), not as a static site. Do not deploy it from this guide; complete these steps in your own accounts when ready.

1. Create or select the GitHub repository containing this project and push the project to GitHub.
2. In Render, create a **New + → Web Service** and connect that GitHub repository.
3. Select the Node.js runtime. The repository pins Node 24 in `.nvmrc`; the `package.json` engine range is bounded to Node 24.x to avoid silently moving to an untested future major.
4. Set the **Build Command** to `npm ci`.
5. Set the **Start Command** to `npm start`. There is no build command.
6. Render supplies `PORT`; do not hardcode a port or add your own `PORT` value in Render. Express listens on `process.env.PORT` (with a local development default) and binds to the host's network interface.
7. Add the required environment variables below in the Render service's Environment settings. Do not put credentials in GitHub or this document.
8. After Render creates the service, use its actual `https://…onrender.com` origin as `SITE_URL` and include that exact origin in `CORS_ORIGINS`. This does not require a custom domain. If you later add one, update both settings and the Supabase Auth URLs.
9. Configure `TRUST_PROXY` only after checking Render's current proxy topology guidance. Use the documented positive hop count; do not guess it.
10. Use the health-check path `/api/health` in Render if configuring a health check.

### Render environment template

The following is a documentation-only template. Replace empty values with the actual production configuration in Render after the generated service URL is available. Leave `PORT` to Render. `.env.example` remains a names-only template.

```dotenv
NODE_ENV=production
PORT=
SITE_URL=
CORS_ORIGINS=
CONTACT_EMAIL=
DMCA_EMAIL=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
TRUST_PROXY=
```

`SITE_URL` and each `CORS_ORIGINS` entry must be exact public HTTPS origins; production startup rejects empty or invalid settings. Keep `SUPABASE_URL` and `SUPABASE_ANON_KEY` as the public client configuration. `SUPABASE_SERVICE_ROLE_KEY` is server-only and must be entered only in Render's protected environment settings. Optional `ANILIST_GRAPHQL_URL` and `JUSTWATCH_REGION` are documented above.

### Supabase dashboard checklist

After the Render service URL is known, verify the production Supabase project's dashboard settings without changing the database schema or RLS policies:

- Authentication is enabled and the intended email/password sign-in method is configured.
- The Auth **Site URL** uses the actual production origin.
- **Redirect URLs** include the exact production callback/redirect URLs required by the app.
- Existing OAuth providers, if used, have the Render URL and provider callback URLs configured.
- Production auth callbacks, registration, sign-in, password reset (if enabled), and sign-out work with a non-production test account.

Do not enable a provider or change dashboard settings until you have confirmed the intended production project and redirect URLs.

### Verify a Render service

After deployment, check `/`, `/api/health`, `/api/config`, `/api/anime/206949`, and the legal pages over the generated HTTPS origin. Confirm that `/api/config` contains only `SUPABASE_URL` and `SUPABASE_ANON_KEY`, and exercise search, sign-in, watchlist, and account deletion with a non-production test account. Review the service's **Logs** tab in Render for startup errors and request failures; never copy credentials or tokens into logs or support messages.

## Generic managed-host checklist

1. Create a persistent Node.js web service from this repository; do not configure it as static-only hosting.
2. Select Node.js 24.x (as required by `package.json`).
3. Set the install command to `npm ci` and the start command to `npm start`; no build command is needed.
4. Add the production environment variables above using the actual domain, monitored email addresses, and production Supabase project's credentials.
5. Set `TRUST_PROXY` using the provider's proxy-hop documentation. Configure HTTPS at the host or its supported ingress.
6. Confirm Supabase Auth redirect settings and schema in the production project, then test registration/login, watchlist access, and account deletion with a non-production test account.
7. Confirm the service starts in production mode and that `/`, `/api/health`, `/api/config`, `/api/anime/206949`, and the legal pages behave as expected before directing public traffic.

Do not deploy until the production domain, environment variables, Supabase project configuration, and proxy topology have been supplied and verified.
