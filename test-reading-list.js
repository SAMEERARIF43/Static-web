const assert = require('assert');
const {
  READING_LIST_KEY,
  READING_LIST_SCHEMA_VERSION,
  READING_STATUS_VALUES,
  normalizeReadingStatus,
  normalizeReadingChapter,
  normalizeReadingTotal,
  normalizeReadingEntry,
  normalizeReadingList,
  readingEntryKey,
  serializeReadingList,
  parseReadingList,
  createReadingListStore
} = require('./public/reading-list-utils.js');

const NOW = '2026-10-19T12:00:00.000Z';
const CONTENT_TYPES = ['manga', 'manhwa', 'manhua'];
const ANIME_WATCHLIST_KEY = 'anime_hub_watchlist';
const ANIME_SENTINEL = JSON.stringify([{ id: 777, status: 'watching', currentEpisode: 3 }]);
const baseEntry = (overrides = {}) => ({
  provider: 'anilist',
  providerId: 12345,
  contentType: 'manga',
  title: 'Example Title',
  poster: 'https://example.test/poster.jpg',
  readingStatus: 'plan_to_read',
  currentChapter: 0,
  totalChapters: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides
});

function expectCode(fn, code, message) {
  assert.throws(fn, error => error?.code === code, message || `expected ${code}`);
}

