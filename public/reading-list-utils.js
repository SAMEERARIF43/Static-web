/* Pure, provider-aware guest reading-list contracts for Milestone 2. */

const READING_LIST_KEY = 'anime_hub_reading_list';
const READING_LIST_SCHEMA_VERSION = 1;
const READING_STATUS_VALUES = Object.freeze([
  'reading', 'completed', 'plan_to_read', 'on_hold', 'dropped'
]);
const CONTENT_TYPES = new Set(['manga', 'manhwa', 'manhua']);
const PROVIDERS = new Set(['anilist']);
const INTEGER_STRING = /^(0|[1-9][0-9]*)$/;

class ReadingListError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReadingListError';
    this.code = code;
    Object.assign(this, details);
  }
}

function invalid(code, message, details) {
  throw new ReadingListError(code, message, details);
}

function normalizeNonNegativeInteger(value, field, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined)) return null;

  let number = value;
  if (typeof value === 'string') {
    if (!INTEGER_STRING.test(value)) {
      invalid('INVALID_INTEGER', `${field} must be a canonical non-negative integer.`);
    }
    number = Number(value);
  }
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    invalid('INVALID_INTEGER', `${field} must be a non-negative safe integer.`);
  }
  return number;
}

function normalizeReadingChapter(value, field = 'currentChapter') {
  return normalizeNonNegativeInteger(value, field);
}

function normalizeReadingTotal(value) {
  if (value === null || value === undefined) return null;
  const total = normalizeNonNegativeInteger(value, 'totalChapters');
  if (total === 0) invalid('INVALID_TOTAL', 'totalChapters must be positive or null.');
  return total;
}

function normalizeReadingStatus(value) {
  if (typeof value !== 'string' || !READING_STATUS_VALUES.includes(value)) {
    invalid('INVALID_STATUS', 'readingStatus is not supported.');
  }
  return value;
}

function normalizeProvider(value) {
  if (typeof value !== 'string' || !PROVIDERS.has(value)) {
    invalid('INVALID_PROVIDER', 'provider is not supported.');
  }
  return value;
}

function normalizeContentType(value) {
  if (typeof value !== 'string' || !CONTENT_TYPES.has(value)) {
    invalid('INVALID_CONTENT_TYPE', 'contentType must be manga, manhwa, or manhua.');
  }
  return value;
}

function normalizeProviderId(value) {
  const id = normalizeNonNegativeInteger(value, 'providerId');
  if (id < 1) invalid('INVALID_PROVIDER_ID', 'providerId must be a positive safe integer.');
  return id;
}

function normalizeTimestamp(value, field, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

function timestampMilliseconds(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return Date.parse(value);
}

function readingEntryKey(entry) {
  return `${entry.provider}:${entry.contentType}:${entry.providerId}`;
}

function normalizeReadingEntry(input, { now = () => new Date().toISOString(), applyCompletion = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('INVALID_ENTRY', 'A reading-list entry must be an object.');
  }

  const provider = normalizeProvider(input.provider);
  const providerId = normalizeProviderId(input.providerId);
  const contentType = normalizeContentType(input.contentType);
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500) {
    invalid('INVALID_TITLE', 'title must be a non-empty string of 500 characters or fewer.');
  }
  if (input.poster !== undefined && typeof input.poster !== 'string') {
    invalid('INVALID_POSTER', 'poster must be a string when supplied.');
  }

  const readingStatus = normalizeReadingStatus(input.readingStatus === undefined ? 'plan_to_read' : input.readingStatus);
  const currentChapter = normalizeReadingChapter(input.currentChapter === undefined ? 0 : input.currentChapter);
  const totalChapters = normalizeReadingTotal(input.totalChapters);
  const createdAt = normalizeTimestamp(input.createdAt, 'createdAt', now());
  const updatedAt = normalizeTimestamp(input.updatedAt, 'updatedAt', now());
  let normalizedCurrent = currentChapter;

  // Completion can advance to a known total, but it must never erase a larger
  // user value after provider metadata decreases.
  if (applyCompletion && readingStatus === 'completed' && totalChapters !== null && currentChapter <= totalChapters) {
    normalizedCurrent = totalChapters;
  }

  const progressExceedsTotal = totalChapters !== null && normalizedCurrent > totalChapters;
  return {
    provider,
    providerId,
    contentType,
    title: input.title,
    poster: input.poster || '',
    readingStatus,
    currentChapter: normalizedCurrent,
    totalChapters,
    createdAt,
    updatedAt,
    progressExceedsTotal
  };
}

