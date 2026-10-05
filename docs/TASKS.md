# TASKS — development backlog derived from the audit

> Created 2026-10-05. **These tasks are not implemented.** Ordering reflects dependencies in the actual codebase.
> Each task lists its evidence and the decision/blocker that must be resolved first.
> IDs are stable references for later work; `docs/ROADMAP.md` summarises the same sequence.

## Phase 1 — Architecture / data correctness (do first; everything else depends on it)

| ID | Task | Evidence / why first | Notes |
| --- | --- | --- | --- |
| P1.1 | Choose and document the single canonical anime ID (AniList ID recommended) and migrate/retire the local-ID semantics | `/api/detail/1` → Jujutsu Kaisen vs `/api/anime/1` → Cowboy Bebop; watchlist already stores AniList IDs | Blocks all watch-progress/history work |
| P1.2 | Resolve the catalog source split: make Trending, genre filtering and any catalog listing use the live merged catalog (or explicitly relabel local-only surfaces) | Home `Comedy` genre → 0 results while the live catalog contains comedies; Trending is a fixed local slice | Decide the fate of the 12-item `ANIME_DB` as overlay vs fallback only |
| P1.3 | Resolve duplicate/conflicting endpoints: `/api/detail/:id` vs `/api/anime/:id`; `/api/genre/:genre` + `/api/genres` vs client-side genre filtering | API_SPEC §2; `/api/genres` and `/api/detail/:id` are unused by the frontend | Removal requires checking tests and any external callers |
| P1.4 | Fix TV Series filtering (exclude movies) and align its genre bar with the Popular page’s data source | `loadSeries()` renders the full catalog including movies | Mirror the Movies page pattern |
| P1.5 | Align trending semantics with its name, or rename the surface honestly | `/api/trending` = first 5 local entries | Prefer real AniList popularity once P1.2 is done |

## Phase 2 — Documentation

| ID | Task | Status now |
| --- | --- | --- |
| P2.1 | Complete the `docs/` baseline (18 files) | **DONE in this pass** — verify after Phase 1 changes land |
| P2.2 | Synchronise README with the code (dotenv statement; layout; test description) | **DONE in this pass** |
| P2.3 | Keep docs in sync as Phase 1 changes land (API_SPEC, ANIME_DATA, FEATURES, ARCHITECTURE) | Ongoing rule: docs and code must not diverge |
| P2.4 | Record the decision history (ADRs or a decisions section) once P1.1/P1.2 are chosen | Prevents the split-brain from returning |

## Phase 3 — Product decisions (no code)

| ID | Decision | Why it blocks |
| --- | --- | --- |
| P3.1 | Are Favorites in scope? | No model exists; affects schema + UI |
| P3.2 | Is Watch History in scope, and is it derived from progress or stored separately? | Affects schema, retention, privacy text |
| P3.3 | Is Continue Watching in scope (history shows it was attempted and dropped)? | Three separate decisions: resume link, home shelf, or both |
| P3.4 | Is an Admin system in scope, and for what purpose? | `docs/ADMIN_SPEC.md` decision list |
| P3.5 | Region strategy for legal-availability links (currently US-only) | Sets expectations for the JustWatch deep link |
| P3.6 | Update `docs/PRD.md`/`FEATURES.md` with the outcomes and mark items PLANNED | Source-of-truth rule |

## Phase 4 — Watch system (only after P1.1, P3.2, P3.3)

| ID | Task |
| --- | --- |
| P4.1 | Decide the episode data model (AniList `streamingEpisodes` vs numbered model vs count-only) — `docs/ANIME_DATA.md` §6, `docs/WATCH_SYSTEM.md` §5 |
| P4.2 | Design the progress table(s) with own-row RLS mirroring `watchlist` |
| P4.3 | Define completion semantics and Continue-Watching ordering (`updated_at`) |
| P4.4 | Decide guest-progress behaviour and whether the verified local→cloud migration pattern is reused |
| P4.5 | Implement (separately approved), then document in `WATCH_SYSTEM.md`/`DATABASE.md` |

## Phase 5 — API resilience and hardening

| ID | Task | Evidence |
| --- | --- | --- |
| P5.1 | Add rate limiting to the public AniList proxy endpoints | No limiter anywhere (`SECURITY.md` gap 2) |
| P5.2 | Add server-side caching for `/api/search` and `/api/anime/:id` | Only `/api/popular` is cached |
| P5.3 | Add user-visible failure states + retry for Popular/Movies/Series/genre paths | `ERROR_HANDLING.md` §3 silent failures |
| P5.4 | Consider a CSP (requires refactoring the generated inline `onerror` attributes first) | `SECURITY.md` gap 1 |
| P5.5 | Version the API or publish an OpenAPI document | No versioning today |
| P5.6 | Add a health endpoint | None exists |

## Phase 6 — Testing

| ID | Task | Evidence |
| --- | --- | --- |
| P6.1 | **Restore the removed authenticated account-deletion assertions** (token verification, Admin API target = verified user) | `TESTING.md` §3 — removed 2026-10-05 |
| P6.2 | Add coverage for `/api/anime/:id`, `/api/detail/:id`, `/api/genre/:genre`, `/api/genres` | `TESTING.md` §4 |
| P6.3 | Introduce a mocked AniList (fixtures) so search/popular tests are deterministic | Live-API flakiness |
| P6.4 | Replace brittle `script.js` substring assertions with behavioural tests where practical | Source-matching brittleness |
| P6.5 | Add failure-path tests (AniList down, 400/413/500 payloads, unknown routes) | `TESTING.md` §4 |
| P6.6 | Decide whether CI should run on the active branches, not only `main`/`master` | `.github/workflows/ci.yml` |

## Phase 7 — Admin (only if P3.4 approves)

| ID | Task |
| --- | --- |
| P7.1 | Define roles/permissions and elevation model (`docs/ADMIN_SPEC.md` §3) |
| P7.2 | Decide admin surface (server-mediated only; service-role key never in the browser) |
| P7.3 | Decide whether curation moves from code into a table |
| P7.4 | Add auditing for admin actions |

## Phase 8 — Deployment and operations

| ID | Task | Evidence |
| --- | --- | --- |
| P8.1 | Choose and document the hosting platform, process manager, TLS, and CDN | `ENVIRONMENT.md` §7 — NOT FOUND |
| P8.2 | Pin a Node version (`engines`, `.nvmrc`) and document it | No version requirement today |
| P8.3 | Configure production env (`NODE_ENV`, `SITE_URL`, `CORS_ORIGINS`, contact/DMCA emails, Supabase keys) and verify the startup guards | Guards exist; deployment values NOT FOUND |
| P8.4 | Move the service-role key out of the OneDrive-synced `.env` (secret handling policy) | `SECURITY.md` gap 4 |
| P8.5 | Add observability (structured logs/metrics, error reporting decision) and dependency auditing | `ARCHITECTURE.md` §9.7, `SECURITY.md` gap 8 |
| P8.6 | Optimise/`max-age` the large static assets | `websites picture.png` 1.94 MB; no cache headers |
| P8.7 | Legal review of the four legal pages and the operator’s DMCA posture | `PRD.md` §6 |

## Standing rules for future work

1. Documentation and code must stay synchronised; update the relevant `docs/` file in the same change as the code.
2. Never describe an unimplemented feature as implemented — mark **PLANNED** or **NOT IMPLEMENTED**.
3. Never replace live AniList data with stale local data (the merge policy in `catalog-utils.js` is authoritative until changed deliberately).
4. The site must never be presented as a streaming/hosting service.