const storageFixtures = [];
function makeStorage(initial = null) {
  const values = new Map([[ANIME_WATCHLIST_KEY, ANIME_SENTINEL]]);
  if (initial !== null) values.set(READING_LIST_KEY, initial);
  const calls = { get: 0, set: 0, remove: 0, keys: [] };
  const failures = { get: false, set: false, remove: false };
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

// Status, provider, content type, identity, and display metadata contracts.
assert.deepStrictEqual(READING_STATUS_VALUES, [
  'reading', 'completed', 'plan_to_read', 'on_hold', 'dropped'
]);
for (const status of READING_STATUS_VALUES) {
  assert.strictEqual(normalizeReadingStatus(status), status);
}
for (const invalidStatus of ['Reading', 'watching', '', null, 1]) {
  expectCode(() => normalizeReadingStatus(invalidStatus), 'INVALID_STATUS');
}

const normalized = normalizeReadingEntry(baseEntry(), { now: () => NOW });
assert.strictEqual(normalized.providerId, 12345);
assert.strictEqual(normalized.progressExceedsTotal, false);
assert.strictEqual(readingEntryKey(normalized), 'anilist:manga:12345');
assert.strictEqual(normalized.poster, 'https://example.test/poster.jpg');
for (const contentType of CONTENT_TYPES) {
  const typed = normalizeReadingEntry(baseEntry({ contentType, providerId: '12345' }));
  assert.strictEqual(typed.providerId, 12345);
  assert.strictEqual(readingEntryKey(typed), `anilist:${contentType}:12345`);

  // Only omitted/undefined fields default; explicit null is invalid entry data.
  expectCode(() => normalizeReadingEntry(baseEntry({ contentType, currentChapter: null })), 'INVALID_INTEGER');
  expectCode(() => normalizeReadingEntry(baseEntry({ contentType, readingStatus: null })), 'INVALID_STATUS');
  const omitted = baseEntry({ contentType });
  delete omitted.currentChapter;
  delete omitted.readingStatus;
  for (const input of [omitted, baseEntry({ contentType, currentChapter: undefined, readingStatus: undefined })]) {
    const defaulted = normalizeReadingEntry(input);
    assert.strictEqual(defaulted.currentChapter, 0);
    assert.strictEqual(defaulted.readingStatus, 'plan_to_read');
  }
  for (const timestamp of [null, undefined]) {
    const defaulted = normalizeReadingEntry(baseEntry({ contentType, createdAt: timestamp, updatedAt: timestamp }), { now: () => NOW });
    assert.strictEqual(defaulted.createdAt, NOW);
    assert.strictEqual(defaulted.updatedAt, NOW);
  }
}
for (const field of ['provider', 'contentType', 'providerId', 'title']) {
  const invalidEntry = baseEntry();
  if (field === 'provider') invalidEntry.provider = 'other';
  if (field === 'contentType') invalidEntry.contentType = 'anime';
  if (field === 'providerId') invalidEntry.providerId = 0;
  if (field === 'title') invalidEntry.title = '';
  expectCode(() => normalizeReadingEntry(invalidEntry), field === 'provider' ? 'INVALID_PROVIDER' : field === 'contentType' ? 'INVALID_CONTENT_TYPE' : field === 'providerId' ? 'INVALID_PROVIDER_ID' : 'INVALID_TITLE');
}

// Canonical integer strings are the one shared normalization rule.
for (const value of [0, 12, '0', '12', Number.MAX_SAFE_INTEGER]) {
  assert.strictEqual(normalizeReadingChapter(value), Number(value));
}
for (const value of ['00', ' 12', '12 ', '+12', '-1', '12.0', '12.5', '1e2', '12 chapters', '', '9007199254740992', -1, 1.5, NaN, Infinity, null, true, {}, []]) {
  expectCode(() => normalizeReadingChapter(value), 'INVALID_INTEGER', `rejected noncanonical chapter ${String(value)}`);
}
assert.strictEqual(normalizeReadingTotal(null), null);
assert.strictEqual(normalizeReadingTotal('12'), 12);
expectCode(() => normalizeReadingTotal(0), 'INVALID_TOTAL');

// Completion advances only to a known total; unknown totals remain unknown.
assert.strictEqual(normalizeReadingEntry(baseEntry({ readingStatus: 'completed', currentChapter: 3, totalChapters: 12 })).currentChapter, 12);
const unknownCompletion = normalizeReadingEntry(baseEntry({ readingStatus: 'completed', currentChapter: 3, totalChapters: null }));
assert.deepStrictEqual(
  { currentChapter: unknownCompletion.currentChapter, totalChapters: unknownCompletion.totalChapters, progressExceedsTotal: unknownCompletion.progressExceedsTotal },
  { currentChapter: 3, totalChapters: null, progressExceedsTotal: false }
);
assert.strictEqual(normalizeReadingEntry(baseEntry({ currentChapter: 12, totalChapters: null })).progressExceedsTotal, false);

// A provider total may decrease, but it cannot silently clamp user progress.
const changedTotal = normalizeReadingEntry(baseEntry({ currentChapter: 12, totalChapters: 8 }));
assert.strictEqual(changedTotal.currentChapter, 12);
assert.strictEqual(changedTotal.totalChapters, 8);
assert.strictEqual(changedTotal.progressExceedsTotal, true);

// Duplicate selection: valid timestamps beat invalid ones; later timestamps
// win; equal timestamps and invalid-timestamp ties use greatest source index.
for (const contentType of CONTENT_TYPES) {
  const validOlder = baseEntry({ contentType, title: 'valid-older', updatedAt: '2000-01-01T00:00:00.000Z' });
  const validLater = baseEntry({ contentType, title: 'valid-later', updatedAt: NOW });
  const missingTimestamp = baseEntry({ contentType, title: 'missing-timestamp' });
  delete missingTimestamp.updatedAt;
  const invalidTimestamps = [
    missingTimestamp,
    baseEntry({ contentType, title: 'null-timestamp', updatedAt: null }),
    baseEntry({ contentType, title: 'invalid-timestamp', updatedAt: 'not-a-date' })
  ];
  for (const invalidTimestamp of invalidTimestamps) {
    for (const entries of [[invalidTimestamp, validOlder], [validOlder, invalidTimestamp]]) {
      const deduplicated = normalizeReadingList({ schemaVersion: 1, entries }, { now: () => NOW });
      assert.strictEqual(deduplicated.entries.length, 1);
      assert.strictEqual(deduplicated.entries[0].title, 'valid-older', `${contentType}: valid source timestamp beats ${invalidTimestamp.title} in either order`);
      assert.strictEqual(deduplicated.entries[0].updatedAt, validOlder.updatedAt);
    }
  }
  for (const entries of [[validOlder, validLater], [validLater, validOlder]]) {
    assert.strictEqual(normalizeReadingList({ schemaVersion: 1, entries }).entries[0].title, 'valid-later');
  }
  for (const first of invalidTimestamps) {
    for (const last of invalidTimestamps) {
      const tied = normalizeReadingList({ schemaVersion: 1, entries: [
        { ...first, title: 'invalid-first' },
        { ...last, title: 'invalid-last' }
      ] }, { now: () => NOW });
      assert.strictEqual(tied.entries[0].title, 'invalid-last', `${contentType}: invalid source timestamps use greatest index`);
    }
  }
  for (const sameInstant of [NOW, '2026-10-19T14:00:00.000+02:00']) {
    const tied = normalizeReadingList({ schemaVersion: 1, entries: [
      baseEntry({ contentType, title: 'equal-first', updatedAt: NOW }),
      baseEntry({ contentType, title: 'equal-last', updatedAt: sameInstant })
    ] });
    assert.strictEqual(tied.entries[0].title, 'equal-last');
  }
  const mixed = normalizeReadingList({ schemaVersion: 1, entries: [
    invalidTimestamps[2], validOlder, validLater,
    baseEntry({ contentType, title: 'valid-same-time-last', updatedAt: NOW })
  ] });
  assert.strictEqual(mixed.entries[0].title, 'valid-same-time-last');
}

// Invalid source entries preserve the source by failing normalization; no
// cleaned list is returned that could be accidentally written by a mutation.
const invalidRaw = JSON.stringify({ schemaVersion: 1, entries: [baseEntry(), { ...baseEntry(), providerId: 0 }] });
const invalidParsed = parseReadingList(invalidRaw);
assert.strictEqual(invalidParsed.ok, false);
assert.strictEqual(invalidParsed.code, 'INVALID_ENTRIES');
assert.strictEqual(invalidParsed.raw, invalidRaw);
expectCode(() => normalizeReadingList(JSON.parse(invalidRaw)), 'INVALID_ENTRIES');
assert.strictEqual(parseReadingList('{broken').raw, '{broken');

// Unsupported versions and malformed JSON are recoverable errors and preserve
// raw input; neither can be downgraded or rewritten automatically.
for (const raw of ['{broken', JSON.stringify({ schemaVersion: 99, entries: [] })]) {
  const parsed = parseReadingList(raw);
  assert.strictEqual(parsed.ok, false);
  assert.strictEqual(parsed.raw, raw);
  assert.strictEqual(parsed.recoveryRequired, true);
}

// Serialization excludes the derived mismatch flag and preserves the envelope.
const serialized = serializeReadingList({ schemaVersion: 1, entries: [changedTotal] });
const serializedObject = JSON.parse(serialized);
assert.strictEqual(serializedObject.schemaVersion, READING_LIST_SCHEMA_VERSION);
assert.strictEqual(serializedObject.entries[0].progressExceedsTotal, undefined);

// Guest CRUD uses only the dedicated key and persists valid mutations.
const storage = makeStorage();
const store = createReadingListStore(storage, { now: () => NOW });
assert.strictEqual(store.load().ok, true);
assert.strictEqual(store.add(baseEntry()).ok, true);
assert.strictEqual(store.add(baseEntry()).code, 'DUPLICATE_ENTRY');
const identity = 'anilist:manga:12345';
assert.strictEqual(store.update(identity, { currentChapter: '12', totalChapters: 20, readingStatus: 'reading' }).ok, true);
assert.strictEqual(store.getState().entries[0].currentChapter, 12);
const invalidProgress = store.update(identity, { currentChapter: '' });
assert.strictEqual(invalidProgress.ok, false);
assert.match(invalidProgress.message, /currentChapter.*non-negative.*integer/);
assert.strictEqual(store.getState().entries[0].currentChapter, 12);
const invalidAddition = store.add(baseEntry({ currentChapter: '-1' }));
assert.strictEqual(invalidAddition.ok, false);
assert.match(invalidAddition.message, /currentChapter.*non-negative.*integer/);
assert.strictEqual(store.update(identity, { currentChapter: 5 }).ok, true, 'progress reductions are allowed');
assert.strictEqual(store.remove(identity).ok, true);
assert.strictEqual(store.remove(identity).ok, true, 'removing a missing entry is idempotent');
assert.strictEqual(storage.values.get(ANIME_WATCHLIST_KEY), ANIME_SENTINEL);
assert.strictEqual(storage.values.has(READING_LIST_KEY), true);

// All content types can coexist with the same provider ID. Updates preserve
// composite identity, even when the proposed identity would collide or be new.
const identityStorage = makeStorage();
const identityStore = createReadingListStore(identityStorage, { now: () => NOW });
for (const contentType of CONTENT_TYPES) {
  assert.strictEqual(identityStore.add(baseEntry({ contentType })).ok, true);
  assert.strictEqual(identityStore.add(baseEntry({ contentType, providerId: 67890 })).ok, true);
}
assert.strictEqual(identityStore.getState().entries.length, 6);
for (const contentType of CONTENT_TYPES) {
  const key = `anilist:${contentType}:12345`;
  assert.strictEqual(identityStore.update(key, { providerId: '12345', currentChapter: 2 }).ok, true, 'canonical-equivalent IDs keep identity');
  assert.strictEqual(identityStore.getState().entries.find(entry => readingEntryKey(entry) === key).providerId, 12345);
  const beforeState = identityStore.getState();
  const beforeSnapshot = JSON.stringify(beforeState);
  const beforeRaw = identityStorage.values.get(READING_LIST_KEY);
  const beforeWrites = identityStorage.calls.set;
  const beforeRemovals = identityStorage.calls.remove;
  assert.strictEqual(identityStore.add(baseEntry({ contentType, providerId: '12345' })).code, 'DUPLICATE_ENTRY');
  for (const changes of [
    { providerId: 67890 },
    { providerId: '99999' },
    { contentType: CONTENT_TYPES.find(type => type !== contentType) }
  ]) {
    const rejected = identityStore.update(key, changes);
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.code, 'IDENTITY_CHANGE_NOT_ALLOWED');
    assert.match(rejected.message, /identity/i);
  }
  assert.strictEqual(identityStore.update(key, { provider: 'other' }).code, 'INVALID_PROVIDER');
  for (const [field, code] of [['currentChapter', 'INVALID_INTEGER'], ['readingStatus', 'INVALID_STATUS']]) {
    const rejectedUpdate = identityStore.update(key, { [field]: null });
    const rejectedAddition = identityStore.add(baseEntry({ contentType, providerId: 99999, [field]: null }));
    assert.strictEqual(rejectedUpdate.ok, false);
    assert.strictEqual(rejectedUpdate.code, code);
    assert.strictEqual(rejectedAddition.ok, false);
    assert.strictEqual(rejectedAddition.code, code);
    const raw = JSON.stringify({ schemaVersion: 1, entries: [baseEntry({ contentType, [field]: null })] });
    const parsed = parseReadingList(raw);
    assert.strictEqual(parsed.code, 'INVALID_ENTRIES');
    assert.strictEqual(parsed.raw, raw);
    assert.strictEqual(parsed.recoveryRequired, true);
  }
  assert.strictEqual(identityStorage.calls.set, beforeWrites, 'rejected changes never write');
  assert.strictEqual(identityStorage.calls.remove, beforeRemovals, 'rejected changes never remove storage');
  assert.strictEqual(identityStorage.values.get(READING_LIST_KEY), beforeRaw);
  assert.strictEqual(identityStore.getState(), beforeState);
  assert.strictEqual(JSON.stringify(identityStore.getState()), beforeSnapshot);
}

