# Conventions — Anime Hub

## Code Style
- **CommonJS** everywhere (`require`/`module.exports`). No ES modules (`import`/`export`).
- **2-space indentation** in all JS files. Single quotes preferred.
- ESLint `eslint:recommended` + `no-undef: error` + `no-unused-vars: warn`.
  Run `npm run lint` and fix all errors before committing.
- Functions are named and documented with a short JSDoc comment if their purpose
  is not obvious from the name alone.
- No `var` — use `const` (default) or `let`.

## Naming
- Route handlers: `app.get('/api/foo', async (req, res) => { … })`
- Loader functions: `get<Name>Catalog()` — cached async loaders
- Test helpers: camelCase, co-located in the test file
- CSS: kebab-case class names; CSS custom properties prefixed `--`
- localStorage keys: `anime_hub_<name>` (not `ah_<name>`, not `ah_watchlist`)
  - Watchlist: `anime_hub_watchlist`
  - Per-user cloud cache: `anime_hub_watchlist_<userId>`
  - Migration declined flag: `anime_hub_watchlist_migration_declined_<userId>`

## Error Response Format
All API errors use this exact shape — never deviate:
```json
{ "message": "Human-readable sentence." }
```
- 400 Bad Request: invalid input
- 401 Unauthorized: missing/invalid session
- 403 Forbidden: CORS rejection
- 404 Not Found: unknown route or resource
- 429 Too Many Requests: rate limited
- 500 Internal Server Error: unexpected server failure
- 502 Bad Gateway: upstream (AniList, Supabase) returned an error
- 503 Service Unavailable: feature not configured
- 504 Gateway Timeout: upstream timed out

Never echo stack traces, internal error codes, IP addresses, or credentials
in a response body.

## Security Rules (non-negotiable)
1. **CSP**: `script-src 'self' https://cdn.jsdelivr.net` — no `unsafe-inline` for scripts.
   Style unsafe-inline is allowed (existing inline styles in markup).
2. **CORS**: Configured origins only. `ALLOWED_ORIGINS` list, never `*`.
3. **Rate limiting**: Every `/api/*` route goes through `globalApiLimiter`.
   AniList-proxy routes also get `proxyLimiter`. Account deletion gets `accountDeletionLimiter`.
4. **Input validation**: All user-supplied parameters are validated before use
   (type, length, character set). Parameterized GraphQL variables — never string interpolation.
5. **Service-role key**: Used only server-side in `DELETE /api/account`.
   Never sent to the browser, never in `/api/config`, never in logs.
6. **RLS**: Every Supabase user-data table must have `ENABLE ROW LEVEL SECURITY` and policies
   that restrict reads/writes to `auth.uid() = user_id` (or `auth.uid() = id` for profiles).
7. **X-Request-ID**: Every response carries a UUID request ID header for log correlation.
8. **Secrets**: `.env` is gitignored. Never commit real credentials. `.env.example` contains
   only variable names, no values.

## AniList Rules
- All AniList calls go through the backend — never from the browser.
- Respect the ~90 req/min rate limit. All catalog loaders use in-memory caches
  (TTL: 10 min for catalogs, 60 s for suggestions).
- The curated fallback (`ANIME_DB` in `server.js`) must keep working when AniList is down.
  The `X-Catalog-Source` header (`anilist` or `curated`) must be set on detail responses.
- AniList ID is the single canonical anime identity. `id === anilistId` on every catalog entry.
- `isAdult: false` must be present in every AniList media query.

## Test Conventions
- Tests live in `test-search.js` (catalog, search, auth, SEO) and `test-security.js`
  (headers, CSP, rate limits, outage fallback, account deletion failure paths).
- Tests spawn a real server on a test port (`TEST_PORT` env, default 3001).
  Security tests spawn multiple servers on separate ports (3011–3014).
- Use Node's built-in `assert` module — no test framework dependency.
- Every new endpoint or behavior change needs a matching test assertion.
- **Never delete or disable a test to make CI pass.** Fix the code instead.
- Run `npm test` and verify it passes before every commit.

## Supabase Schema Conventions
- Schema changes → new versioned SQL file in the repo (or appended section in `supabase-schema.sql`
  with a version comment), not ad-hoc SQL run in the dashboard.
- Every policy block includes: table name, operation (SELECT/INSERT/UPDATE/DELETE), role
  (`authenticated`), and a plain-English comment explaining why.
- `ON DELETE CASCADE` must cascade from `auth.users` to every user-data table.
- No UPDATE policy on watchlist (items are added or deleted, never mutated in place).

## Git Conventions
- Branch: `agents/optimize-autocomplete-and-banners` — commit here, never push to main/master.
- Commit messages: conventional-commit format — `type(scope): short description`
  Examples: `fix(search): align route`, `feat(steering): add product and tech docs`,
  `style(css): darken background overlay`, `docs(security): update test coverage notes`
- Small, logical commits. One concern per commit.
- Never force-push. Never `--amend` a pushed commit. Never `--no-verify`.

## One Source of Truth Decisions
| Decision | Source of truth |
|----------|-----------------|
| Anime identity | AniList ID (anilistId) — `id === anilistId` always |
| Watchlist storage (logged out) | `localStorage['anime_hub_watchlist']` |
| Watchlist storage (logged in) | Supabase `watchlist` table + per-user localStorage cache |
| Background overlay value | `rgba(9, 12, 18, 0.68)` in `public/style.css` |
| CSP script-src allowlist | `'self' https://cdn.jsdelivr.net` — nothing else |
| JustWatch region default | `us` (overridable via `JUSTWATCH_REGION` env var) |
| Supabase client load | CDN in `index.html` with `integrity` hash — do not change without rehashing |

## Phase Workflow
Before coding any phase:
1. Write a short spec in `.kiro/specs/<phase>-<slug>.md` (requirements, design, task list).
2. List exact files to be touched.
3. Implement in small steps; add/update tests with each step.
4. Run: `npm run lint` → `npm test` → `npm run audit` → `git diff --check`.
5. All must pass. Never skip. Never delete a failing test.
6. Report: summary, files changed, real command output, manual checks, NOT VERIFIED items,
   risks/decisions, proposed commit message(s).
7. STOP and wait for approval before starting the next phase.
