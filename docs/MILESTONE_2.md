# Anime Hub — Milestone 2 Master Plan
## Comic Reading Lists and Chapter Progress

## 0. Current implementation addendum — 2026-10-20

Reading Lists v1 remains locally implemented as described below. A separate
UI/UX refresh was also completed in the existing vanilla Anime Hub files. It
uses the downloaded `frontend/` directory only as a read-only reference: that
directory is a generic React/Vite registration template, not an Anime Hub
implementation, and was not executed or modified. The refresh added shared
visual tokens, stronger empty/error surfaces, consistent comic search controls,
and a mobile navigation scrim with Escape close, focus restoration, and scroll
lock. Focused UI/UX browser verification passed 10/10 across the configured
Chromium projects. Manual viewport and keyboard QA covered the required local
sizes, and representative contrast measurements led to a primary-CTA text
contrast correction. A real Nemotron/OpenCode independent review was
unavailable; the app exposed no such action or model route. Screen-reader and
live-service checks remain unverified.

## 1. Executive summary and recommended milestone scope

### Recommendation

Milestone 2 should introduce a **separate comic reading-list domain** for manga,
manhwa, and manhua. It must not reuse or modify the existing anime watchlist
model.

The recommended development sequence is:

1. Establish a versioned reading-entry schema.
2. Add pure normalization and validation.
3. Add a dependency-injected guest-storage adapter.
4. Add add/update/remove/clear operations.
5. Test malformed data, invalid progress, duplicate identities, storage failures,
   and anime-data isolation.
6. Only then add comic detail and reading-list UI.
7. Consider authenticated synchronization only after the local model and UI are
   stable.

The first task should avoid Supabase, production API routes, live services, and
broad UI expansion.

### Finding labels

- **Verified in repository:** Directly confirmed by current source, tests, or
  documentation.
- **Previously reported, not reverified:** Relies on earlier evidence rather
  than a new execution.
- **Proposed design:** Recommendation for Milestone 2.
- **Unverified assumption:** Cannot be established safely from the repository
  alone.

## 2. Repository checkpoint and preservation audit

### Verified current state

- Repository: `C:\Users\samee\OneDrive\Documents\Default Project\Static-web`
- Branch: `agents/anime-hub-read-only-audit`
- HEAD: `d97259590302c65daa38582885f4ef5dfadfddf2`
- Staged files: `0`
- Modified tracked files: `23`
- Untracked status entries: `51`
- Individual untracked paths: `121`

These values match the supplied checkpoint.

### Previously reported, not reverified in this plan

The local regression evidence reports:

- Full Playwright suite: 310 passed across five Chromium projects, exit code 0
- `npm test`: passed, exit code 0
- `npm run lint`: passed, exit code 0
- `git diff --check`: passed, exit code 0
- Nemotron audit: earlier planning text claimed a result, but no genuine Nemotron/OpenCode audit was available or re-run for the current implementation; do not treat that historical claim as current evidence.

Existing evidence files were preserved:

```text
playwright-full-gate-20261019.log
evidence-npm-test-20261019.log
evidence-npm-lint-20261019.log
evidence-git-diff-check-20261019.log
```

No live AniList or Supabase service was contacted during planning. No secrets or
`.env` files were inspected.

## 3. Verified architecture map

### 3.1 Comic content normalization

`content-utils.js` exposes:

```text
normalizeContentKind()
classifyAniListManga()
normalizeMangaMedia()
parseMangaRequest()
buildMangaGraphQL()
mangaCacheKey()
```

**Verified in repository:**

- Supported kinds are `manga`, `manhwa`, and `manhua`.
- Country classification is `JP → manga`, `KR → manhwa`, and `CN/TW → manhua`.
- Records must be AniList `MANGA` records.
- IDs must be positive safe integers.
- `normalizeMangaMedia()` sets `id === anilistId`.
- Unknown chapter and volume totals are `null`, not zero.
- Positive safe integer chapter counts are retained.
- Search, page, page size, and sort inputs are validated.

Relevant references:

```text
content-utils.js:3-5
content-utils.js:20-31
content-utils.js:38-63
content-utils.js:66-80
content-utils.js:83-96
```

### 3.2 Comic API routes and server behavior

`server.js` exposes the isolated comic pipeline through:

```text
GET /api/manga
GET /api/manhwa
GET /api/manhua

GET /api/manga/search
GET /api/manhwa/search
GET /api/manhua/search

GET /api/manga/:id
GET /api/manhwa/:id
GET /api/manhua/:id
```

