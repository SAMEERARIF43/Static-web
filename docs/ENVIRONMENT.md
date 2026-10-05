# ENVIRONMENT — configuration and runtime requirements

> Snapshot: 2026-10-05.
> **No secret values are reproduced in this document.** Only variable names, purposes, and behaviour are listed.
> Legend: **CURRENT** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. How configuration is loaded (CURRENT)

- `server.js` line 4: `require('dotenv').config()` — a `.env` file in the project root is loaded into `process.env` at startup when present.
- Values already present in the real environment take precedence over `.env` (dotenv default behaviour); with no `.env`, the process environment is used.
- `.env` is gitignored (`.gitignore` line 2: `.env`). `.env.example` is the committed template.
- **Documentation conflict (resolved in this pass):** the README previously stated that `.env` files are not loaded automatically. That statement was false after the `dotenv` dependency was added; the README has been corrected by this documentation pass.

## 2. Variables (CURRENT)

| Variable | Required? | Used by | Purpose / behaviour |
| --- | --- | --- | --- |
| `PORT` | optional | server | HTTP port; defaults to `3000`. Fallback origin becomes `http://localhost:<PORT>` |
| `CORS_ORIGINS` | optional in dev; **explicitly required in production** | server | Comma-separated origin allowlist; defaults to `http://localhost:<PORT>` in development. In production every entry must be a public HTTPS origin and the list must include `SITE_URL`. Unlisted origins → 403 |
| `SITE_URL` | required in production | server | Public origin used for robots/sitemap, absolute canonical/OG/Twitter URLs, JSON-LD, and the `__SITE_URL__` template in `index.html`. Must be a valid HTTP(S) origin without credentials. Empty locally → falls back to `http://localhost:<PORT>` |
| `CONTACT_EMAIL` | required in production | server | Shown on Contact/Privacy pages via `/api/site-config`; when unset the pages show "not configured" |
| `DMCA_EMAIL` | required in production | server | Shown on the Copyright/DMCA page via `/api/site-config` |
| `SUPABASE_URL` | required for auth + deletion | server, browser (via `/api/config`) | Supabase project URL. Validated server-side for account deletion (HTTPS, or HTTP on localhost) |
| `SUPABASE_ANON_KEY` | required for auth | server → browser | Public anon/publishable key; returned by `/api/config` |
| `SUPABASE_SERVICE_ROLE_KEY` | required for account deletion | **server only** | Admin API credential; never returned to the browser. If missing, `DELETE /api/account` returns 503 |
| `NODE_ENV` | optional | server | When set to `production`, enforces the production guards below |
| `TEST_PORT` | optional | tests | Port for the spawned test server (default `3001`) |

## 3. Production startup guards (CURRENT)

With `NODE_ENV=production` the server **refuses to start** unless:

1. `SITE_URL` is set to an `https:` origin that is **not** a localhost address (`localhost`, `*.localhost`, `127.*`, `::1` are rejected), and
2. `CORS_ORIGINS` is **explicitly configured** (the development default is not accepted), and
3. every entry in `CORS_ORIGINS` is a valid **public HTTPS origin** — exact-origin form, no localhost, no credentials, no path, and
4. `CORS_ORIGINS` includes that exact `SITE_URL`, and
5. `CONTACT_EMAIL` and `DMCA_EMAIL` are both syntactically valid email addresses.

Failure messages (observed while auditing): `Production requires SITE_URL set to the public HTTPS origin.`, `Production requires CORS_ORIGINS to be explicitly configured.`, `Production CORS_ORIGINS must contain only valid public HTTPS origins.`, `Production CORS_ORIGINS must include SITE_URL.`, `Production requires a valid monitored CONTACT_EMAIL.`

Note: these guards were hardened on 2026-10-05 (uncommitted); re-verify `server.js` if the checks appear to change again.

`SITE_URL` is validated in **all** environments (HTTP/HTTPS origin, no embedded credentials, not `null`).

## 4. Local `.env` state (CURRENT — observed, values withheld)

- A `.env` file exists locally with all eight variables present; `PORT=3000` and `SITE_URL` empty at the audit snapshot; Supabase values are populated.
- It sits in a OneDrive-synced directory; the service-role key is present there (see `docs/SECURITY.md` gap 4).
- `.env.example` (committed) contains placeholders only: `PORT`, `CORS_ORIGINS`, `SITE_URL`, `CONTACT_EMAIL`, `DMCA_EMAIL`, and `SUPABASE_*` placeholders (`YOUR_PROJECT_URL`, `YOUR_PUBLISHABLE_KEY`, `YOUR_SECRET_KEY`). It no longer carries the explanatory comments it once had.
- Never commit `.env`; never copy its values into documentation, issues, or chat.

## 5. Development requirements (CURRENT)

| Item | State |
| --- | --- |
| Node.js + npm | required; **version NOT FOUND** (no `engines`, no `.nvmrc`) |
| Install | `npm install` (lockfile v3) |
| Run | `npm start` → <http://localhost:3000> |
| Test | `npm test` (spawns its own server on `TEST_PORT`) |
| Lint | `npm run lint` |
| Network | Required for AniList-backed features and parts of the test suite |
| Optional helper | `start-server.ps1` starts `server.js` in a new console and prints a message (it does **not** run tests despite the wording) |

## 6. Supabase configuration (CURRENT)

- Apply `supabase-schema.sql` to the Supabase project (manual step per README).
- Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the hosting environment for deletion to work.
- Auth-related settings (email confirmations, redirect URLs, rate limits, templates) live in the Supabase dashboard — **NOT FOUND / NEEDS CONFIRMATION** in this repository.

## 7. Deployment configuration — NOT FOUND

No Dockerfile, Procfile, `vercel.json`, `netlify.toml`, IIS config, systemd unit, or reverse-proxy config exists. Hosting platform, TLS termination, process manager, and any CDN are all **NOT FOUND / NEEDS CONFIRMATION**.

## 8. Operational guidance recorded from the audit (CURRENT)

- Do not advertise account deletion as operational until the three Supabase variables are configured in the deployment.
- Set `NODE_ENV=production`, `SITE_URL` (HTTPS), working contact/DMCA addresses, and an explicit `CORS_ORIGINS` before launch.
- Restart the server after editing `public/index.html` — it is read once at boot.