// Explicit clear is required and is the only operation that removes stored data.
assert.strictEqual(store.clearReadingList().code, 'CLEAR_CONFIRMATION_REQUIRED');
assert.strictEqual(storage.calls.remove, 0);
assert.strictEqual(store.clearReadingList({ confirmed: true }).ok, true);
assert.strictEqual(storage.calls.remove, 1);

// Malformed data blocks mutations and never overwrites the original raw value.
const malformedStorage = makeStorage('{broken');
const malformedStore = createReadingListStore(malformedStorage, { now: () => NOW });
assert.strictEqual(malformedStore.load().code, 'MALFORMED_JSON');
assert.strictEqual(malformedStore.add(baseEntry()).code, 'MALFORMED_JSON');
assert.strictEqual(malformedStorage.values.get(READING_LIST_KEY), '{broken');
malformedStorage.failures.remove = true;
assert.strictEqual(malformedStore.clearReadingList({ confirmed: true }).code, 'STORAGE_REMOVE_FAILED');
assert.strictEqual(malformedStore.getState(), null);
assert.strictEqual(malformedStorage.values.get(READING_LIST_KEY), '{broken');
assert.strictEqual(malformedStore.add(baseEntry()).code, 'MALFORMED_JSON', 'failed clear does not bypass recovery blocking');
malformedStorage.failures.remove = false;
assert.strictEqual(malformedStore.clearReadingList({ confirmed: true }).ok, true);