function compareCandidates(a, b) {
  const aTime = a.sourceUpdatedAtTime;
  const bTime = b.sourceUpdatedAtTime;
  if (aTime !== null && bTime === null) return 1;
  if (aTime === null && bTime !== null) return -1;
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime > bTime ? 1 : -1;
  return a.index > b.index ? 1 : -1;
}

function stripDerived(entry) {
  const { progressExceedsTotal: _progressExceedsTotal, ...persisted } = entry;
  return persisted;
}

function normalizeReadingList(envelope, options = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    invalid('INVALID_ENVELOPE', 'Reading-list storage must be a versioned object.');
  }
  if (envelope.schemaVersion !== READING_LIST_SCHEMA_VERSION) {
    invalid('UNSUPPORTED_VERSION', `Unsupported reading-list schema version: ${envelope.schemaVersion}.`);
  }
  if (!Array.isArray(envelope.entries)) {
    invalid('INVALID_ENTRIES', 'Reading-list entries must be an array.');
  }

  const candidates = new Map();
  const invalidEntries = [];
  envelope.entries.forEach((entry, index) => {
    try {
      // Loading a snapshot is not a new user completion action. In particular,
      // a provider total increase must never advance previously saved progress.
      const normalized = normalizeReadingEntry(entry, { ...options, applyCompletion: false });
      // Entry defaults must not make a missing source timestamp win a duplicate.
      const candidate = { entry: normalized, index, sourceUpdatedAtTime: timestampMilliseconds(entry.updatedAt) };
      const key = readingEntryKey(normalized);
      if (!candidates.has(key) || compareCandidates(candidate, candidates.get(key)) > 0) {
        candidates.set(key, candidate);
      }
    } catch (error) {
      invalidEntries.push({ index, error });
    }
  });

  if (invalidEntries.length) {
    invalid('INVALID_ENTRIES', 'One or more reading-list entries require explicit recovery.', {
      invalidEntries
    });
  }

  const entries = [...candidates.values()]
    .sort((a, b) => a.index - b.index)
    .map(candidate => candidate.entry);
  return { schemaVersion: READING_LIST_SCHEMA_VERSION, entries };
}

function serializeReadingList(collection) {
  if (!collection || collection.schemaVersion !== READING_LIST_SCHEMA_VERSION || !Array.isArray(collection.entries)) {
    invalid('INVALID_COLLECTION', 'Cannot serialize an invalid reading-list collection.');
  }
  return JSON.stringify({
    schemaVersion: READING_LIST_SCHEMA_VERSION,
    entries: collection.entries.map(stripDerived)
  });
}

function parseReadingList(raw, options = {}) {
  if (raw === null || raw === undefined) {
    return { ok: true, value: { schemaVersion: READING_LIST_SCHEMA_VERSION, entries: [] }, raw: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, code: 'MALFORMED_JSON', message: 'Saved reading-list data is not text.', raw, recoveryRequired: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'MALFORMED_JSON', message: 'Saved reading-list JSON is malformed.', raw, recoveryRequired: true };
  }
  try {
    return { ok: true, value: normalizeReadingList(parsed, options), raw };
  } catch (error) {
    return { ok: false, code: error.code || 'INVALID_STORAGE', message: error.message, raw, recoveryRequired: true, details: error };
  }
}

function resultError(result) {
  return { ok: false, code: result.code, message: result.message, recoveryRequired: result.recoveryRequired === true };
}

