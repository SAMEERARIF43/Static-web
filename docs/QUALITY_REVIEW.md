# Security and quality review — 2026-10-12

## Verified local changes

- Search overlay now uses a semantic hidden state when closed and restores trigger focus on close. Focused browser coverage includes closed-overlay keyboard access.
- Detail requests now have a generation guard and AbortController. Superseded detail responses cannot replace newer detail content; navigation through navigateToPage cancels pending detail work.
- Focused command: `npx playwright test test-detail-race.spec.js test-search-overlay-escape.spec.js --reporter=line` — 15 passed across five Chromium configurations.
- `npm test`, `npm run lint`, `npm run audit` (production dependencies only), and `git diff --check` passed during this review. Git emitted line-ending warnings.
- Full `npx playwright test --reporter=line` discovered 130 tests but did not finish successfully. The local server became unavailable, producing connection-refused failures, and the command reached its six-minute limit. A subsequent focused run passed. No full-suite green claim applies to this snapshot.

## Offline database review and live test plan

The versioned baseline expresses owner-only SELECT/INSERT/UPDATE/DELETE policies on watchlist, including UPDATE USING and WITH CHECK. Profiles allow owner SELECT; signup creates profiles through a fixed-search-path trigger. Both user foreign keys specify deletion cascades. These are source declarations, not evidence of deployed enforcement.

The incremental progress migration assumes the baseline table and SELECT/INSERT/DELETE policies already exist. Confirm the installed policy catalog and migration history before drawing conclusions about any environment. Account deletion verifies the bearer token with Auth and derives its target UUID from that response, not request-body identity. Local mocks exercise this boundary, not real JWT validation or cascades.

### Required isolated environment

- Explicit authorization for a disposable non-production Supabase project and destructive deletion tests confined to its disposable accounts.
- Project URL and public/anon key; server-only service-role access supplied securely through environment configuration, never chat or committed fixtures.
- Two verified disposable accounts A and B with distinct UUIDs, access tokens, and distinguishable owner-created watchlist rows.
- A third disposable account C with a signup-created profile and watchlist rows for cascade tests.
- An invalid token, genuinely expired token, and optionally a token from another isolated project.
- Authorized read-only policy/catalog inspection and privileged postcondition reads for cascade verification. Never use service-role requests to demonstrate RLS enforcement.

### Acceptance cases to execute with ordinary user tokens

| Case | Expected result and postcondition |
| --- | --- |
| A selects all rows or explicitly filters B's row | B's rows absent; A's own row remains readable |
| A inserts with B's owner UUID | Rejected; privileged verification finds no inserted row |
| A updates B's row | No affected row; B reads unchanged data |
| A updates own row to B's owner UUID | Rejected by WITH CHECK; ownership unchanged |
| A deletes B's row | No affected row; B still reads its row |
| Repeat above with A/B reversed | Same isolation |
| Anonymous requests | No private rows exposed or modified |
| Invalid/expired token calls DELETE /api/account | 401 and no account deletion |
| C deletes its account, with an unrelated user ID in body | Only verified C deleted; C's profile/watchlist absent, A/B unchanged |

These are prepared test cases, not an executed integration suite. No production database changes or credential rotation were performed. Local secret storage concerns recorded in SECURITY.md were not independently verified by reading credentials.

## Remaining quality work

- Establish a controlled local performance baseline before optimizing: fixed Chromium viewport, isolated server, external assets blocked consistently, fresh contexts, repeated cold/warm samples, median/p95 navigation and first-card timing, and API request counts. No measured speedup is claimed here.
- Inspect redundant Popular-page preview loading; measure request count before removing it.
- Complete request-body timeout coverage: fetch header completion alone does not bound response.json(). Verify timeout versus cancellation behavior in autocomplete as well as helper classification.
- Extend detail-race coverage to stale failures and leaving details through search/history, not only a newer detail request.
- Manually review screen-reader announcements, modal/drawer focus behavior, contrast, zoom, and touch-target overlap. Automated keyboard checks are not accessibility conformance certification.
- Review toast/loading announcements, nested interactive card semantics, small bookmark/episode targets, and orange/white button contrast with measured colors.
- Coordinate concurrent edits to test-search-cache.spec.js before further changes; its initial incomplete duplicate fixture caused lint failures during this review.

## Product boundaries

Current progress and Continue Watching are title-level watchlist features. Playback position, stable episode identity, watch history, and favorites remain unimplemented; admin functionality remains deferred. Do not describe Supabase's account-deletion Admin API as an application admin feature.

## Next step

Stabilize ownership of the test server and concurrent test files, inspect the first full-run failures, and rerun all tests against an exclusively owned isolated server. Then finish request-body cancellation/deadline coverage and obtain authorization for real non-production RLS integration tests. Live Supabase, staging, monitoring, backups, legal review, and manual accessibility remain unverified.
