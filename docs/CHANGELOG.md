# CHANGELOG

> Documentation status legend used across `docs/`:
> **CURRENT** — exists and works in the codebase today · **PLANNED** — agreed to be built, not built ·
> **NOT IMPLEMENTED** — absent from the codebase · **NOT FOUND / NEEDS CONFIRMATION** — cannot be determined from the repository.
>
> Snapshot: 2026-10-05, branch `agents/anime-movie-website-audit-and-build`.
> This changelog reconstructs known history from git. It is not a release changelog; no version tags exist.

## Known history (from git log)

| Date | Commit | Change |
| --- | --- | --- |
| 2026-08-31 | `1e47897`, `b8c2448`, `6ac9782`, `358eebf`, `6e09d44` | Early scaffold uploads, formatting/syntax fixes, `data.js` edits (early learning commits). |
| 2026-08-31 | `bc463f2` | Deleted `anime.jpeg`. |
| 2026-08-31 → 2026-09-12 | `d4b039a`, `e3c5de1`, `b73f928`, `52c92bc`, `206561c` | README updates (project description, spelling, formatting). |
| 2026-10-03 | `bddbdf5` | Added Anime Hub frontend and AniList backend (the Express server + SPA foundation). |
| 2026-10-03 | `b306fff` | Added dynamic anime details page (AniList detail endpoint and detail UI). |
| 2026-10-03 | `420a4e8` | Improved homepage UI and fixed anime images. |
| 2026-10-03 | `816af2e` | **"Add continue watching feature"** — implemented in the *then-current root* `index.html`, `script.js`, `style.css` (441 inserted lines). **That code no longer exists**: the root duplicates were deleted during the `public/` restructure. No continue-watching UI or logic exists in the current `public/` implementation. Historical record only. |
| 2026-10-04 | `dc15de9`, `fdade94` | Agent-host checkpoint commits (repository reorganization to `public/`, removal of root duplicate files, test/debug script cleanup). |
| 2026-10-05 | `8158752` | "Complete Anime Hub audit and security fixes": removed dead `public/data.js`, `debug-api.js`, `debug-test.js`, `test-api.js`, `test-route.js`, `test-schema.js`, `quick-test.js`, `run-test.js`, root duplicates (`index.html`, `script.js`, root `websites picture.png`), added security-header middleware, CORS allowlist behaviour, static-root protection, SEO/canonical corrections, social preview image, favicon, merge-policy rewrite in `catalog-utils.js`, expanded `test-search.js`. |
| 2026-10-05 | `979e893` | "Harden Supabase schema and RLS policies": `watchlist` and `profiles` tables, RLS enablement, own-row policies, `handle_new_user()` signup trigger, account-deletion documentation in SQL comments. |
| 2026-10-05 | `50e9d1f` | Agent-host checkpoint commit. |

## Working tree state at this snapshot

Ten files are modified but **not committed** (concurrent work by more than one editor):

```
.env.example, catalog-utils.js, package-lock.json, package.json,
public/auth-ui.js, public/index.html, public/script.js, public/style.css,
server.js, test-search.js
```

Notable uncommitted changes observed:

- `SITE_URL` templating (`__SITE_URL__`) for absolute canonical/Open Graph URLs; `/api/site-config` now returns `siteUrl`.
- Hardened production startup guards in `server.js`: `SITE_URL` must be `https:` and non-localhost; `CORS_ORIGINS` must be explicitly configured and contain only valid public HTTPS origins, including `SITE_URL`.
- `dotenv` dependency added and `require('dotenv').config()` in `server.js` (this contradicts the current README — see README correction in this documentation pass).
- Supabase CDN script pinned to `@supabase/supabase-js@2.49.1` with a Subresource Integrity hash (verified correct during the audit).
- Search response race guard (`searchRequestId`), quoted-attribute escaping in `escapeHtml`, safe local-watchlist parsing, canonical updates in `updatePageSeo`.
- `test-search.js`: **the authenticated account-deletion assertions were removed** (the mock Supabase auth server and the checks on `/auth/v1/user` + Admin API targeting). Only the unauthenticated `401` case remains, and `SUPABASE_URL` is now a dummy `https://example.invalid`. See `docs/TESTING.md`.

## NOT FOUND / NEEDS CONFIRMATION

- No version numbers, tags, or release process exist.
- Commit scope for the three `Agent Host changes…` commits is machine-generated and not documented.

## PLANNED

- A real release changelog (semantic versions + dated entries) once the project has a release process.
