# ERROR_HANDLING — current behaviour

> Snapshot: 2026-10-05. Documents what the code does today, including known silent failures.
> Legend: **CURRENT** · **GAP** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Server-side behaviour (CURRENT)

### 1.1 JSON error middleware
A single terminal error handler responds with `{ message }`:

| Condition | Status | Message |
| --- | --- | --- |
| CORS rejection (`Not allowed by CORS`) | 403 | `This origin is not allowed.` |
| Body parser errors with `status` 400 | 400 | `Invalid request.` |
| Body larger than 16 kb (`413`) | 413 | `Request body is too large.` |
| Anything else | 500 | `An internal server error occurred.` |

Errors are logged to the console with the status. There is **no** error-id, request-id, or structured logging.

### 1.2 Per-endpoint validation
- `/api/search`: empty or >100-character `q` → **400** `Enter an anime name of 1 to 100 characters.`
- `/api/anime/:id`: non-numeric id → **400** `Invalid Anime ID.`; not found on AniList → **404**; GraphQL error → **500** `AniList returned an error.`; network failure → **500** `Could not connect to AniList API.`
- `/api/detail/:id` (retired): positive integer id → **308** redirect to `/api/anime/:id`; malformed id → **404** `Anime not found.`
- `/api/genre/:genre`: missing or over-50-character genre → **400** `Enter a genre name of 1 to 50 characters.`; unknown genre → `[]` with **200**; adult genre → `[]` with **200**.
- `/api/account`: missing/malformed bearer → **401**; unconfigured server → **503**; invalid/expired session → **401**; Supabase unreachable → **502**; delete failure → **502**.
- Unknown routes fall through to Express's default 404 (HTML, not JSON).

### 1.3 Upstream failure behaviour (AniList)

| Endpoint | AniList failure result |
| --- | --- |
| `/api/trending`, `/api/popular`, `/api/movies`, `/api/series` | stale cache → curated catalog (or the curated format subset); warning logged; client always receives 200 with data |
| `/api/genre/:genre`, `/api/genres` | stale cache → curated genre matches / curated genre names; warning logged; client always receives 200 with data |
| `/api/search` | local-DB fallback mapped to the AniList shape; `console.log('❌ AniList failed, using local database fallback')` |
| `/api/anime/:id` | **500** — no fallback; the detail page shows its error state |

### 1.4 Console output style (CURRENT)
Emoji-prefixed logs (`❌`, `🔎`, `✅`, `🚀`) and `console.warn`/`console.error`. Some are user-visible only to developers. Tests assert the server prints `Server: <url>` on boot (the readiness signal).

## 2. Client-side behaviour (CURRENT)

| Area | Handling |
| --- | --- |
| Search | Skeleton grid → results; **error state** with message "Could not load search results…" and a **Retry** button; separate no-results and filter-empty states; result-count live region |
| Search autocomplete | Aborts stale requests; on failure shows "Suggestions unavailable. Press Enter to search." |
| Detail page | Full-page loading text → content; **error state** "Failed to load anime details." with "Back to Home" |
| Watchlist | Unreadable local data is logged and treated as empty; cloud load failure → toast "Could not load your cloud watchlist…"; toggle failure → toast "Could not update your watchlist…" |
| Auth | Modal error region (live) shows provider or configuration messages; deletion failures use `alert()`; migration failures dispatch an error toast |
| Toast | Text-only messages, auto-dismiss after 3 s, single element |
| SEO/site-config | `legal.js` failure only logs to console |

## 3. Silent failures (GAP — no user-visible state)

| Location | Behaviour today |
| --- | --- |
| `loadPopular()` (`script.js`) | `catch` logs to console only. If `/api/popular` fails, **skeleton cards remain on screen** and the catalog stays empty; no message, no retry |
| `loadMovies()` | `catch` logs to console only → page can stay on skeletons |
| `loadSeries()` | Same as movies |
| `filterByGenre()` | `catch` logs to console only → grid can stay on skeletons after a genre click |
| `loadTrending()` | Renders "Unable to load trending items." inside the grid (partial handling) |
| `legal.js` (contact/DMCA) | Falls back to the "not configured" text silently |
| `updatePageSeo()` schema injection | No failure path; runs inline |

## 4. What is missing (NOT IMPLEMENTED)

- No retry/backoff for AniList calls; no circuit breaker.
- No user-visible error for the main catalog path (the most important silent failure).
- No error boundaries/section-level fallback beyond the search and detail pages.
- No telemetry of client errors (no error reporting service).
- No standard error payload documented in a schema (only `{ message }` by convention).
- No timeouts documented for client fetches (browser defaults apply).

## 5. NOT FOUND / NEEDS CONFIRMATION

- Whether an error-reporting service should be introduced (currently none, consistent with the no-analytics policy).
- Supported-browser matrix for graceful degradation.