function createReadingListStore(storage, { now = () => new Date().toISOString() } = {}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
    throw new TypeError('A reading-list storage adapter must implement getItem, setItem, and removeItem.');
  }

  let state = null;
  let loadResult = null;

  function load() {
    let raw;
    try {
      raw = storage.getItem(READING_LIST_KEY);
    } catch (error) {
      loadResult = { ok: false, code: 'STORAGE_READ_FAILED', message: 'Could not read the saved reading list.', recoveryRequired: true, cause: error };
      state = null;
      return loadResult;
    }
    const parsed = parseReadingList(raw, { now });
    if (!parsed.ok) {
      loadResult = parsed;
      state = null;
      return parsed;
    }
    state = parsed.value;
    loadResult = parsed;
    return parsed;
  }

  function ensureLoaded() {
    if (!loadResult) load();
    return loadResult?.ok ? null : resultError(loadResult);
  }

  function persist(next) {
    const previous = state;
    const serialized = serializeReadingList(next);
    try {
      storage.setItem(READING_LIST_KEY, serialized);
    } catch (error) {
      state = previous;
      return { ok: false, code: 'STORAGE_WRITE_FAILED', message: 'Could not save the reading list; your previous state was kept.', cause: error };
    }
    state = next;
    loadResult = { ok: true, value: next, raw: serialized };
    return { ok: true, value: next };
  }

  function add(input) {
    const blocked = ensureLoaded();
    if (blocked) return blocked;
    let entry;
    try { entry = normalizeReadingEntry(input, { now }); } catch (error) { return resultError({ ...error, message: error.message, recoveryRequired: false }); }
    if (state.entries.some(item => readingEntryKey(item) === readingEntryKey(entry))) {
      return { ok: false, code: 'DUPLICATE_ENTRY', message: 'That title is already in the reading list.' };
    }
    return persist({ schemaVersion: READING_LIST_SCHEMA_VERSION, entries: [...state.entries, entry] });
  }

  function update(identity, changes) {
    const blocked = ensureLoaded();
    if (blocked) return blocked;
    const index = state.entries.findIndex(item => readingEntryKey(item) === identity);
    if (index < 0) return { ok: false, code: 'NOT_FOUND', message: 'The reading-list entry was not found.' };
    try {
      // Only a status action requests completion; an explicit chapter correction
      // must remain possible even while a title retains its completed status.
      const nextEntry = normalizeReadingEntry({ ...state.entries[index], ...changes, updatedAt: now() }, {
        now, applyCompletion: changes?.readingStatus === 'completed'
      });
      if (readingEntryKey(nextEntry) !== identity) {
        invalid('IDENTITY_CHANGE_NOT_ALLOWED', 'Updates cannot change the reading-list identity (provider, contentType, or providerId).');
      }
      const entries = state.entries.slice();
      entries[index] = nextEntry;
      return persist({ schemaVersion: READING_LIST_SCHEMA_VERSION, entries });
    } catch (error) {
      return resultError({ ...error, message: error.message, recoveryRequired: false });
    }
  }

  function remove(identity) {
    const blocked = ensureLoaded();
    if (blocked) return blocked;
    const entries = state.entries.filter(item => readingEntryKey(item) !== identity);
    if (entries.length === state.entries.length) return { ok: true, value: state };
    return persist({ schemaVersion: READING_LIST_SCHEMA_VERSION, entries });
  }

  function updateMetadata(identity, changes) {
    const blocked = ensureLoaded();
    if (blocked) return blocked;
    const index = state.entries.findIndex(item => readingEntryKey(item) === identity);
    if (index < 0) return { ok: false, code: 'NOT_FOUND', message: 'The reading-list entry was not found.' };
    try {
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
          Object.keys(changes).some(key => !['title', 'poster', 'totalChapters'].includes(key))) {
        invalid('INVALID_METADATA', 'Catalog refresh may only change title, poster, or chapter total.');
      }
      // Catalog metadata is not a user progress edit: retain status, chapter,
      // timestamps, and identity even if a completed title gains new chapters.
      const nextEntry = normalizeReadingEntry({ ...state.entries[index], ...changes }, { now, applyCompletion: false });
      const entries = state.entries.slice();
      entries[index] = nextEntry;
      return persist({ schemaVersion: READING_LIST_SCHEMA_VERSION, entries });
    } catch (error) {
      return resultError({ ...error, message: error.message, recoveryRequired: false });
    }
  }

  function clearReadingList({ confirmed = false } = {}) {
    if (!confirmed) return { ok: false, code: 'CLEAR_CONFIRMATION_REQUIRED', message: 'Clearing the reading list requires explicit confirmation.' };
    try {
      storage.removeItem(READING_LIST_KEY);
    } catch (error) {
      return { ok: false, code: 'STORAGE_REMOVE_FAILED', message: 'Could not clear the reading list.', cause: error };
    }
    state = { schemaVersion: READING_LIST_SCHEMA_VERSION, entries: [] };
    loadResult = { ok: true, value: state, raw: null };
    return { ok: true, value: state };
  }

  return { load, add, update, updateMetadata, remove, clearReadingList, getState: () => state };
}

const readingListUtils = {
  READING_LIST_KEY,
  READING_LIST_SCHEMA_VERSION,
  READING_STATUS_VALUES,
  CONTENT_TYPES,
  ReadingListError,
  normalizeReadingStatus,
  normalizeReadingChapter,
  normalizeReadingTotal,
  normalizeReadingEntry,
  normalizeReadingList,
  readingEntryKey,
  serializeReadingList,
  parseReadingList,
  createReadingListStore
};

if (typeof module === 'object' && module.exports) module.exports = readingListUtils;
if (typeof globalThis === 'object') globalThis.AnimeHubReadingListUtils = readingListUtils;
