# ENVIRONMENT — configuration and runtime requirements

> Snapshot: 2026-10-06.
> **No secret values are reproduced in this document.** Only variable names, purposes, and behaviour are listed.
> Legend: **CURRENT** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. How configuration is loaded (CURRENT)

- `server.js` line 4: `require('dotenv').config()` — a `.env` file in the project root is loaded into `process.env` at startup when present.
- Values already present in the real environment take precedence over `.env` (dotenv default behaviour); with no `.env`, the process environment is used.
- `.env` and `.env.*` are gitignored (`.gitignore`); `.env.example` is explicitly allowed as the committed name-only template.
- **Documentation conflict (resolved in this pass):** the README previously stated that `.env` files are not loaded automatically. That statement was false after the `dotenv` dependency was added; the README has been corrected by this documentation pass.

## 2. Variables (CURRENT)

| Variable | Required? | Used by | Purpose / behaviour |
| --- | --- | --- | --- |
| `PORT` | optional | server | HTTP port; defaults to `3000`. Fallback origin becomes `http://localhost:<PORT>` |
| `CORS_ORIGINS` | optional in dev; **explicitly required in production** | server | Comma-separated origin allowlist; defaults to `http://localhost:<PORT>` in development. In production every entry must be a public HTTPS origin and the list must include `SITE_URL`. Unlisted origins → 403 |
| `SITE_URL` | required in production | server | Public origin used for robots/sitemap, absolute canonical/OG/Twitter URLs, JSON-LD, and the `__SITE_URL__` template in `index.html`. Must be an origin without credentials; production requires public HTTPS. Empty locally → falls back to `http://localhost:<PORT>` |
| `CONTACT_EMAIL` | required in production | server | Shown on Contact/Privacy pages via `/api/site-config`; when unset the pages show "not configured" |
| `DMCA_EMAIL` | required in production | server | Shown on the Copyright/DMCA page via `/api/site-config` |
| `SUPABASE_URL` | required in production for auth + deletion | server, browser (via `/api/config`) | Public HTTPS Supabase project origin; production startup rejects missing, local, or non-origin values |
| `SUPABASE_ANON_KEY` | required in production for auth | server → browser | Public anon/publishable key; returned by `/api/config` |
| `SUPABASE_SERVICE_ROLE_KEY` | required in production for account deletion | **server only** | Admin API credential; never returned to the browser |
| `NODE_ENV` | optional | server | When set to `production`, enforces the production guards below |
| `TEST_PORT` | optional | tests | Port for the spawned test server (default `3001`) |
| `TRUST_PROXY` | optional; set behind a reverse proxy | server | Positive integer count of trusted proxy hops for client IP/rate-limit handling; unset when no trusted proxy is present |
| `ANILIST_GRAPHQL_URL` | optional | server | AniList GraphQL endpoint override for tests or controlled environments; production public endpoints must use HTTPS |
| `JUSTWATCH_REGION` | optional | server → browser via `/api/site-config` | Availability-link region slug; defaults to `us` |

`GET /api/health` is an unauthenticated, no-store liveness endpoint; it returns a small status response and performs no external service checks.

## 3. Production startup guards (CURRENT)

With `NODE_ENV=production` the server **refuses to start** unless:

1. `SITE_URL` is set to an `https:` origin that is **not** a localhost address (`localhost`, `*.localhost`, `127.*`, `::1` are rejected), and
2. `CORS_ORIGINS` is **explicitly configured** (the development default is not accepted), and
3. every entry in `CORS_ORIGINS` is a valid **public HTTPS origin** — exact-origin form, no localhost, no credentials, no path, and
4. `CORS_ORIGINS` includes that exact `SITE_URL`, and
5. `CONTACT_EMAIL` and `DMCA_EMAIL` are both syntactically valid email addresses, and
6. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are configured; the URL is a public HTTPS origin and the public and service-role keys differ.

The server also rejects a configured `TRUST_PROXY` that is not a positive integer hop count. `SITE_URL` must be an origin with no path, query, or fragment.

`SITE_URL` is validated in **all** environments (HTTP/HTTPS origin, no embedded credentials, not `null`); production additionally requires the exact public HTTPS origin.

## 4. Local `.env` state (CURRENT — observed, values withheld)

- A local `.env` file exists; its values are intentionally not reproduced here.
- It sits in a OneDrive-synced directory; the service-role key is present there (see `docs/SECURITY.md` gap 4).
- `.env.example` (committed) lists variable names only and contains no placeholder values or credentials.
- Never commit `.env`; never copy its values into documentation, issues, or chat.

## 5. Development requirements (CURRENT)

| Item | State |
| --- | --- |
| Node.js + npm | required; Node 24.x is pinned in `engines`, `.nvmrc`, and CI |
| Install | `npm ci` for lockfile-reproducible installs (lockfile v3) |
| Run | `npm start` → <http://localhost:3000> |
| Test | `npm test` (spawns its own server on `TEST_PORT`) |
| Lint | `npm run lint` |
| Network | Required for AniList-backed features and parts of the test suite |
| Optional helper | `start-server.ps1` starts `server.js` in a new console and prints a message (it does **not** run tests despite the wording) |

## 6. Supabase configuration (CURRENT)

- Apply `supabase-schema.sql` to the Supabase project (manual step per README).
- Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the hosting environment for deletion to work.
- Auth-related settings (email confirmations, redirect URLs, rate limits, templates) live in the Supabase dashboard — **NOT FOUND / NEEDS CONFIRMATION** in this repository.
- **Decision (2026-10-05):** development and production will use **separate Supabase projects**. The currently configured project must be verified in the dashboard before any schema work; which one it is remains **NEEDS CONFIRMATION**.

## 7. Deployment configuration — RENDER PREPARATION

No Dockerfile, Procfile, `vercel.json`, `netlify.toml`, IIS config, systemd unit, or reverse-proxy config exists; the prepared target is Render's managed Node.js Web Service.

- The service URL, production variables, proxy hop count, TLS configuration, and Supabase production Auth settings must be configured after the Render service is created.

## 8. Operational guidance recorded from the audit (CURRENT)

- Do not advertise account deletion as operational until the three Supabase variables are configured in the deployment.
- Set `NODE_ENV=production`, `SITE_URL` (HTTPS), working contact/DMCA addresses, explicit `CORS_ORIGINS`, and all three Supabase variables before launch.
- Set `TRUST_PROXY` to the provider-documented hop count when the service is behind a reverse proxy; do not guess the count.
- Restart the server after editing `public/index.html` — it is read once at boot.
- See [`DEPLOYMENT.md`](../DEPLOYMENT.md) for the Render deployment procedure and provider-dependent decisions.
