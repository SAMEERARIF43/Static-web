# SECURITY — current controls and current gaps

> Snapshot: 2026-10-05. Controls below were verified in code and (where noted) against the running app.
> **Nothing in this document is a fix.** Gaps are recorded for later phases (`docs/TASKS.md`).
> Legend: **CURRENT** · **GAP (not implemented)** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Controls that exist (CURRENT)

### 1.1 Database access — Supabase RLS
- RLS is enabled on both tables.
- `watchlist`: SELECT / INSERT / DELETE are restricted to `auth.uid() = user_id` (`TO authenticated`). No UPDATE policy.
- `profiles`: SELECT restricted to the owner; rows are created only by a `SECURITY DEFINER` trigger with fixed `search_path`.
- The browser uses the **anon key** for all user-data operations, so RLS is the only boundary protecting one user's rows from another's.

### 1.2 Authentication
- Supabase Auth (email/password) with session tokens held by supabase-js; no custom auth backend, no password storage in this repo.
- Password reset is an emailed link handled by Supabase.
- Signed-out users cannot read or write cloud watchlist rows (RLS).

### 1.3 Account-deletion verification
- `DELETE /api/account` requires `Authorization: Bearer <token>`; malformed/missing → 401.
- The token is verified against `{supabase}/auth/v1/user` with the anon key; 401/403 → 401, other failures → 502.
- The **verified** user ID (UUID-validated) is the deletion target; the request body cannot redirect deletion to another user.
- Deletion uses the service-role key only after that verification.
- Missing configuration → 503 (feature degrades safely rather than deleting anything).

### 1.4 Service-role key usage
- Referenced only in `server.js` for account deletion and in `supabase-schema.sql` comments.
- Never returned by any endpoint; `/api/config` returns exactly `{SUPABASE_URL, SUPABASE_ANON_KEY}` and tests assert that.
- `.env` is gitignored (`.gitignore` line 2).

### 1.5 Environment variables
- All server secrets come from `process.env` (`.env` loaded by dotenv).
- Production startup refuses to boot without: an `https:` non-localhost `SITE_URL`; an explicitly configured `CORS_ORIGINS` where every entry is a valid public HTTPS origin and the list includes `SITE_URL`; and valid `CONTACT_EMAIL`/`DMCA_EMAIL`. (Guards hardened 2026-10-05, uncommitted.)
- `SITE_URL` is validated as an HTTP(S) origin with no embedded credentials, at boot in all environments.

### 1.6 CORS allowlist
- Origins are restricted to `CORS_ORIGINS` (comma-separated), default `http://localhost:<PORT>` in development. In production the list is validated at boot: only public HTTPS origins, and it must include `SITE_URL`.
- Unlisted origins receive **403** (verified live and in tests); requests with no `Origin` header are allowed (same-origin/server-side behaviour).

### 1.7 Security headers
Set on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.

### 1.8 Subresource Integrity
- The Supabase CDN script is pinned to `@supabase/supabase-js@2.49.1` with `integrity="sha384-YieC…Uoy"` and `crossorigin="anonymous"`.
- The hash was independently recomputed from the CDN file during the audit and **matches**.

### 1.9 HTTPS-only image URLs (client)
- `safeImageUrl()` accepts only `https:` URLs (resolved against the current origin) and otherwise substitutes a placeholder; failed images are swapped by `onerror` handlers.

### 1.10 Static-file restrictions
- Only `public/` is served. Verified 404 for `/server.js`, `/package.json`, `/supabase-schema.sql`, `/test-search.js`, `/catalog-utils.js`, `/.env`, `/.freebuff/project-id` (dotfiles ignored).
- No directory listing, no server-side template execution.

### 1.11 Untrusted-content handling
- AniList descriptions are tag-stripped server-side (`sanitizeDescription` preserves `<br>` only).
- Client output is escaped through `escapeHtml()` (including `"` → `&quot;`, `'` → `&#39;`); the toast inserts messages as text nodes; dynamic JSON-LD is built from `JSON.stringify`.
- `express.json` body limit is 16 kb; search input length is capped at 100 characters.

## 2. Gaps (GAP — not implemented; do not treat as fixed)

| # | Gap | Impact | Notes |
| --- | --- | --- | --- |
| 1 | **No Content-Security-Policy** | No defence-in-depth against injected script; the app generates inline `onerror=` attributes in card HTML, so a naive CSP with `script-src 'self'` would need those refactored first | `server.js`, `public/script.js` |
| 2 | **No rate limiting on any endpoint** | `/api/search` and `/api/anime/:id` are unauthenticated proxies to AniList; abuse could exhaust AniList quota or server resources | no middleware present |
| 3 | **Public AniList proxy** | Anyone can use the server as an AniList relay; no per-IP caps, no caching for search/detail | `server.js` |
| 4 | **Service-role key in a local `.env` inside a OneDrive-synced folder** | Key sprawl/sync risk on the developer machine; a leaked service-role key grants full admin access to Supabase | `.env` is gitignored but present on disk |
| 5 | **Authenticated account-deletion test coverage removed (2026-10-05)** | The verification path (token → Auth API → Admin API target) is no longer asserted by `npm test`; only the unauthenticated 401 case remains | `test-search.js` — see `docs/TESTING.md` |
| 6 | No security logging/alerting | No visibility into abuse or deletion events | none found |
| 7 | No account-security controls visible in the repo (captcha, lockout tuning, MFA) | Supabase defaults apply | **NOT FOUND / NEEDS CONFIRMATION** (Supabase dashboard settings) |
| 8 | No dependency-audit automation | No `npm audit`/Dependabot in CI | `.github/workflows/ci.yml` |
| 9 | No integrity/PII inventory for Supabase region & retention | Compliance unverified | **NOT FOUND / NEEDS CONFIRMATION** |
| 10 | Legal pages are self-described drafts | Compliance/safe-harbour not established | `README.md`, `docs/PRD.md` |

## 3. Threat notes (CURRENT behaviour)

- **XSS via catalog data:** mitigated by server-side strip + client escaping; no CSP as a second layer.
- **IDOR on watchlist:** mitigated by RLS on every operation.
- **Account-deletion abuse:** requires a valid Supabase session; the target is derived from the verified token, not from input.
- **CSRF:** the app uses bearer tokens set by the client, not cookies, and mutating endpoints are limited to `DELETE /api/account` with an explicit header — no cookie-based session for the API.
- **Secret exposure via `/api/config`:** verified single-purpose whitelist; service-role key is never serialised.
