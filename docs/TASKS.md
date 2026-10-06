# TASKS — development backlog derived from the audit

> Created 2026-10-05. **These tasks are not implemented.** Ordering reflects dependencies in the actual codebase.
> Each task lists its evidence and the decision/blocker that must be resolved first.
> IDs are stable references for later work; `docs/ROADMAP.md` summarises the same sequence.

## Phase 1 — Architecture / data correctness — **DONE 2026-10-06**

Approved and implemented in one pass (owner greenlit 2026-10-06). `npm test` and `npm run lint` both pass.

| ID | Task | Evidence / why first | Status |
| --- | --- | --- | --- |
| P1.1 | **DECIDED 2026-10-05: AniList ID everywhere.** The local `id: 1–12` field was **deleted** from `ANIME_DB`; `catalog-utils.withCanonicalId` guarantees `id === anilistId` on every emitted item | `/api/detail/1` → Jujutsu Kaisen vs `/api/anime/1` → Cowboy Bebop | **DONE** — verified across every catalog endpoint; no local key survives (it is not kept as an internal key either) |
| P1.2 | Resolve the catalog source split: live merged catalog for Trending, genre filtering and every catalog listing | Home `Comedy` genre → 0 results; Trending was a fixed local slice | **DONE** — one shared cached AniList query builder backs trending/popular/movies/series/genre; curated overlay + offline fallback retained (**DECIDED 2026-10-05: hybrid**) |
| P1.3 | Resolve duplicate/conflicting endpoints | API_SPEC §2 | **DONE** — `/api/detail/:id` is retired (308 → `/api/anime/:id`); `/api/genres` and `/api/genre/:genre` are live-backed from the same source the client filters. Both remain unused by the frontend and no external caller exists |
| P1.4 | Fix TV Series filtering (exclude movies) and align its genre bar with the live data source | `loadSeries()` rendered the full catalog including movies | **DONE** — `/api/series` (`format_in: [TV, TV_SHORT]`) + a client-side guard; genre clicks pass `?type=series`. Verified 51 titles, 0 films |
| P1.5 | Align trending semantics with its name | `/api/trending` = first 5 local entries | **DONE** — real AniList `TRENDING_DESC` query; verified 18 of 30 items outside the curated set |
| P1.6 | Age-gate the genre surface | `/api/genres` returned only curated genres, but the live collection includes `Hentai` | **DONE** — adult genres are excluded from the list and `Hentai` returns `[]` |
| P1.7 | Keep the curated layer honest in filtered lists | The merge appends unmatched curated entries to every list, which would leak films into a series list | **DONE** — filtered lists re-apply their own filter after merging |

## Phase 2 — Documentation

| ID | Task | Status now |
| --- | --- | --- |
| P2.1 | Complete the `docs/` baseline (18 files) | **DONE in this pass** — verify after Phase 1 changes land |
| P2.2 | Synchronise README with the code (dotenv statement; layout; test description) | **DONE in this pass** |
| P2.3 | Keep docs in sync as Phase 1 changes land (API_SPEC, ANIME_DATA, FEATURES, ARCHITECTURE) | Ongoing rule: docs and code must not diverge |
| P2.4 | Record the decision history (ADRs or a decisions section) once P1.1/P1.2 are chosen | Prevents the split-brain from returning |

## Phase 3 — Product decisions — **RESOLVED 2026-10-05**

| ID | Decision | Outcome |
| --- | --- | --- |
| P3.1 | Are Favorites in scope? | **YES** — approved to build |
| P3.2 | Is Watch History in scope, and derived or separate? | **YES** — approved; derived-vs-append-only still open (Phase 4) |
| P3.3 | Is Continue Watching in scope? | **YES** — approved to build after progress/history |
| P3.3b | Is episode-level progress in scope? | **YES** — approved; requires an episode identity that does not exist yet |
| P3.4 | Is an Admin system in scope, and for what purpose? | **LATER** — deferred; no admin work (`docs/ADMIN_SPEC.md`) |
| P3.5 | Region strategy for legal-availability links (currently US-only) | Still open |
| P3.6 | Record outcomes in `docs/PRD.md`/`FEATURES.md` and mark items PLANNED | **DONE** 2026-10-05 — `docs/PRD.md` §7 |
| P3.7 | Canonical anime ID | **AniList ID everywhere** (see P1.1) |
| P3.8 | Anime data source | **Hybrid** — AniList primary + curation/offline fallback (see P1.2) |
| P3.9 | Node version / hosting / environments | **Node 24.x LTS**; persistent Node host on managed PaaS; separate dev + production (see P8.1–P8.2) |

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
| P6.1 | **DONE 2026-10-05** — restored the authenticated account-deletion assertions (mock Supabase auth server, token verification, Admin API target = verified user, service-role header checks) | `TESTING.md` §3; an instrumented run shows 8 deletion-related assertions executing |
| P6.2 | **DONE 2026-10-06** — added coverage for `/api/movies`, `/api/series`, `/api/genre/:genre` (incl. `?type=`, curated-only, unknown and adult genres), `/api/genres`, the retired `/api/detail/:id` and `/api/anime/1`, plus the canonical-ID invariant across every catalog endpoint. Still open: `/api/anime/:id` 400/404/500/network failure | `TESTING.md` §2, §4 |
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
| P8.1 | Choose and document the hosting platform, process manager, TLS, and CDN | **DECIDED 2026-10-05: persistent Node process on a managed PaaS** — vendor selection still open (`ENVIRONMENT.md` §7) |
| P8.2 | Pin a Node version (`engines`, `.nvmrc`) and align CI | **DECIDED 2026-10-05: Node 24.x LTS** — pinning not yet done |
| P8.3 | Configure production env (`NODE_ENV`, `SITE_URL`, `CORS_ORIGINS`, contact/DMCA emails, Supabase keys) and verify the startup guards | Guards exist; deployment values NOT FOUND |
| P8.4 | Move the service-role key out of the OneDrive-synced `.env` (secret handling policy) | `SECURITY.md` gap 4 |
| P8.5 | Add observability (structured logs/metrics, error reporting decision) and dependency auditing | `ARCHITECTURE.md` §9.7, `SECURITY.md` gap 8 |
| P8.6 | Optimise/`max-age` the large static assets | Background compressed from 1.9 MB PNG to 110 KB WebP; Express serves static assets with `max-age=0` and validators, while CDN policy awaits hosting choice |
| P8.7 | Legal review of the four legal pages and the operator’s DMCA posture | `PRD.md` §6 |

## Standing rules for future work

1. Documentation and code must stay synchronised; update the relevant `docs/` file in the same change as the code.
2. Never describe an unimplemented feature as implemented — mark **PLANNED** or **NOT IMPLEMENTED**.
3. Never replace live AniList data with stale local data (the merge policy in `catalog-utils.js` is authoritative until changed deliberately).
4. The site must never be presented as a streaming/hosting service.