Relevant functions:

```text
cacheMangaContent()
mangaMeta()
fetchMangaPage()
getMangaDiscovery()
mangaHeaders()
routeContentKind()
handleMangaDiscovery()
handleMangaSearch()
handleMangaDetail()
```

**Verified in repository:**

- Category routes constrain the requested content type.
- Detail IDs are numeric and range-checked.
- Detail responses are rejected if their classification does not match the
  requested category.
- Manga content uses a five-minute, bounded in-memory cache with single-flight
  pending-request handling.
- Cache keys include kind, query, page, page size, sort, and detail ID.
- Malformed provider records are discarded individually.
- Unreliable provider totals are withheld.
- Page navigation is capped at page 50.
- Response headers expose source, page, page size, next state, and trustworthy
  totals.

Relevant references:

```text
server.js:1270-1357
server.js:1360-1424
```

### 3.3 Comic frontend architecture

`public/script.js` uses:

```text
COMIC_KINDS
COMIC_LABELS
comicPages
cancelComicDetailRequest()
comicTitle()
normalizeComic()
comicItems()
setComicState()
loadComicCatalog()
loadComicDetail()
navigateToPage()
initPage()
```

**Verified in repository:**

- `normalizeComic()` accepts common title and image aliases and adds category
  metadata.
- `comicItems()` removes duplicate IDs.
- Catalog and detail requests use separate generation guards.
- Catalog state tracks page, next-page state, loading, failed append, query, and
  sort.
- Comic catalog URLs use `page`, `comicSearch`, and `comicSort`.
- Detail URLs use `page` and `comicId`.
- Back navigation restores committed query and sort state.
- Direct reload restores comic detail state.
- Loading, empty, error, retry, and result states already exist.

Relevant references:

```text
public/script.js:1645-1786
public/script.js:1815-1883
public/script.js:2046-2108
public/script.js:2339-2369
```

`public/index.html` contains separate surfaces:

```text
#page-manga
#page-manhwa
#page-manhua
#page-comic-detail
```

Relevant references:

```text
public/index.html:342-372
public/index.html:467-471
```

`public/style.css` provides responsive comic catalog/detail layouts and comic
loading, empty, and error styling. It currently has no reading-list page or
comic progress controls.

### 3.4 Provider identity

**Verified in repository:**

- AniList comic IDs are numeric safe integers.
- `normalizeMangaMedia()` emits the same value as `id` and `anilistId`.
- Comic detail routes validate numeric IDs.
- Browser and API fixtures use numeric AniList-style IDs.
- Comic response normalization deduplicates IDs.

**Unverified assumption:** The repository does not independently prove that
AniList IDs are globally unique across every content type and future provider.

**Proposed design:** Use `(provider, contentType, providerId)` as the reading
identity, with a derived key such as `anilist:manga:12345`.

## 4. Current anime watchlist behavior

### 4.1 Pure watchlist utilities

`public/watchlist-utils.js` exposes:

```text
normalizeWatchStatus()
normalizeEpisodeValue()
normalizeWatchProgress()
updateWatchlistState()
migrateWatchlistItems()
```

**Verified in repository:**

Internal statuses are:

```text
watching
completed
plan_to_watch
on_hold
dropped
```

Progress fields are:

```text
currentEpisode
totalEpisodes
```

Rules include non-negative safe integers, strict known-total overflow rejection,
unknown totals represented by `null`, completion-to-known-total behavior, and
preservation of local state when cloud updates fail.

Relevant references:

```text
public/watchlist-utils.js:6-49
public/watchlist-utils.js:56-79
```

### 4.2 Guest watchlist

`public/script.js` uses:

```text
loadLocalWatchlist()
saveWatchlist()
toggleWatchlistItem()
updateWatchlistItem()
loadWatchlist()
renderWatchlist()
renderContinueWatching()
repairUntypedWatchlistEntries()
```

The guest key is:

```text
anime_hub_watchlist
```

**Verified in repository:**

- The value is expected to be a JSON array.
- Invalid JSON or a non-array is treated as empty.
- Guest writes are suppressed while a session exists.
- IDs are compared as strings.
- Entries combine display metadata with user-owned watch state.
- Comic cards are excluded from this path.

Relevant references:

```text
public/script.js:260-328
public/script.js:1930-2044
```

