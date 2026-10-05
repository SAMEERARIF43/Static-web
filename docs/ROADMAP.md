# ROADMAP

> Created 2026-10-05. **No dates are promised.** Items are ordered by dependency, not by schedule.
> Detailed tasks: `docs/TASKS.md`. Statuses: **CURRENT** (done/exists) · **NEXT** (agreed direction) · **FUTURE** (candidate, not approved).

## CURRENT — what the project is today

- Discovery catalog SPA (home, popular, movies, series, search, detail, watchlist, profile) on an Express server.
- Live AniList metadata for popular/search/details with a 12-entry curated local overlay and offline fallback.
- Guest-local watchlist; Supabase-backed cloud watchlist for signed-in users with consent-based migration.
- Supabase email/password authentication with self-service, server-verified account deletion.
- SEO (canonical/OG/Twitter/JSON-LD/robots/sitemap), legal pages, security headers, CORS allowlist, SRI on the CDN script.
- Tests (`npm test`), lint (`npm run lint`), CI for `main`/`master`.
- Documentation baseline in `docs/` (this set) plus a corrected README.

## NEXT — the agreed near-term direction (not yet implemented)

1. **Unify the catalog**: one canonical ID (AniList ID) and one data source behind trending, genre, series, movies and popular (TASKS P1.1–P1.5).
2. **Settle product scope**: Favorites / Watch History / Continue Watching / Admin decisions (TASKS P3.x).
3. **Harden the API**: rate limiting, caching for search/detail, honest failure states (TASKS P5.x).
4. **Restore and extend tests**: authenticated deletion coverage first, then the untested endpoints, then deterministic fixtures (TASKS P6.x).
5. **Deployment readiness**: Node version pin, production env values, hosting decision, secret-handling policy (TASKS P8.1–P8.4).

## FUTURE — candidates only (no commitment)

- Episode-aware data model and the watch system (progress, resume, continue watching) — depends on the scope decisions.
- Favorites and richer watchlist metadata (status per title, ordering by `added_at`).
- Admin tooling if a concrete operator need is confirmed.
- Content-Security-Policy with refactored inline handlers.
- Region-aware legal availability (beyond the current US JustWatch link).
- Image optimisation/CDN and static cache headers.
- Observability and dependency auditing.
- Optional API versioning/OpenAPI publication.

## Explicitly out of scope (current product positioning)

- Hosting, streaming, downloading, or distributing video content.
- Analytics/advertising trackers and payment processing.
- User-generated content or social features (no moderation surface exists).
