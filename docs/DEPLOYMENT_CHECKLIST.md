# Deployment Checklist — Anime Hub v1.0

> Production readiness audit for the Anime Hub Node.js/Express web service.
> Review each item before directing public traffic. Do not push credentials or
> sample placeholder values into Git.

---

## 1. Server Prerequisites & Runtime Environment

| Item | Requirement | Verified |
|---|---|---|
| Node.js | `>=22.0.0 <25.0.0` (pinned in `.nvmrc` and `package.json` `engines`) | |
| npm | Installed; `npm ci` reproducible from `package-lock.json` | |
| Process model | Persistent Node.js web service (not static-only hosting) | |
| Start command | `npm start` (`node server.js`) | |
| Install command | `npm ci` (no build step) | |
| Port | Host-provided `PORT`; Express listens on `process.env.PORT` (local default `3000`) | |
| Health check | `GET /api/health` returns `{"status":"ok"}` without contacting AniList/Supabase | |

---

## 2. Environment Variables Configuration

Set these in the hosting provider's environment-variable settings. `.env.example` lists names only (no values).

| Variable | Requirement | Purpose | Notes |
|---|---|---|---|
| `NODE_ENV` | Required in production (`production`) | Enables HTTPS/HSTS, CORS validation, contact-address checks | |
| `PORT` | Host-provided (do not hardcode) | Express listener port | Render supplies this |
| `SITE_URL` | Required in production | Exact public HTTPS origin (no path/query/fragment) | Render's `https://…onrender.com` origin |
| `CORS_ORIGINS` | Required in production | Comma-separated public HTTPS origins; must include `SITE_URL` | Production rejects localhost/non-HTTPS |
| `CONTACT_EMAIL` | Required in production | Monitored public contact address | Validated at startup |
| `DMCA_EMAIL` | Required in production | Monitored copyright/DMCA address | Validated at startup |
| `SUPABASE_URL` | Required in production | Public HTTPS Supabase project origin | Returned to browser via `/api/config` |
| `SUPABASE_ANON_KEY` | Required in production | Public client key for browser auth + RLS queries | Returned to browser via `/api/config` |
| `SUPABASE_SERVICE_ROLE_KEY` | Required in production | Server-only Admin API credential for account deletion | **Never expose**; server environment only |
| `TRUST_PROXY` | Set only behind a trusted reverse proxy | Positive integer proxy-hop count | Wrong value breaks client-IP attribution; rejected if invalid |
| `ANILIST_GRAPHQL_URL` | Optional | AniList GraphQL endpoint override | Production override must use HTTPS (unless localhost) |
| `JUSTWATCH_REGION` | Optional | Region slug for availability links; defaults to `us` | Invalid values fall back to `us` |

**Critical:** The server refuses to start in production if required values are missing or invalid. `SUPABASE_SERVICE_ROLE_KEY` must never be placed in `public/`, `.env.example`, documentation, or Git.

---

## 3. Supabase RLS (Row Level Security) Policy Verification

Apply `supabase-schema.sql` to the correct production Supabase project **before** enabling cloud watchlists. Verify without changing schema or RLS policies:

| Policy | Operation | Target | Condition |
|---|---|---|---|
| Users can view their own watchlist | SELECT | `public.watchlist` | `auth.uid() = user_id` |
| Users can insert into their own watchlist | INSERT | `public.watchlist` | `WITH CHECK auth.uid() = user_id` |
| Users can update their own watchlist | UPDATE | `public.watchlist` | `USING` + `WITH CHECK auth.uid() = user_id` |
| Users can delete their own watchlist items | DELETE | `public.watchlist` | `auth.uid() = user_id` |
| Users can view their own profile | SELECT | `public.profiles` | `auth.uid() = id` |

Verification checklist:
- [ ] RLS enabled on `public.watchlist` (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`)
- [ ] RLS enabled on `public.profiles`
- [ ] `set_watchlist_updated_at` trigger + function present
- [ ] `handle_new_user` signup trigger + function present (auto-creates profile)
- [ ] `ON DELETE CASCADE` on `profiles.id` and `watchlist.user_id` referencing `auth.users(id)`
- [ ] RLS enforced; browser uses `SUPABASE_ANON_KEY` (public), data access constrained by policies

---

## 4. HTTPS/SSL, Custom Domain, CORS & Rate Limiting

### HTTPS/SSL
- [ ] Serve over HTTPS at the host or reverse-proxy ingress
- [ ] `SITE_URL` is an exact public HTTPS origin (no path/query/fragment)
- [ ] HSTS applied automatically in production (`Strict-Transport-Security`)

### Custom Domain
- [ ] If using a custom domain, update `SITE_URL` and `CORS_ORIGINS` to the custom origin
- [ ] Update Supabase Auth **Site URL** and **Redirect URLs** to the production origin
- [ ] Confirm auth callbacks, registration, sign-in, password reset, sign-out with a non-production test account

### CORS
- [ ] `CORS_ORIGINS` is a comma-separated list of exact public HTTPS origins
- [ ] `CORS_ORIGINS` includes `SITE_URL`
- [ ] Production rejects localhost, non-HTTPS origins, and values with paths
- [ ] Foreign origins receive `403 Not allowed by CORS` (security headers still applied)

### API Proxy Rate Limiting (express-rate-limit, fixed windows)
| Scope | Limit | Window | Notes |
|---|---|---|---|
| Global `/api` | 120 requests | 60 s | Exempts `/api/site-config` and `/api/config` |
| AniList proxy (`/api/search`, `/api/browse`, `/api/anime/:id`, `/api/manga*`) | 60 requests | 60 s | Highest quota risk; forwards to AniList |
| Account deletion (`DELETE /api/account`) | 5 requests | 15 min (900 s) | Counts malformed/unauthenticated attempts too |

- [ ] `TRUST_PROXY` set to the provider-documented trusted proxy-hop count when behind a reverse proxy; leave unset otherwise
- [ ] Rate-limit counters are in-memory and **not shared** between service instances
- [ ] 429 responses carry security headers and a neutral message

---

## 5. Pre-Flight Verification

After deployment, confirm over the production HTTPS origin:

- [ ] `GET /` serves the SPA with security headers (`nosniff`, `DENY`, CSP, etc.)
- [ ] `GET /api/health` returns `{"status":"ok"}`
- [ ] `GET /api/config` returns **only** `SUPABASE_URL` and `SUPABASE_ANON_KEY` (never the service-role key)
- [ ] `GET /api/anime/206949` returns detail data
- [ ] Legal pages (privacy, terms, contact, DMCA) render
- [ ] Search, sign-in, watchlist, and account deletion work with a non-production test account
- [ ] Review the host's **Logs** tab for startup errors and request failures; never copy credentials/tokens into logs or support messages

---

## 6. Do Not Deploy Until

- [ ] Production domain/environment variables supplied and verified
- - Production Supabase project configured and schema/RLS applied
- - Proxy topology confirmed and `TRUST_PROXY` set correctly (if behind a proxy)
- - HTTPS configured at host or ingress
