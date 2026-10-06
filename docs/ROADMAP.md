# ROADMAP

> Created 2026-10-05. **No dates are promised.** Items are ordered by dependency, not by schedule.
> Detailed tasks: `docs/TASKS.md`. Statuses: **CURRENT** (done/exists) · **NEXT** (agreed direction) · **FUTURE** (candidate, not approved).

## CURRENT — what the project is today

- Discovery catalog SPA (home, popular, movies, series, search, detail, watchlist, profile) on an Express server.
- Live AniList metadata for **trending, popular, movies, series, genre and genres** plus search/details, with a 12-entry curated overlay and offline fallback.
- **Phase 1 complete (2026-10-06):** one canonical AniList ID (`id === anilistId` everywhere), every catalog list live-backed and cached, `/api/detail/:id` retired to a redirect, and the Movies / TV Series / Genre page bugs fixed and verified.
- Guest-local watchlist; Supabase-backed cloud watchlist for signed-in users with consent-based migration.
- Supabase email/password authentication with self-service, server-verified account deletion.
- SEO (canonical/OG/Twitter/JSON-LD/robots/sitemap), legal pages, security headers, CORS allowlist, SRI on the CDN script.
- Tests (`npm test`), lint (`npm run lint`), CI for `main`/`master`.
- Documentation baseline in `docs/` (this set) plus a corrected README.
- Product/architecture decisions recorded 2026-10-05 (`docs/PRD.md` §7), and the authenticated account-deletion test coverage restored.

## NEXT — approved direction

1. ~~**Unify the catalog on one canonical ID**~~ — **DONE 2026-10-06** (TASKS Phase 1): AniList IDs everywhere, live-backed trending/genre/movies/series/popular, curated layer demoted to curation + offline fallback, TV Series filtered to TV, genre filtering consistent across pages.
2. **Extend tests**: deterministic fixtures for the AniList-dependent tests, then the untested endpoints and failure paths (TASKS P6.2–P6.6). The authenticated deletion coverage called for in P6.1 is **done** (2026-10-05).
3. **Harden the API**: rate limiting, caching for search/detail, honest failure states (TASKS P5.x).
4. **Build the approved watch system** in dependency order: episode identity → progress/history schema → Continue Watching UI, with Favorites as the early independent piece (TASKS P4.x).
5. **Deployment readiness**: pin Node 24.x LTS, verify the Supabase environment, split development/production projects, choose the managed PaaS, and handle the service-role secret (TASKS P8.1–P8.4).

Favorites, Watch History, Continue Watching and Episode-level progress are **approved but not implemented**. Admin is **deferred** (`docs/TASKS.md` P3.4).

## FUTURE — candidates only (no commitment)

- Richer watchlist metadata (per-title status, ordering by `added_at`) once the watch system exists.
- Admin tooling if/when a concrete operator need is confirmed (currently deferred).
- Content-Security-Policy with refactored inline handlers.
- Region-aware legal availability (beyond the current US JustWatch link).
- Image optimisation/CDN and static cache headers.
- Observability and dependency auditing.
- Optional API versioning/OpenAPI publication.

## Explicitly out of scope (current product positioning)

- Hosting, streaming, downloading, or distributing video content.
- Analytics/advertising trackers and payment processing.
- User-generated content or social features (no moderation surface exists).
