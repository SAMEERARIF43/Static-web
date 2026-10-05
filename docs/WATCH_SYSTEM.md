# WATCH_SYSTEM — watchlist, progress, history, continue watching

> Snapshot: 2026-10-05. This document states clearly what exists and what does not.
> Legend: **CURRENT** · **PLANNED** · **NOT IMPLEMENTED** · **NOT FOUND / NEEDS CONFIRMATION**.

## 1. Current status at a glance

```text
Watchlist            = IMPLEMENTED   (guest-local + signed-in cloud)
Watch Progress       = NOT IMPLEMENTED
Watch History        = NOT IMPLEMENTED
Continue Watching    = NOT IMPLEMENTED
Episode-level tracking = NOT IMPLEMENTED
```

Nothing in the current UI promises progress, history, or continue watching.

## 2. Watchlist (CURRENT) — implemented behaviour

### 2.1 Guest (no account)
- Stored in `localStorage` under `anime_hub_watchlist` as an array of card objects (`id`, `title`, `poster`/`image`, `rating`, `type`, `status`, `episodes`, `genres`).
- `id` is the card's canonical value: `anime.anilistId || anime.id`.
- Toggled from the star on any card and from the detail page button; the Watchlist page renders the array with an empty state when it is empty.
- Guarded parsing: a corrupt value is logged and treated as empty (the raw value is left untouched).

### 2.2 Signed-in (cloud)
- Stored in Supabase `public.watchlist` as `(user_id, anime_id)` rows with a unique constraint; RLS restricts every operation to `auth.uid() = user_id` (see `docs/DATABASE.md`).
- Add: `upsert(..., { onConflict: 'user_id,anime_id', ignoreDuplicates: true })`.
- Remove: `delete().eq('user_id', …).eq('anime_id', …)`.
- Display data is cached per user in `localStorage` under `anime_hub_watchlist_<userId>`; any row without cached display data is hydrated through `GET /api/anime/:id` and validated (returned id must match the requested id).

### 2.3 Migration (guest → account)
- Triggered on sign-in when a local watchlist exists; asks for consent; upserts only missing rows; verifies by read-back; merges the display cache; removes the local key only after verification.
- Decline is remembered per session; any failure leaves local data intact and shows an error toast.

### 2.4 Not part of the watchlist today
- No "added at" ordering in the UI (`added_at` exists in the database but is unused client-side).
- No notes, ratings, tags, or status (watching/completed/dropped) per saved title.
- No multi-device conflict resolution beyond "cloud rows win by union".

## 3. Continue Watching — historical record only (NOT CURRENT)

- Commit `816af2e` ("Add continue watching feature", 2026-10-03) implemented a continue-watching UI in the **then-current root** `index.html`, `script.js`, `style.css` (441 inserted lines).
- Those root files were deleted in the `public/` restructure (`dc15de9`, `fdade94`, `8158752`). **The feature does not exist in the current app.**
- The only remnant is a defensive assertion in `test-search.js` that the legacy `localStorage` key `anime_hub_continue_watching` is never removed. Some browsers may still hold that key; nothing reads it.
- **Do not describe continue watching as a current feature anywhere.**

## 4. Watch Progress / History (NOT IMPLEMENTED)

- No tables, endpoints, storage keys, or UI.
- No notion of current episode, position, percentage, completion, or last-watched timestamp.
- `episodes` on a title is only a total count; there is no episode identity to attach progress to (see `docs/ANIME_DATA.md` §6).

## 5. PLANNED ARCHITECTURE (decisions required before any implementation)

This section records the open questions; **it authorises no work.**

1. **Canonical anime ID.** Choose the AniList ID as the single identifier for all watch data (recommended in the audit) or keep a mapping table. Today two ID spaces coexist (`docs/ANIME_DATA.md` §3); progress written under the wrong one becomes unresolvable.
2. **Episode identity.** Decide whether to introduce an episodes table/materialised list (AniList `streamingEpisodes` or a numbered model `(anime_id, episode_number)`), or to track progress as a simple "episodes watched" counter. Without this, per-episode resume cannot exist.
3. **Progress storage.** Decide table shape: e.g. `watch_progress(user_id, anime_id, episode_number, position_seconds, duration_seconds, updated_at)` with a uniqueness rule and RLS mirroring `watchlist` (own-rows only).
4. **Completion state.** Decide how a title/episode is marked completed (explicit user action vs threshold, e.g. ≥90 %), and whether a completed item leaves Continue Watching.
5. **Last-watched timestamp.** Every progress row needs `updated_at` to order Continue Watching.
6. **Resume position.** Decide granularity (seconds) and behaviour for unknown durations.
7. **History vs Progress.** Decide whether history is implicit (derived from progress rows) or a separate append-only table (what to keep when a user re-watches or clears history).
8. **RLS.** Every new table must follow the existing own-row policy pattern, including any future admin read access.
9. **Guest behaviour.** Decide whether guests get local progress (like the local watchlist) and whether the same verified migration path applies.
10. **Episode data source and caching.** If episodes come from AniList per title, decide server caching (none exists today for `/api/anime/:id`) and fallback behaviour when AniList is unavailable.
11. **Write path.** Decide whether progress writes go browser → Supabase directly (consistent with watchlist) or through new server endpoints (needed if server-side validation or aggregation is required).

## 6. NOT FOUND / NEEDS CONFIRMATION

- Whether Favorites is part of the product (there is no favourites model at all).
- Whether "continue watching" means resume playback links, a home shelf, or both.
- Whether progress should sync across devices (implied by using Supabase, but not confirmed).
- Any analytics on watch behaviour (none exist; analytics is deliberately absent).