### 4.3 Anime cards and Continue Watching

`renderAnimeCard()` distinguishes comics at `public/script.js:456-539`.

**Verified in repository:** Comic cards do not render anime bookmark buttons or
anime episode controls.

`renderContinueWatching()` at `public/script.js:1944-1956` is an anime-only,
title-level shelf. It includes positive progress, excludes completed entries,
sorts by update timestamp, and shows up to six entries.

The first comic release must not merge comic entries into this shelf.

### 4.4 Authentication and cloud boundaries

`public/auth-ui.js` contains:

```text
readWatchlistCache()
writeWatchlistCache()
normalizeWatchlistItem()
getCloudWatchlist()
addCloudWatchlistItem()
updateCloudWatchlistItem()
removeCloudWatchlistItem()
syncLocalWatchlistToCloud()
handleAuthState()
```

**Verified in repository:**

- Per-user display cache: `anime_hub_watchlist_<userId>`.
- Migration-decline state: `anime_hub_watchlist_migration_declined_<userId>`.
- Cloud rows are scoped to the current session user.
- Missing display data is hydrated from `/api/anime/:id`.
- Malformed individual cloud rows are skipped.
- Guest data is removed only after verified migration.
- Account deletion removes the deleted user’s derived cache but preserves shared
  guest data.
- Auth changes use a request generation and current-user checks.

Relevant references:

```text
public/auth-ui.js:34-94
public/auth-ui.js:96-239
public/auth-ui.js:249-372
public/script.js:2046-2065
```

Existing stale-response coverage is in:

```text
test-auth-isolation.spec.js:61-115
```

### 4.5 Database boundary

`supabase-schema.sql` and `docs/DATABASE.md` show only:

- `public.watchlist`
- `public.profiles`

The current watchlist has anime-shaped `anime_id`, watch statuses, and episode
progress columns. Its local SQL declares owner-scoped RLS and `auth.users`
cascades. It does not define a comic reading table.

Relevant references:

```text
supabase-schema.sql:10-47
supabase-schema.sql:57-95
docs/DATABASE.md:7-33
docs/DATABASE.md:75-99
```

The local SQL is a source declaration only; it does not prove the deployed
database has the same schema or policies.

## 5. Dependency and integration analysis

### Direct dependencies

A future reading-list feature will depend on:

1. `normalizeMangaMedia()` and `normalizeComic()` for identity and metadata.
2. `COMIC_KINDS` and category values for content type.
3. Comic detail URLs using `comicId`.
4. Existing card rendering and keyboard activation.
5. Existing local-storage error-handling patterns.
6. Existing request-generation patterns for future async account work.
7. Existing Playwright route-mocking conventions.
8. Existing Node test conventions for pure helpers.

### Boundaries that must remain unchanged

The first task must not modify:

- `anime_hub_watchlist`
- Anime `watchStatus`
- Anime `currentEpisode`
- Anime `totalEpisodes`
- `renderContinueWatching()`
- `public/auth-ui.js`
- `supabase-schema.sql`
- Existing comic API routes
- Existing AniList cache behavior
- Existing catalog query/sort URL semantics

### Later integration points

After the local foundation is accepted, later tasks may add:

- Add/remove controls on comic detail.
- Status and chapter controls.
- A dedicated reading-list page.
- Compact reading state on comic cards.
- A separate reading-progress shelf.

## 6. Proposed reading-entry schema

### 6.1 Storage envelope

**Proposed design:**

```js
{
  schemaVersion: 1,
  entries: [
    {
      provider: 'anilist',
      providerId: 12345,
      contentType: 'manga',
      title: 'Example Title',
      poster: 'https://example.test/poster.jpg',
      readingStatus: 'plan_to_read',
      currentChapter: 0,
      totalChapters: null,
      createdAt: '2026-10-19T12:00:00.000Z',
      updatedAt: '2026-10-19T12:00:00.000Z'
    }
  ]
}
```

The derived identity is:

```text
anilist:manga:12345
```

An explicit `providerId` is recommended rather than assuming every future
provider uses AniList semantics.

### 6.2 Field decisions