// Invalid source entries also block mutation and preserve raw storage.
const invalidStorage = makeStorage(invalidRaw);
const invalidStore = createReadingListStore(invalidStorage, { now: () => NOW });
assert.strictEqual(invalidStore.load().code, 'INVALID_ENTRIES');
assert.strictEqual(invalidStore.remove(identity).code, 'INVALID_ENTRIES');
assert.strictEqual(invalidStorage.values.get(READING_LIST_KEY), invalidRaw);

// Unsupported schema versions are not downgraded or overwritten.
const futureRaw = JSON.stringify({ schemaVersion: 2, entries: [] });
const futureStorage = makeStorage(futureRaw);
const futureStore = createReadingListStore(futureStorage);
assert.strictEqual(futureStore.add(baseEntry()).code, 'UNSUPPORTED_VERSION');
assert.strictEqual(futureStorage.values.get(READING_LIST_KEY), futureRaw);

// Read failures are injectable and do not require browser globals.
const readFailureStorage = makeStorage();
readFailureStorage.failures.get = true;
const readFailureStore = createReadingListStore(readFailureStorage);
assert.strictEqual(readFailureStore.load().code, 'STORAGE_READ_FAILED');
assert.strictEqual(readFailureStore.add(baseEntry()).code, 'STORAGE_READ_FAILED');
assert.strictEqual(readFailureStorage.calls.set, 0);
assert.strictEqual(readFailureStorage.calls.remove, 0);

