# WATCH_SYSTEM — watchlist, progress, history, continue watching

> Snapshot: 2026-10-05. This document states clearly what exists and what does not.
> Legend: **CURRENT** · **PLANNED** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Current status at a glance

```text
Watchlist              = IMPLEMENTED   (guest-local + signed-in cloud)
Watch Progress         = IMPLEMENTED   (status + current episode)
Watch History          = NOT IMPLEMENTED   (approved to build — decision 2026-10-05)
Continue Watching      = NOT IMPLEMENTED   (approved to build — decision 2026-10-05)
Episode-level tracking = NOT IMPLEMENTED   (title-level current episode only)
```

The current UI supports title-level status and current-episode progress. It does not promise playback position, watch history, or continue watching; those remain separate future features.

## 2. Watchlist (CURRENT) — implemented behaviour

### 2.1 Guest (no account)
- Stored in `localStorage` under `anime_hub_watchlist` as an array of card objects (`id`, `title`, `poster`/`image`, `rating`, `type`, catalog `status`, `episodes`, `genres`, `watchStatus`, `currentEpisode`, `totalEpisodes`).
- `id` is the card's canonical value: `anime.anilistId || anime.id`.
- Toggled from the star on any card and from the detail page button; the Watchlist page renders the array with an empty state when it is empty.
- Guarded parsing: a corrupt value is logged and treated as empty (the raw value is left untouched).

### 2.2 Signed-in (cloud)
- Stored in Supabase `public.watchlist` as one row per `(user_id, anime_id)` with `watch_status`, `current_episode`, `total_episodes`, and `updated_at`; RLS restricts every operation to `auth.uid() = user_id` (see `docs/DATABASE.md`).
- Add: `upsert(..., { onConflict: 'user_id,anime_id', ignoreDuplicates: true })` with default progress values.
- Update: status and episode progress use an RLS-protected update filtered by the current session user and AniList ID.
- Remove: `delete().eq('user_id', …).eq('anime_id', …)`.
- Display data is cached per user in `localStorage` under `anime_hub_watchlist_<userId>`; any row without cached display data is hydrated through `GET /api/anime/:id` and validated (returned id must match the requested id).

### 2.3 Migration (guest → account)
- Triggered on sign-in when a local watchlist exists; asks for consent; upserts only missing rows; verifies by read-back; merges the display cache; removes the local key only after verification.
- Decline is remembered per session; any failure leaves local data intact and shows an error toast.

### 2.4 Not part of the watchlist today
- No "added at" ordering in the UI (`added_at` exists in the database but is unused client-side).
- No notes, ratings, or tags per saved title. Watch status now supports `watching`, `completed`, `plan_to_watch`, `on_hold`, and `dropped`.
- The Watchlist and Detail pages show status and current episode. Selecting `completed` advances to the known total episode count automatically.
- No multi-device conflict resolution beyond "cloud rows win by union".

## 3. Continue Watching — historical record only (NOT CURRENT)

- Commit `816af2e` ("Add continue watching feature", 2026-10-03) implemented a continue-watching UI in the **then-current root** `index.html`, `script.js`, `style.css` (441 inserted lines).
- Those root files were deleted in the `public/` restructure (`dc15de9`, `fdade94`, `8158752`). **The feature does not exist in the current app.**
- The only remnant is a defensive assertion in `test-search.js` that the legacy `localStorage` key `anime_hub_continue_watching` is never removed. Some browsers may still hold that key; nothing reads it.
- **Do not describe continue watching as a current feature anywhere.**

## 4. Watch Progress / History

- Title-level watch progress is implemented in the existing watchlist row and local display cache.
- `current_episode` is a non-negative integer. `total_episodes` is nullable because AniList may not provide a total.
- When a total is known, progress cannot exceed it. Selecting `completed` sets the current episode to that total.
- This is not playback or per-episode history: there is no position, streaming integration, episode identity, or watch-history event log.

## 5. ARCHITECTURE AND REMAINING PLANS

The canonical ID and title-level watch-state decisions below are implemented. Playback, history, and favorites remain separate future scopes.

1. **Canonical anime ID — DECIDED (2026-10-05), IMPLEMENTED (2026-10-06).** All watch data is keyed on the AniList ID, and the local 1–12 id space no longer exists: `ANIME_DB` declares `anilistId` only and every catalog item leaves with `id === anilistId` (`docs/ANIME_DATA.md` §3). Watchlist rows were already AniList-keyed, so **no migration of existing rows is required**.
2. **Episode identity — DECIDED (2026-10-06): numbered `(anime_id, episode_number)` records first.** AniList `streamingEpisodes` is treated as optional later enrichment, not as the identity. Without an episode identity, per-episode resume cannot exist.
3. **Title-level progress — DECIDED and IMPLEMENTED.** `watchlist.watch_status`, `current_episode`, `total_episodes`, and `updated_at` store status and current episode. RLS protects updates; no separate progress table exists yet.
4. **Completion state — DECIDED and IMPLEMENTED.** Selecting `completed` sets `current_episode` to the known total; unknown totals preserve the current episode.
5. **Last-watched timestamp — IMPLEMENTED.** `updated_at` is maintained by the database trigger and is available for future ordering.
6. **Resume position — NOT IMPLEMENTED.** No playback position or duration tracking exists.
7. **History vs Progress — DECIDED (2026-10-06): history is derived from the progress rows.** No separate append-only event log is introduced unless a concrete need appears (e.g. re-watch tracking or explicit "clear history" semantics).
8. **RLS — IMPLEMENTED for title-level progress.** The existing watchlist UPDATE policy uses both `USING` and `WITH CHECK` ownership checks.
9. **Guest behaviour — DECIDED and IMPLEMENTED.** Guests store status and title-level progress in the existing watchlist localStorage record; the verified guest-to-cloud migration carries those fields.
10. **Episode data source and caching.** If episodes come from AniList per title, decide server caching (none exists today for `/api/anime/:id`) and fallback behaviour when AniList is unavailable.
11. **Write path — DECIDED and IMPLEMENTED.** Browser writes use the existing Supabase client directly, with database constraints and RLS enforcement; no new server endpoint was added.
12. **Favorites storage — DECIDED (2026-10-06): one `watchlist` table with a `kind` column**, not a separate favourites table. The uniqueness rule becomes `(user_id, anime_id, kind)` and the RLS policies keep the own-row pattern.

## 6. NOT FOUND / NEEDS CONFIRMATION

- ~~Whether Favorites is part of the product~~ — **DECIDED 2026-10-05: YES**, approved to build (not built yet). Its storage model was decided on 2026-10-06 (§5.12: one `watchlist` table with a `kind` column).
- Whether "continue watching" means resume playback links, a home shelf, or both.
- Whether progress should sync across devices (implied by using Supabase, but not confirmed).
- Any analytics on watch behaviour (none exist; analytics is deliberately absent).