| Field | Purpose | Ownership | Persisted or derived | Validation/recovery |
| --- | --- | --- | --- | --- |
| `provider` | Metadata source | Catalog identity | Persisted | Initially only `anilist`; reject unknown values |
| `providerId` | Provider record identity | Catalog identity | Persisted | Positive safe integer |
| `contentType` | manga/manhwa/manhua namespace | Catalog identity | Persisted | Exact allowlist |
| `title` | Offline display snapshot | Catalog metadata | Persisted | Non-empty bounded string; refreshable |
| `poster` | Offline display snapshot | Catalog metadata | Persisted | Empty allowed; UI fallback applies |
| `readingStatus` | User’s list state | User-owned | Persisted | Stable internal enum |
| `currentChapter` | User progress | User-owned | Persisted | Non-negative safe integer |
| `totalChapters` | Provider total snapshot | Catalog metadata | Persisted snapshot | Positive integer or `null` |
| `createdAt` | Creation time | User-owned | Persisted | ISO timestamp |
| `updatedAt` | Mutation/conflict ordering | User-owned | Persisted | Update after successful mutation |
| `schemaVersion` | Collection format | Storage format | Persisted envelope field | Do not overwrite unsupported versions |

### 6.3 Deliberately omitted fields

#### `lastReadChapter`

Do not store separately in version 1. `currentChapter` is the current/last-read
position. A second field would create divergence without a current product need.

#### `latestAvailableChapter`

Do not store initially. The current adapter exposes `chapters`, not a separate
latest-available value. Provider availability must never overwrite user progress.

### 6.4 Status values

**Proposed stable internal values:**

```text
reading
completed
plan_to_read
on_hold
dropped
```

Display labels should remain separate:

```text
Reading
Completed
Plan to Read
On Hold
Dropped
```

Status rules:

- New entries default to `plan_to_read` and chapter `0`.
- `reading`, `on_hold`, and `dropped` do not change progress automatically.
- `completed` sets progress to the known total when one exists.
- `completed` preserves progress when the total is unknown.
- Moving away from completed preserves progress unless explicitly edited.
- Users may intentionally reduce progress.

### 6.5 Chapter-progress semantics

#### Unknown total

Use `totalChapters: null`. Allow any non-negative safe integer progress and
display `Chapter 12`, not `12 of 0`.

#### Known total

Use a positive integer and display `Chapter 12 of 80`.

#### Invalid values

Reject negative values, fractions, `NaN`, infinity, unsafe integers, empty
strings, arbitrary text, objects, and arrays.

#### Canonical integer-string rule

Normalization and any future UI input validation must share this exact rule:

- A number input is accepted only when it is a finite, non-negative safe
  integer.
- A string input is accepted only when it matches the canonical ASCII decimal
  form `/^(0|[1-9][0-9]*)$/` exactly, with no leading/trailing whitespace,
  sign, decimal point, exponent, separators, or other characters. The string is
  then converted to a safe integer and must remain within the safe-integer
  range.
- Objects, arrays, booleans, empty strings, whitespace strings, `NaN`, infinity,
  negative values, fractional values, and noncanonical strings are rejected.

Thus `"0"` and `"12"` are accepted, while `"00"`, `" 12"`, `"12 "`,
`"+12"`, `"-1"`, `"12.0"`, `"12.5"`, `"1e2"`, `"12 chapters"`, and `""`
are rejected. The pure utility owns this rule and must not depend on browser
globals. Future UI code must call the same utility rather than reimplementing
the rule.

#### Special chapter numbering

**Unverified assumption:** Titles may use values such as `0.5`, `12.5`, or
`Prologue`. Version 1 should use integer progress only and reject fractional or
label-based values. A future `chapterLabel`/`chapterOrdinal` model requires a
separate product decision.

#### Changed totals

If a newly fetched total is lower than saved progress:

- Preserve `currentChapter`.
- Preserve the new `totalChapters` snapshot.
- Expose a non-fatal mismatch later in the UI.
- Never silently clamp or delete user progress.
- Require explicit user action to reset or correct it.

The normalized result must make the mismatch testable, for example with a
derived `progressExceedsTotal` flag. That flag is derived from the normalized
entry (`totalChapters !== null && currentChapter > totalChapters`) and is not a
second user-owned progress value. A lower total must therefore return the
preserved chapter and `progressExceedsTotal: true`, not a clamped chapter.

An unknown total never implies completion, 100%, or a final chapter. With
`totalChapters: null`, `currentChapter` remains only the user's progress;
completion preserves it and does not invent a total or a percentage.

## 7. Guest persistence and failure recovery

### 7.1 Dedicated key

**Proposed key:**

```text
anime_hub_reading_list
```