// Write failures roll back memory. The mock intentionally does not mutate its
// stored value when setItem throws, proving the previous value is preserved.
const writeStorage = makeStorage();
const writeStore = createReadingListStore(writeStorage, { now: () => NOW });
assert.strictEqual(writeStore.load().ok, true);
for (const contentType of CONTENT_TYPES) {
  assert.strictEqual(writeStore.add(baseEntry({ contentType, providerId: 777 })).ok, true);
}
const previousSerialized = writeStorage.values.get(READING_LIST_KEY);
const previousState = writeStore.getState();
const previousSnapshot = JSON.stringify(previousState);
writeStorage.failures.set = true;
for (const contentType of CONTENT_TYPES) {
  for (const mutate of [
    () => writeStore.add(baseEntry({ contentType, providerId: 888 })),
    () => writeStore.update(`anilist:${contentType}:777`, { currentChapter: 5 }),
    () => writeStore.remove(`anilist:${contentType}:777`)
  ]) {
    const beforeWrites = writeStorage.calls.set;
    const failedWrite = mutate();
    assert.strictEqual(failedWrite.ok, false);
    assert.strictEqual(failedWrite.code, 'STORAGE_WRITE_FAILED');
    assert.strictEqual(writeStorage.calls.set, beforeWrites + 1);
    assert.strictEqual(writeStorage.values.get(READING_LIST_KEY), previousSerialized);
    assert.strictEqual(writeStore.getState(), previousState);
    assert.strictEqual(JSON.stringify(writeStore.getState()), previousSnapshot);
  }
}
assert.strictEqual(writeStorage.calls.remove, 0, 'removing an entry writes the collection without discarding the key');

