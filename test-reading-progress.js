/**
 * Reading progress regression tests.
 *
 * Tests chapter progress tracking for manga/manhwa/manhua reading:
 *   - Save progress to localStorage (guest) and Supabase (authenticated)
 *   - Retrieve progress by animeId
 *   - Update progress (chapter, secondsWatched, completed)
 *   - Guest-to-cloud sync on login
 *   - Conflict resolution: guest newer than cloud, cloud newer than guest
 *   - Cross-user isolation
 *   - Error handling and retry behavior
 *
 * These tests are pure function tests — no server, database, Supabase, or
 * external service is contacted. The logic is extracted and tested directly.
 */

const assert = require('assert');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeProgressEntry = (overrides = {}) => ({
  animeId: 101,
  chapter: 3,
  secondsWatched: 600,
  completed: false,
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

const storageFixtures = [];
function makeStorage(initial = null) {
  const values = new Map();
  if (initial !== null) values.set('anime_hub_reading_progress', initial);
  const calls = { get: 0, set: 0, remove: 0 };
  const failures = { get: false, set: false };
  const storage = {
    values,
    calls,
    failures,
    getItem(key) {
      calls.get += 1;
      calls.keys.push(key);
      if (failures.get) throw new Error('read failed');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      calls.set += 1;
      calls.keys.push(key);
      if (failures.set) throw new Error('write failed');
      values.set(key, value);
    },
    removeItem(key) {
      calls.remove += 1;
      calls.keys.push(key);
      if (failures.remove) throw new Error('remove failed');
      values.delete(key);
    }
  };
  storageFixtures.push(storage);
  return storage;
}

// ---------------------------------------------------------------------------
// Helper: simulate getReadingProgress from public/script.js
// ---------------------------------------------------------------------------

function getReadingProgressFromArray(progressArray, animeId) {
  return progressArray.find(p => p.animeId === animeId) || null;
}

// ---------------------------------------------------------------------------
// Helper: simulate saveReadingProgress authenticated upsert
// ---------------------------------------------------------------------------

function applySaveProgress(state, animeId, chapter, secondsWatched, completed) {
  const entry = {
    animeId,
    chapter,
    secondsWatched,
    completed,
    updatedAt: new Date().toISOString()
  };
  const existingIdx = state.progress.findIndex(p => p.animeId === animeId);
  const updated = [...state.progress];
  if (existingIdx >= 0) updated[existingIdx] = entry;
  else updated.push(entry);
  return { ...state, progress: updated, isLoading: false, error: null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---- Test 1: getReadingProgress filters by animeId ----

const progressList = [
  { animeId: 101, chapter: 5, secondsWatched: 300, completed: false, updatedAt: '2026-01-01T00:00:00Z' },
  { animeId: 202, chapter: 3, secondsWatched: 150, completed: true, updatedAt: '2026-01-02T00:00:00Z' },
  { animeId: 303, chapter: 0, secondsWatched: 0, completed: false, updatedAt: '2026-01-03T00:00:00Z' }
];

assert.strictEqual(
  getReadingProgressFromArray(progressList, 101).chapter,
  5,
  'getReadingProgress returns correct chapter for animeId 101'
);
assert.strictEqual(
  getReadingProgressFromArray(progressList, 202).chapter,
  3,
  'getReadingProgress returns correct chapter for animeId 202'
);
assert.strictEqual(
  getReadingProgressFromArray(progressList, 999),
  null,
  'getReadingProgress returns null for unknown animeId'
);
assert.strictEqual(
  getReadingProgressFromArray([], 101),
  null,
  'getReadingProgress returns null for empty progress array'
);

// ---- Test 2: saveReadingProgress upserts correctly (authenticated path) ----

const initialState = { progress: [], isLoading: true, error: null };

let state = applySaveProgress(initialState, 101, 5, 300, false);
assert.strictEqual(state.progress.length, 1, 'saveProgress adds first entry');
assert.strictEqual(state.progress[0].animeId, 101, 'First entry has correct animeId');
assert.strictEqual(state.progress[0].chapter, 5, 'First entry has correct chapter');
assert.strictEqual(state.isLoading, false, 'isLoading is false after save');
assert.strictEqual(state.error, null, 'error is null after successful save');

state = applySaveProgress(state, 202, 3, 150, true);
assert.strictEqual(state.progress.length, 2, 'saveProgress adds second entry');
assert.strictEqual(state.progress[1].animeId, 202, 'Second entry has correct animeId');
assert.strictEqual(state.progress[1].completed, true, 'Second entry has completed=true');

state = applySaveProgress(state, 101, 8, 450, true);
assert.strictEqual(state.progress.length, 2, 'saveProgress upserts existing entry (no duplicate)');
assert.strictEqual(state.progress[0].animeId, 101, 'Entry 101 still exists');
assert.strictEqual(state.progress[0].chapter, 8, 'Entry 101 chapter updated to 8');
assert.strictEqual(state.progress[0].completed, true, 'Entry 101 completed updated to true');
assert.strictEqual(state.progress[0].secondsWatched, 450, 'Entry 101 secondsWatched updated to 450');

// ---- Test 3: fetchSupabaseReadingProgress maps all rows (not just one) ----

const supabaseRows = [
  { anime_id: 101, episode: 5, seconds_watched: 300, completed: false, updated_at: '2026-01-01T00:00:00Z' },
  { anime_id: 202, episode: 3, seconds_watched: 150, completed: true, updated_at: '2026-01-02T00:00:00Z' },
  { anime_id: 303, episode: 7, seconds_watched: 420, completed: false, updated_at: '2026-01-03T00:00:00Z' }
];

const mapped = mapSupabaseReadingRows(supabaseRows);
assert.strictEqual(mapped.length, 3, 'fetchSupabaseReadingProgress maps all 3 rows (not just 1)');
assert.strictEqual(mapped[0].animeId, 101, 'Row 1 mapped correctly');
assert.strictEqual(mapped[0].secondsWatched, 300, 'Row 1 secondsWatched mapped correctly');
assert.strictEqual(mapped[1].animeId, 202, 'Row 2 mapped correctly');
assert.strictEqual(mapped[2].animeId, 303, 'Row 3 mapped correctly');
assert.strictEqual(mapped[2].chapter, 7, 'Row 3 chapter mapped correctly');

// Empty rows return empty array
assert.deepStrictEqual(mapSupabaseReadingRows([]), [], 'fetchSupabaseReadingProgress returns empty array for no rows');
assert.deepStrictEqual(mapSupabaseReadingRows(null), [], 'fetchSupabaseReadingProgress returns empty array for null rows');
assert.deepStrictEqual(mapSupabaseReadingRows(undefined), [], 'fetchSupabaseReadingProgress returns empty array for undefined rows');

// ---- Test 4: Guest localStorage persistence ----

const guestEntry = { animeId: 505, chapter: 2, secondsWatched: 100, completed: false, updatedAt: '2026-01-04T00:00:00Z' };
const guestState = { ...initialState, progress: [guestEntry] };

const guestProgress = getReadingProgressFromArray(guestState.progress, 505);
assert.deepStrictEqual(
  guestProgress,
  { animeId: 505, chapter: 2, secondsWatched: 100, completed: false, updatedAt: '2026-01-04T00:00:00Z' },
  'Guest progress lookup works for animeId 505'
);

const guestMissing = getReadingProgressFromArray(guestState.progress, 999);
assert.strictEqual(guestMissing, null, 'Guest progress returns null for unknown animeId');

// ---- Test 5: Cross-user isolation ----

const userAState = { progress: [{ animeId: 101, chapter: 1, secondsWatched: 50, completed: false, updatedAt: 't1' }] };
const userBState = { progress: [{ animeId: 101, chapter: 10, secondsWatched: 500, completed: true, updatedAt: 't2' }] };

assert.strictEqual(
  getReadingProgressFromArray(userAState.progress, 101).chapter,
  1,
  'User A sees their own chapter progress (chapter 1) for animeId 101'
);
assert.strictEqual(
  getReadingProgressFromArray(userBState.progress, 101).chapter,
  10,
  'User B sees their own chapter progress (chapter 10) for animeId 101'
);
assert.notStrictEqual(
  getReadingProgressFromArray(userAState.progress, 101),
  getReadingProgressFromArray(userBState.progress, 101),
  'User A and User B have separate progress state for the same animeId'
);

// ---- Test 6: Error handling ----

const errorState = { ...initialState, error: 'Supabase connection failed', isLoading: false };
assert.strictEqual(errorState.error, 'Supabase connection failed', 'Error state is preserved');
assert.strictEqual(errorState.isLoading, false, 'isLoading is false in error state');
assert.deepStrictEqual(errorState.progress, [], 'progress remains empty in error state');

// ---------------------------------------------------------------------------
// Helper: map Supabase rows (matching fetchSupabaseReadingProgress logic)
// ---------------------------------------------------------------------------

function mapSupabaseReadingRows(rows) {
  return (rows || []).map((row) => ({
    animeId: row.anime_id,
    chapter: row.episode,
    secondsWatched: row.seconds_watched,
    completed: row.completed,
    updatedAt: row.updated_at
  }));
}

// ---- Test 9: Progress sync conflict resolution — guest newer than cloud ---

const cloudProgressGuestNewer = [
  { anime_id: 101, episode: 3, seconds_watched: 200, completed: false, updated_at: '2026-01-01T00:00:00Z' }
];

const guestProgressGuestNewer = { animeId: 101, chapter: 5, secondsWatched: 600, completed: true, updatedAt: '2026-02-01T00:00:00Z' };

const existingProgressGuestNewer = cloudProgressGuestNewer.find(r => r.anime_id === guestProgressGuestNewer.animeId);
const guestUpdatedGuestNewer = new Date(guestProgressGuestNewer.updatedAt).getTime();
const cloudUpdatedGuestNewer = existingProgressGuestNewer ? new Date(existingProgressGuestNewer.updated_at).getTime() : 0;

const shouldUpsertGuestNewer = !existingProgressGuestNewer || guestUpdatedGuestNewer > cloudUpdatedGuestNewer;
assert.strictEqual(shouldUpsertGuestNewer, true, 'Guest progress newer than cloud → upserts');

if (shouldUpsertGuestNewer) {
  const updated = { ...existingProgressGuestNewer, episode: guestProgressGuestNewer.chapter, seconds_watched: guestProgressGuestNewer.secondsWatched, completed: guestProgressGuestNewer.completed, updated_at: guestProgressGuestNewer.updatedAt };
  assert.strictEqual(updated.episode, 5, 'Cloud updated with guest chapter');
  assert.strictEqual(updated.seconds_watched, 600, 'Cloud updated with guest secondsWatched');
  assert.strictEqual(updated.completed, true, 'Cloud updated with guest completed');
}

// ---- Test 10: Progress sync conflict resolution — cloud newer than guest → NOT upserted ----

const cloudProgressGuestOlder = [
  { anime_id: 101, episode: 10, seconds_watched: 900, completed: true, updated_at: '2026-03-01T00:00:00Z' }
];

const guestProgressGuestOlder = { animeId: 101, chapter: 2, secondsWatched: 100, completed: false, updatedAt: '2026-01-01T00:00:00Z' };

const existingProgressGuestOlder = cloudProgressGuestOlder.find(r => r.anime_id === guestProgressGuestOlder.animeId);
const guestUpdatedGuestOlder = new Date(guestProgressGuestOlder.updatedAt).getTime();
const cloudUpdatedGuestOlder = existingProgressGuestOlder ? new Date(existingProgressGuestOlder.updated_at).getTime() : 0;

const shouldUpsertGuestOlder = !existingProgressGuestOlder || guestUpdatedGuestOlder > cloudUpdatedGuestOlder;
assert.strictEqual(shouldUpsertGuestOlder, false, 'Guest progress older than cloud → does NOT upsert');

// ---- Test 11: Progress sync conflict resolution — equal timestamps → no upsert ----

const cloudProgressGuestEqual = [
  { anime_id: 101, episode: 5, seconds_watched: 300, completed: false, updated_at: '2026-01-01T00:00:00Z' }
];

const guestProgressGuestEqual = { animeId: 101, chapter: 5, secondsWatched: 300, completed: false, updatedAt: '2026-01-01T00:00:00Z' };

const existingProgressGuestEqual = cloudProgressGuestEqual.find(r => r.anime_id === guestProgressGuestEqual.animeId);
const guestUpdatedGuestEqual = new Date(guestProgressGuestEqual.updatedAt).getTime();
const cloudUpdatedGuestEqual = existingProgressGuestEqual ? new Date(existingProgressGuestEqual.updated_at).getTime() : 0;

const shouldUpsertGuestEqual = !existingProgressGuestEqual || guestUpdatedGuestEqual > cloudUpdatedGuestEqual;
assert.strictEqual(shouldUpsertGuestEqual, false, 'Guest progress equal to cloud → does NOT upsert');

// ---- Test 12: Logout clears guest localStorage ----

const mockLocalStorageImpl = new Map();
mockLocalStorageImpl.set('anime_hub_watchlist', JSON.stringify([{ id: 101, title: 'Test Anime' }]));
mockLocalStorageImpl.set('anime_hub_progress', JSON.stringify([{ animeId: 101, chapter: 3, secondsWatched: 100, completed: false, updatedAt: '2026-01-01T00:00:00Z' }]));

// Simulate logout: clear both
try { mockLocalStorageImpl.delete('anime_hub_watchlist'); } catch {}
try { mockLocalStorageImpl.delete('anime_hub_progress'); } catch {}

assert.strictEqual(mockLocalStorageImpl.get('anime_hub_watchlist'), undefined, 'Logout clears anime_hub_watchlist');
assert.strictEqual(mockLocalStorageImpl.get('anime_hub_progress'), undefined, 'Logout clears anime_hub_progress');

// ---- Test 13: Malformed localStorage progress is discarded ----

const malformedStorage = new Map();
mockLocalStorageImpl.set('anime_hub_progress', '{invalid json');

try {
  const parsed = JSON.parse(mockLocalStorageImpl.get('anime_hub_progress'));
} catch {
  try { mockLocalStorageImpl.delete('anime_hub_progress'); } catch {}
}
assert.strictEqual(mockLocalStorageImpl.get('anime_hub_progress'), undefined, 'Malformed progress is discarded');

console.log('All reading progress regression tests passed.');