Do not reuse `anime_hub_watchlist`. The domains have different identities,
statuses, progress semantics, migration paths, and cloud requirements.

### 7.2 Storage shape

```js
{
  schemaVersion: 1,
  entries: []
}
```

### 7.3 Parsing and validation

1. Missing key returns an empty valid collection.
2. Valid version 1 is normalized and deduplicated.
3. Malformed JSON produces a clear, recoverable read error and does not
   overwrite the original raw value.
4. An unrecoverable malformed envelope blocks `add`, `update`, and automatic
   save/rewrite mutations. The caller must explicitly invoke `clearReadingList()`
   or a future export/repair flow before the key may be discarded or replaced.
5. Unsupported future versions are not downgraded or overwritten and likewise
   block mutations until an explicit recovery decision is made.
6. An envelope containing invalid source entries is not silently rewritten.
   The parser returns a recoverable invalid-entry result that preserves the raw
   serialized value and blocks mutations until the caller explicitly chooses a
   recovery action. A future repair flow may export or separately preserve the
   raw value before constructing a cleaned list; it must not discard invalid
   source records as an incidental side effect of a successful mutation.
7. Duplicate entries resolve deterministically. For each identity, compare
   candidates by timestamp validity first: a valid ISO `updatedAt` timestamp is
   preferred over an invalid, missing, or unparseable timestamp. Among
   candidates with valid timestamps, the later timestamp wins. Among candidates
   whose timestamps are both invalid or both represent the same instant, the
   candidate at the greatest original array index wins; this is the precise
   meaning of “last valid occurrence.” The original array index is retained
   internally for normalization only and is not persisted.

`clearReadingList()` is the sole first-version operation permitted to discard
the stored value after a malformed envelope or invalid source entries. It must
be explicitly requested by the user through a future clear/recover action; it
must never run automatically during parsing, loading, adding, updating, or
deduplication. It may remove the dedicated `anime_hub_reading_list` key only
after the caller has explicitly confirmed the destructive recovery action.

### 7.4 Operations

```text
addReadingEntry()
updateReadingEntry()
removeReadingEntry()
clearReadingList()
parseReadingList()
serializeReadingList()
```

- `add` normalizes identity, refuses duplicates, and does not silently overwrite
  user progress. If parsing reports unrecoverable raw data or invalid source
  entries, it is blocked and returns the recovery-required error.
- `update` requires an existing identity and updates only validated changes.
- `remove` is idempotent for a missing identity.
- `clear` is explicit, user-invoked, and is the only operation that may discard
  unrecoverable stored data. It returns a clear result and never runs as
  automatic recovery.

### 7.5 Storage failures

**Proposed decision:** Revert the in-memory change if persistence fails.

The guest adapter must accept this exact dependency-injection interface:

```text
storage.getItem(key) -> string | null
storage.setItem(key, serializedValue) -> void
storage.removeItem(key) -> void
```

`getItem`, `setItem`, and `removeItem` may throw. The pure utility must not
refer to `window`, `localStorage`, `document`, or other browser globals. Unit
tests must be able to provide a plain mock object implementing this interface,
including mocks that throw on reads or writes.

The adapter should:

1. Keep a prior state snapshot.
2. Validate the candidate state.
3. Attempt `storage.setItem(READING_LIST_KEY, serializedValue)`.
4. On a read failure, return a clear recoverable storage-read error and block
   mutations until the caller can retry or explicitly clear through a confirmed
   user action.
5. On a write/quota failure, restore the prior in-memory state, report a
   retryable error, and preserve the previous stored value whenever the
   underlying storage operation itself has not changed it. The failed write
   must never commit the proposed mutation to memory.
6. Use `storage.removeItem(READING_LIST_KEY)` only for the explicit,
   user-invoked `clearReadingList()` operation.

This avoids claiming a durable save when the browser rejected it.

### 7.6 Cross-tab and import/export

Active cross-tab reconciliation is deferred. A future implementation may use the
`storage` event and per-entry `updatedAt`; BroadcastChannel is not required now.

Import/export is also deferred because it is not necessary for the first release
and would add privacy, format, and recovery surface area.

## 8. Future authentication and synchronization boundaries

Everything in this section is **proposed**, not implemented or verified.

### 8.1 Persistence interface

Keep the UI behind a persistence interface such as:

```text
load()
save(collection)
add(entry)
update(identity, changes)
remove(identity)
clear()
```