// A throwing removeItem cannot commit an explicit clear to memory either.
writeStorage.failures.remove = true;
const beforeClearWrites = writeStorage.calls.set;
const failedClear = writeStore.clearReadingList({ confirmed: true });
assert.strictEqual(failedClear.ok, false);
assert.strictEqual(failedClear.code, 'STORAGE_REMOVE_FAILED');
assert.strictEqual(writeStorage.calls.remove, 1);
assert.strictEqual(writeStorage.calls.set, beforeClearWrites);
assert.strictEqual(writeStorage.values.get(READING_LIST_KEY), previousSerialized);
assert.strictEqual(writeStore.getState(), previousState);
assert.strictEqual(JSON.stringify(writeStore.getState()), previousSnapshot);
writeStorage.failures.set = false;
writeStorage.failures.remove = false;
assert.strictEqual(writeStore.remove('anilist:manhua:777').ok, true, 'a failed mutation can be retried');
assert.strictEqual(writeStore.clearReadingList({ confirmed: true }).ok, true, 'a failed clear can be retried');
assert.deepStrictEqual(writeStore.getState().entries, []);
assert.strictEqual(writeStorage.values.has(READING_LIST_KEY), false);

// Refreshing catalog totals is not a user completion action, even after reload.
const metadataStorage = makeStorage();
const metadataStore = createReadingListStore(metadataStorage, { now: () => NOW });
assert.strictEqual(metadataStore.add(baseEntry({ readingStatus: 'completed', currentChapter: 8, totalChapters: 8 })).ok, true);
const completionTime = metadataStore.getState().entries[0].updatedAt;
assert.strictEqual(metadataStore.updateMetadata(identity, { totalChapters: 12, title: 'Updated title' }).ok, true);
assert.strictEqual(metadataStore.getState().entries[0].currentChapter, 8);
assert.strictEqual(metadataStore.getState().entries[0].readingStatus, 'completed');
assert.strictEqual(metadataStore.getState().entries[0].updatedAt, completionTime);
assert.strictEqual(metadataStore.load().value.entries[0].currentChapter, 8);
assert.strictEqual(metadataStore.updateMetadata(identity, { totalChapters: 4 }).ok, true);
assert.strictEqual(metadataStore.getState().entries[0].progressExceedsTotal, true);
assert.strictEqual(metadataStore.updateMetadata(identity, { totalChapters: null }).ok, true);
assert.strictEqual(metadataStore.load().value.entries[0].currentChapter, 8);
assert.strictEqual(metadataStore.getState().entries[0].totalChapters, null);
assert.strictEqual(metadataStore.updateMetadata(identity, { currentChapter: 1 }).code, 'INVALID_METADATA');
assert.strictEqual(metadataStore.updateMetadata(identity, { totalChapters: 0 }).code, 'INVALID_TOTAL');
const priorMetadataState = metadataStore.getState();
const priorMetadataRaw = metadataStorage.values.get(READING_LIST_KEY);
metadataStorage.failures.set = true;
assert.strictEqual(metadataStore.updateMetadata(identity, { title: 'Must not persist' }).code, 'STORAGE_WRITE_FAILED');
assert.strictEqual(metadataStore.getState(), priorMetadataState);
assert.strictEqual(metadataStorage.values.get(READING_LIST_KEY), priorMetadataRaw);
metadataStorage.failures.set = false;
assert.strictEqual(metadataStore.updateMetadata(identity, { totalChapters: 12 }).ok, true);
assert.strictEqual(metadataStore.update(identity, { readingStatus: 'completed' }).ok, true);
assert.strictEqual(metadataStore.getState().entries[0].currentChapter, 12, 'an explicit completion still advances to the known total');
assert.strictEqual(metadataStore.update(identity, { currentChapter: 3 }).ok, true);
assert.strictEqual(metadataStore.load().value.entries[0].currentChapter, 3, 'explicit corrections persist while status remains completed');
assert.strictEqual(metadataStore.getState().entries[0].readingStatus, 'completed');

// Every fixture starts with existing anime data. Successful, blocked, and
// throwing operations must leave it byte-for-byte intact and never access it.
for (const fixture of storageFixtures) {
  assert.strictEqual(fixture.values.get(ANIME_WATCHLIST_KEY), ANIME_SENTINEL);
  assert.ok(fixture.calls.keys.length > 0);
  assert.deepStrictEqual([...new Set(fixture.calls.keys)], [READING_LIST_KEY]);
}

console.log('Reading-list normalization, identity, recovery, duplicate, storage, rollback, and anime-isolation contracts passed.');
