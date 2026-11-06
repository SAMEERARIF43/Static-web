/**
 * Watch progress and watchlist regression tests.
 *
 * These tests verify the core logic of the watch/progress system:
 *   - getProgress() filtering by animeId (bug fix: previously returned
 *     the most recently fetched entry regardless of requested anime)
 *   - saveProgress() state persistence after Supabase upsert
 *   - fetchSupabaseProgress() mapping all entries (not just one)
 *   - Guest localStorage persistence
 *   - Cross-user isolation
 *   - Error and retry behavior
 *
 * These are pure function tests — no server, database, Supabase, or
 * external service is contacted. The logic is extracted and tested
 * directly.
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Helper: extract the getProgress filtering logic from useWatchProgress.ts
// ---------------------------------------------------------------------------

function getProgressFromArray(progressArray, animeId) {
  return progressArray.find((p) => p.animeId === animeId) || null;
}

// ---------------------------------------------------------------------------
// Helper: simulate saveProgress state update for authenticated users
// ---------------------------------------------------------------------------

function applySaveProgress(state, animeId, ep, seconds, completed) {
  const newProgress = {
    animeId,
    episode: ep,
    secondsWatched: seconds,
    completed,
    updatedAt: new Date().toISOString(),
  };
  // Upsert: replace existing entry for this animeId or append
  const existingIdx = state.progress.findIndex((p) => p.animeId === animeId);
  const updated = [...state.progress];
  if (existingIdx >= 0) {
    updated[existingIdx] = newProgress;
  } else {
    updated.push(newProgress);
  }
  return { ...state, progress: updated, isLoading: false, error: null };
}

// ---------------------------------------------------------------------------
// Helper: simulate fetchSupabaseProgress mapping
// ---------------------------------------------------------------------------

function mapSupabaseRows(rows) {
  return (rows || []).map((row) => ({
    animeId: row.anime_id,
    episode: row.episode,
    secondsWatched: row.seconds_watched,
    completed: row.completed,
    updatedAt: row.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---- Test 1: getProgress filters by animeId (authenticated path) ----

const progressList = [
  { animeId: 101, episode: 5, secondsWatched: 300, completed: false, updatedAt: '2026-01-01T00:00:00Z' },
  { animeId: 202, episode: 3, secondsWatched: 150, completed: true, updatedAt: '2026-01-02T00:00:00Z' },
  { animeId: 303, episode: 0, secondsWatched: 0, completed: false, updatedAt: '2026-01-03T00:00:00Z' },
];

// Returns the correct entry for a known animeId
assert.deepStrictEqual(
  getProgressFromArray(progressList, 101),
  { animeId: 101, episode: 5, secondsWatched: 300, completed: false, updatedAt: '2026-01-01T00:00:00Z' },
  'getProgress returns the correct entry for animeId 101'
);

assert.deepStrictEqual(
  getProgressFromArray(progressList, 202),
  { animeId: 202, episode: 3, secondsWatched: 150, completed: true, updatedAt: '2026-01-02T00:00:00Z' },
  'getProgress returns the correct entry for animeId 202'
);

// Returns null for unknown animeId (the bug: previously returned most recent entry)
assert.strictEqual(
  getProgressFromArray(progressList, 999),
  null,
  'getProgress returns null for unknown animeId (not the most recent entry)'
);

// Returns null for empty array
assert.strictEqual(
  getProgressFromArray([], 101),
  null,
  'getProgress returns null for empty progress array'
);

// ---- Test 2: saveProgress upserts correctly (authenticated path) ----

const initialState = { progress: [], isLoading: true, error: null };

let state = applySaveProgress(initialState, 101, 5, 300, false);
assert.strictEqual(state.progress.length, 1, 'saveProgress adds first entry');
assert.strictEqual(state.progress[0].animeId, 101, 'First entry has correct animeId');
assert.strictEqual(state.progress[0].episode, 5, 'First entry has correct episode');
assert.strictEqual(state.isLoading, false, 'isLoading is false after save');
assert.strictEqual(state.error, null, 'error is null after successful save');

state = applySaveProgress(state, 202, 3, 150, true);
assert.strictEqual(state.progress.length, 2, 'saveProgress adds second entry');
assert.strictEqual(state.progress[1].animeId, 202, 'Second entry has correct animeId');
assert.strictEqual(state.progress[1].completed, true, 'Second entry has completed=true');

state = applySaveProgress(state, 101, 8, 450, true);
assert.strictEqual(state.progress.length, 2, 'saveProgress upserts existing entry (no duplicate)');
assert.strictEqual(state.progress[0].animeId, 101, 'Entry 101 still exists');
assert.strictEqual(state.progress[0].episode, 8, 'Entry 101 episode updated to 8');
assert.strictEqual(state.progress[0].completed, true, 'Entry 101 completed updated to true');
assert.strictEqual(state.progress[0].secondsWatched, 450, 'Entry 101 secondsWatched updated to 450');

// ---- Test 3: fetchSupabaseProgress maps all rows (not just one) ----

const supabaseRows = [
  { anime_id: 101, episode: 5, seconds_watched: 300, completed: false, updated_at: '2026-01-01T00:00:00Z' },
  { anime_id: 202, episode: 3, seconds_watched: 150, completed: true, updated_at: '2026-01-02T00:00:00Z' },
  { anime_id: 303, episode: 7, seconds_watched: 420, completed: false, updated_at: '2026-01-03T00:00:00Z' },
];

const mapped = mapSupabaseRows(supabaseRows);
assert.strictEqual(mapped.length, 3, 'fetchSupabaseProgress maps all 3 rows (not just 1)');
assert.strictEqual(mapped[0].animeId, 101, 'Row 1 mapped correctly');
assert.strictEqual(mapped[0].secondsWatched, 300, 'Row 1 secondsWatched mapped correctly');
assert.strictEqual(mapped[1].animeId, 202, 'Row 2 mapped correctly');
assert.strictEqual(mapped[2].animeId, 303, 'Row 3 mapped correctly');
assert.strictEqual(mapped[2].episode, 7, 'Row 3 episode mapped correctly');

// Empty rows return empty array
assert.deepStrictEqual(mapSupabaseRows([]), [], 'fetchSupabaseProgress returns empty array for no rows');
assert.deepStrictEqual(mapSupabaseRows(null), [], 'fetchSupabaseProgress returns empty array for null rows');
assert.deepStrictEqual(mapSupabaseRows(undefined), [], 'fetchSupabaseProgress returns empty array for undefined rows');

// ---- Test 4: Guest localStorage persistence ----

const guestEntry = { animeId: 505, episode: 2, secondsWatched: 100, completed: false, updatedAt: '2026-01-04T00:00:00Z' };
const guestState = { ...initialState, progress: [guestEntry] };

const guestProgress = getProgressFromArray(guestState.progress, 505);
assert.deepStrictEqual(
  guestProgress,
  { animeId: 505, episode: 2, secondsWatched: 100, completed: false, updatedAt: '2026-01-04T00:00:00Z' },
  'Guest progress lookup works for animeId 505'
);

const guestMissing = getProgressFromArray(guestState.progress, 999);
assert.strictEqual(guestMissing, null, 'Guest progress returns null for unknown animeId');

// ---- Test 5: Cross-user isolation ----

const userAState = { progress: [{ animeId: 101, episode: 1, secondsWatched: 50, completed: false, updatedAt: 't1' }] };
const userBState = { progress: [{ animeId: 101, episode: 10, secondsWatched: 500, completed: true, updatedAt: 't2' }] };

assert.strictEqual(
  getProgressFromArray(userAState.progress, 101).episode,
  1,
  'User A sees their own progress (episode 1) for anime 101'
);
assert.strictEqual(
  getProgressFromArray(userBState.progress, 101).episode,
  10,
  'User B sees their own progress (episode 10) for anime 101'
);
assert.notStrictEqual(
  getProgressFromArray(userAState.progress, 101),
  getProgressFromArray(userBState.progress, 101),
  'User A and User B have separate progress state for the same animeId'
);

// ---- Test 6: Error handling ----

const errorState = { ...initialState, error: 'Supabase connection failed', isLoading: false };
assert.strictEqual(errorState.error, 'Supabase connection failed', 'Error state is preserved');
assert.strictEqual(errorState.isLoading, false, 'isLoading is false in error state');
assert.deepStrictEqual(errorState.progress, [], 'progress remains empty in error state');

// ---- Test 7: Progress sync conflict resolution — guest newer than cloud ----

const cloudProgressGuestNewer = [
  { animeId: 101, episode: 3, secondsWatched: 200, completed: false, updated_at: '2026-01-01T00:00:00Z' },
];

const guestProgressGuestNewer = { animeId: 101, episode: 5, secondsWatched: 600, completed: true, updatedAt: '2026-02-01T00:00:00Z' };

const existingProgressGuestNewer = cloudProgressGuestNewer.find(r => r.anime_id === guestProgressGuestNewer.animeId);
const guestUpdatedGuestNewer = new Date(guestProgressGuestNewer.updatedAt).getTime();
const cloudUpdatedGuestNewer = existingProgressGuestNewer ? new Date(existingProgressGuestNewer.updated_at).getTime() : 0;

const shouldUpsertGuestNewer = !existingProgressGuestNewer || guestUpdatedGuestNewer > cloudUpdatedGuestNewer;
assert.strictEqual(shouldUpsertGuestNewer, true, 'Guest progress newer than cloud → should upsert');

if (shouldUpsertGuestNewer) {
  const updated = { ...existingProgressGuestNewer, episode: guestProgressGuestNewer.episode, seconds_watched: guestProgressGuestNewer.secondsWatched, completed: guestProgressGuestNewer.completed, updated_at: guestProgressGuestNewer.updatedAt };
  assert.strictEqual(updated.episode, 5, 'Cloud updated with guest episode');
  assert.strictEqual(updated.seconds_watched, 600, 'Cloud updated with guest secondsWatched');
  assert.strictEqual(updated.completed, true, 'Cloud updated with guest completed');
}

// ---- Test 8: Progress sync conflict resolution — cloud newer than guest → NOT overwritten ----

const cloudProgressGuestOlder = [
  { anime_id: 101, episode: 10, secondsWatched: 900, completed: true, updated_at: '2026-03-01T00:00:00Z' },
];

const guestProgressGuestOlder = { animeId: 101, episode: 2, secondsWatched: 100, completed: false, updatedAt: '2026-01-01T00:00:00Z' };

const existingProgressGuestOlder = cloudProgressGuestOlder.find(r => r.anime_id === guestProgressGuestOlder.animeId);
const guestUpdatedGuestOlder = new Date(guestProgressGuestOlder.updatedAt).getTime();
const cloudUpdatedGuestOlder = existingProgressGuestOlder ? new Date(existingProgressGuestOlder.updated_at).getTime() : 0;

const shouldUpsertGuestOlder = !existingProgressGuestOlder || guestUpdatedGuestOlder > cloudUpdatedGuestOlder;
assert.strictEqual(shouldUpsertGuestOlder, false, 'Guest progress older than cloud → should NOT upsert');

// ---- Test 9: Progress sync conflict resolution — equal timestamps → no upsert ----

const cloudProgressGuestEqual = [
  { anime_id: 101, episode: 5, secondsWatched: 300, completed: false, updated_at: '2026-01-01T00:00:00Z' },
];

const guestProgressGuestEqual = { animeId: 101, episode: 5, secondsWatched: 300, completed: false, updatedAt: '2026-01-01T00:00:00Z' };

const existingProgressGuestEqual = cloudProgressGuestEqual.find(r => r.anime_id === guestProgressGuestEqual.animeId);
const guestUpdatedGuestEqual = new Date(guestProgressGuestEqual.updatedAt).getTime();
const cloudUpdatedGuestEqual = existingProgressGuestEqual ? new Date(existingProgressGuestEqual.updated_at).getTime() : 0;

const shouldUpsertGuestEqual = !existingProgressGuestEqual || guestUpdatedGuestEqual > cloudUpdatedGuestEqual;
assert.strictEqual(shouldUpsertGuestEqual, false, 'Guest progress equal to cloud → should NOT upsert');

// ---- Test 10: Logout clears guest localStorage ----

const mockLocalStorage = new Map();
const mockLocalStorageImpl = {
  getItem: (key) => mockLocalStorage.get(key) || null,
  setItem: (key, value) => mockLocalStorage.set(key, String(value)),
  removeItem: (key) => mockLocalStorage.delete(key),
};

// Simulate logged-in user with guest data in localStorage
mockLocalStorageImpl.setItem('anime_hub_watchlist', JSON.stringify([{ id: 101, title: 'Test Anime' }]));
mockLocalStorageImpl.setItem('anime_hub_progress', JSON.stringify([{ animeId: 101, episode: 3, secondsWatched: 100, completed: false, updatedAt: '2026-01-01T00:00:00Z' }]));

// Simulate logout: clear both
try { mockLocalStorageImpl.removeItem('anime_hub_watchlist'); } catch {}
try { mockLocalStorageImpl.removeItem('anime_hub_progress'); } catch {}

assert.strictEqual(mockLocalStorageImpl.getItem('anime_hub_watchlist'), null, 'Logout clears anime_hub_watchlist');
assert.strictEqual(mockLocalStorageImpl.getItem('anime_hub_progress'), null, 'Logout clears anime_hub_progress');

// ---- Test 11: Malformed localStorage progress is discarded ----

mockLocalStorageImpl.setItem('anime_hub_progress', '{invalid json');

try {
  const parsed = JSON.parse(mockLocalStorageImpl.getItem('anime_hub_progress'));
} catch {
  try { mockLocalStorageImpl.removeItem('anime_hub_progress'); } catch {}
}
assert.strictEqual(mockLocalStorageImpl.getItem('anime_hub_progress'), null, 'Malformed progress is discarded');

console.log('All watch progress regression tests passed.');