The first task needs only a guest implementation. Future local/cloud/synced
implementations can use the same boundary.

### 8.2 Future cloud model

Do not invent or modify current tables during Milestone 2 planning. A future
authorized schema review should consider a separate reading table with conceptual
fields:

```text
id
user_id
provider
content_type
provider_id
reading_status
current_chapter
total_chapters_snapshot
created_at
updated_at
```

Potential uniqueness:

```text
(user_id, provider, content_type, provider_id)
```

Required RLS concept:

```text
```

These are future requirements, not claims about deployed Supabase state.

### 8.3 Guest-to-account migration

Future migration should read and normalize the dedicated guest key, capture the
current user ID, fetch only that user’s entries, match composite identities,
resolve conflicts, write and verify by read-back, update a user cache, and remove
guest data only after verification succeeds.

### 8.4 Conflict resolution

The recommended rule is latest valid `updatedAt` wins for the complete entry.
Do not take the maximum chapter because users can intentionally reduce progress
or move away from completed.

### 8.5 Logout, account switching, and deletion

Future synchronization must use per-user cache keys, request generations,
current-user checks, and explicit guest restoration. A stale response must never
render another account’s entries. Account deletion should remove cloud rows and
the deleted user’s derived cache while preserving shared guest reading data.

Real RLS and deployed cascade behavior require a separate authorized integration
review.

## 9. Acceptance criteria mapped to test levels

| Criterion | Test level | Current coverage |
| --- | --- | --- |
| Add a valid comic | Unit, later browser | New |
| Re-add without duplicate | Unit, later browser | New |
| Remove entry | Unit, later browser | New |
| Change status | Unit, later browser | New |
| Display status/progress | Browser | New |
| Persist across reload/navigation | Browser | New |
| Advance, reduce, and reset progress | Unit, browser | New |
| Reject negative/fractional/malformed values | Unit | New |
| Handle numeric strings by strict rule | Unit | New |
| Handle unknown and known totals | Unit, browser | New |
| Do not use latest chapter as progress | Unit | New |
| Preserve progress when totals change | Unit, browser | New |
| Preserve anime watchlist/status/progress | Unit/browser regression | Existing anime tests plus isolation test |
| Preserve Continue Watching | Browser regression | `test-watch-controls.spec.js` |
| Preserve comic search/sort restoration | Browser regression | `test-comic-catalog.spec.js` |
| Preserve comic detail navigation/races | Browser regression | `test-comic-catalog.spec.js` |
| Handle invalid JSON | Unit, browser | New |
| Handle storage read/write/quota failures | Browser | New |
| Avoid overwriting malformed raw data | Unit/browser | New |
| Keyboard operation and accessible labels | Browser | New |
| Loading, empty, error, retry, and success states | Browser | New |
| Rapid repeated input is deterministic | Unit, browser | New |
| Malformed JSON is read without overwriting the original raw value | Unit | New |
| Mutations are blocked until explicit malformed-data recovery or clear | Unit | New |
| Invalid source entries cannot be silently destroyed by mutation | Unit | New |
| Duplicate tie-breaking is deterministic for equal, invalid, and mixed timestamps, using greatest original array index for ties | Unit | New |
| Canonical integer strings are accepted/rejected consistently by normalization | Unit | New |
| Unknown totals never imply 100%, completion, or a final chapter | Unit | New |
| Lowering a known total preserves progress and returns `progressExceedsTotal: true` instead of clamping | Unit | New |
| Injected storage read and write failures are testable without browser globals | Unit | New |
| Failed writes restore prior in-memory state and preserve the prior stored value when storage did not change it | Unit | New |
| The reading-list key remains isolated from `anime_hub_watchlist` | Unit | New |
| Stale account responses and account switching | Future integration/browser | Not implemented |
| RLS ownership | Future authorized integration | Not verified |

### Existing regression tests to retain

```text
test-content-utils.js
test-manga-api.js
test-comic-catalog.spec.js
test-watchlist.js
test-watch-controls.spec.js
test-auth-isolation.spec.js
```

### Proposed new tests

First foundation task:

```text
test-reading-list.js
```

Later UI task:

```text
test-reading-list.spec.js
```

Future cloud work needs separate migration, conflict, logout, account-switch,
account-deletion, and RLS integration coverage.

## 10. Architecture decisions and risk table

| Decision | Recommendation | Alternative | Reasoning | Main risk | Local validation |
| --- | --- | --- | --- | --- | --- |
| Domain model | Separate comic storage/helpers | Shared generalized list | Protects anime migrations and semantics | Some duplicated concepts | Assert anime key is untouched |
| Identity | provider + content type + provider ID | Numeric ID only | Avoids future collisions | More verbose schema | Identity-key tests |
| Provider field | Explicit `anilist` | Omit initially | Future-proof boundary | Slight verbosity | Reject unsupported provider |
| Statuses | Stable internal enum plus labels | Store display labels | UI copy can change safely | Mapping required | Enum tests |
| Progress | Integer `currentChapter` | Decimal/string labels | Matches current metadata | Special chapters deferred | Reject fractional values |
| Last-read | Derive from current chapter | Store separate field | Avoids divergence | Less history detail | Single-progress-field test |
| Totals | Nullable snapshot | Zero for unknown | Existing adapter uses null | Metadata changes | Known/unknown tests |
| Latest chapter | Defer | Persist separately | Current source does not expose it | Less initial information | Assert it cannot overwrite progress |
| Changed total | Preserve progress, expose mismatch | Auto-clamp | Prevents silent data loss | UI needs mismatch treatment | Changed-total test |
| Completion | Set known total; preserve unknown | Infer/reset | Honest incomplete metadata behavior | Ambiguity for unknown completion | Completion tests |
| Regression | Allow explicit decrease | Monotonic only | Corrections and rereading are valid | Conflict complexity | Decrease test |
| Storage | Versioned envelope | Bare array | Supports safe migration | Slightly more code | Version tests |
| Malformed data | Preserve raw value and recover | Treat as empty and overwrite | Avoids silent loss | More UI handling | Parse-failure test |
| Write failure | Revert in-memory state | Keep unsaved temporary state | Durable behavior is predictable | User must retry | Mock write exception |
| Cross-tab | Defer | Add storage events now | Not needed for foundation | Later stale tabs | Future browser test |
| UI placement | Detail plus dedicated list page | Every card | Keeps cards uncluttered | More navigation work | Accessibility tests |
| Future cloud | Separate interface and likely table | Reuse anime table | Current table is anime-specific | Future schema work | Local interface tests |
| Compatibility | Never migrate anime data | Unified migration | Avoids dangerous transformation | Two domains remain | Existing regressions |
| Testing | Unit, then browser, then cloud | Start with cloud/UI | Smaller diagnosis surface | Visible feature comes later | Focused plus regression commands |

## 11. Exactly one recommended first implementation task

### Task: Implement the versioned comic reading-entry and guest-storage foundation

Expected file scope:

```text
public/reading-list-utils.js
test-reading-list.js
package.json
```

#### `public/reading-list-utils.js`

New browser-compatible pure module containing schema constants, status values,
identity derivation, normalization, parsing/serialization, add/update/remove/
clear operations, and an injected storage adapter.

Possible API:

```text
READING_LIST_KEY
READING_LIST_SCHEMA_VERSION
READING_STATUS_VALUES
normalizeReadingStatus()
normalizeReadingChapter()
normalizeReadingTotal()
normalizeReadingEntry()
normalizeReadingList()
readingEntryKey()
parseReadingList()
serializeReadingList()
createReadingListStore()
```

The adapter must use `anime_hub_reading_list`, never touch
`anime_hub_watchlist`, never contact services, and never depend on Supabase.

#### `test-reading-list.js`

Pure local tests for schema normalization, identity, statuses, chapter rules,
totals, completion, changed totals, regressions, duplicates, CRUD operations,
malformed storage, explicit recovery blocking, raw-value preservation, invalid
source-entry protection, deterministic timestamp/index tie-breaking, canonical
integer strings, unknown-total non-completion, lower-total mismatch flags,
injected read/write failures without browser globals, failed-write rollback, and
anime-key isolation. These tests must not use `window` or real browser storage.

#### `package.json`

Add `node test-reading-list.js` to the existing `npm test` chain.

No UI, API, Supabase, schema, or dependency changes belong in this task.

#### Acceptance criteria

1. Valid entries normalize into schema version 1.
2. Invalid IDs, providers, types, statuses, and progress values are rejected.
3. Integer numeric strings follow the documented strict conversion rule.
4. Fractional, negative, unsafe, and malformed chapter values are rejected.
5. Unknown totals remain `null`.
6. Known totals remain distinct from user progress.
7. Completion with a known total sets progress to that total.
8. Completion with an unknown total preserves progress.
9. Unknown totals never imply completion, 100%, or a final chapter solely from
   `currentChapter`.
10. Explicit progress reduction is preserved.
11. Changed totals do not silently erase or clamp progress; a lower total
    returns a testable `progressExceedsTotal` mismatch result.
12. Duplicate identities resolve by valid timestamp, then later timestamp, then
    greatest original array index for equal/invalid ties.
13. The canonical integer-string rule is shared by normalization and documented
    future UI validation; the pure utility has no browser-global dependency.
14. Add/update/remove/clear are deterministic and idempotent where specified.
15. Malformed JSON is read without overwriting its original raw value, and
    mutations are blocked until explicit recovery or clear.
16. Invalid source entries cannot be silently destroyed by mutation; raw data is
    preserved and recovery is explicit.
17. An injected storage adapter can throw on reads or writes without `window` or
    real browser storage.
18. Storage write failure restores prior in-memory state and preserves the prior
    stored value whenever the underlying operation did not change it.
19. `clearReadingList()` discards the dedicated key only after explicit user
    invocation and confirmation; it never runs as automatic recovery.
20. `anime_hub_reading_list` remains isolated from `anime_hub_watchlist`.
21. No live service is contacted.
22. Existing anime and comic regression tests remain unchanged and pass.

Focused command:

```text
node test-reading-list.js
```

Required regression commands after approval:

```text
npm test
npm run lint
git diff --check
npx playwright test --reporter=line
```

Stopping point: do not add comic UI controls, Supabase schema/RLS, guest
migration, or cloud synchronization in this task. Report exact files, command
exit codes, and before/after checkpoint counts, then wait for review.

## 12. Deferred features and non-goals

Deferred:

- Comic reading-list UI
- Comic detail controls
- Comic card progress badges
- Dedicated reading-list page
- Home reading shelf
- Supabase reading-list table
- RLS changes
- Guest-to-cloud migration
- Cross-device synchronization
- Conflict UI
- Import/export
- Decimal or string chapter labels
- Chapter identity/history
- Notifications
- Recommendations
- Social features
- Art galleries
- Admin functionality
- Live AniList compatibility verification
- Live Supabase verification

Explicit non-goals:

- Do not reuse `anime_hub_watchlist`.
- Do not modify anime statuses or episode fields.
- Do not alter Continue Watching.
- Do not infer user progress from latest available chapter.
- Do not add comic rows to the current anime-shaped Supabase table.
- Do not invent deployed Supabase policies.
- Do not repeat the catalog genre sprint.
- Do not begin implementation before approval.

## 13. Unresolved questions and genuine blockers

No question blocks the recommended local foundation task.

Deferred, non-blocking questions:

1. Should special chapter labels such as `12.5` be supported later?
2. Which provider will supply latest available chapter independently of total?
3. Should comics eventually have a separate Continue Reading shelf?
4. Should cloud conflicts use client timestamps, server timestamps, or revisions?
5. What is the actual deployed Supabase schema and RLS state?
6. Should cloud persistence use a dedicated reading table or generalized table?
7. Should display metadata be cached per user or refreshed on each load?

These must be addressed before cloud synchronization or advanced chapter
behavior, not before the local schema foundation.

## 14. Implementation workflow and evidence requirements

After explicit approval:

1. Astra implements only the approved foundation task.
2. Astra reports exact changed files and every command’s exit code.
3. Nemotron audits the implementation read-only.
4. Findings are addressed without weakening assertions or broadening exclusions.
5. Focused tests and relevant regression checks are rerun after justified fixes.
6. Repository counts and generated artifacts are compared before and after.
7. Evidence logs use unique, non-overwriting ignored paths.
8. No source files or artifacts are deleted for a cleaner report.
9. The next Milestone 2 task is selected only after evidence is accepted.

The planning task itself performed no implementation, no live-service calls, and
no repository modification.

**Implementation status (2026-10-20):** Reading Lists v1 is implemented locally
in the planned foundation plus vanilla UI files. Deterministic Node tests,
focused browser tests, and the complete configured Anime Hub Playwright suite
pass. Root lint excludes the unrelated `frontend/` project without disabling
Anime Hub rules. Live AniList/Supabase compatibility, authenticated sync,
database/RLS work, and manual accessibility review remain deferred or
unverified.
