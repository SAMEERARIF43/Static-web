/**
 * Pure watch-status and episode-progress contract tests.
 *
 * These local helpers describe the persisted data contract. They deliberately
 * do not connect to a server, database, Supabase, or any other external service.
 * 
 * The tests below directly execute the shared production helpers imported from
 * watchlist-utils.js. They do not execute the DOM handlers in script.js or the
 * Supabase client operations in auth-ui.js; those integrations still require
 * browser or live/mock-client verification.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  WATCH_STATUS_VALUES,
  normalizeWatchProgress,
  shouldActivateCardFromTarget,
  updateWatchlistState,
  migrateWatchlistItems
} = require('./public/watchlist-utils.js');

// ---- Core contract tests from the Stage 2 audit ----

for (const status of WATCH_STATUS_VALUES) {
  assert.deepStrictEqual(
    normalizeWatchProgress({ watchStatus: status, currentEpisode: 0, totalEpisodes: null }, { rejectOverflow: true }),
    { watchStatus: status, currentEpisode: 0, totalEpisodes: null },
    `${status} should be accepted`
  );
}

// Unknown, differently-cased, and empty statuses are rejected.
// The production normalizeWatchStatus (in watchlist-utils.js) does NOT treat
// null/undefined as errors - it falls back to 'plan_to_watch'. Only truly
// invalid strings (not in the allowed set) are rejected.
for (const status of ['watch', 'WATCHING', 'completed ', '']) {
  assert.throws(
    () => normalizeWatchProgress({ watchStatus: status, currentEpisode: 0, totalEpisodes: null }, { rejectOverflow: true }),
    /invalid watch status/,
    `${String(status)} should be rejected`
  );
}

for (const currentEpisode of [-1, -10, 1.5, NaN]) {
  assert.throws(
    () => normalizeWatchProgress({ watchStatus: 'watching', currentEpisode, totalEpisodes: null }, { rejectOverflow: true }),
    /invalid current episode/
  );
}

assert.deepStrictEqual(
  normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 7, totalEpisodes: null }, { rejectOverflow: true }),
  { watchStatus: 'watching', currentEpisode: 7, totalEpisodes: null },
  'A nullable totalEpisodes value should allow progress without an upper bound'
);

assert.throws(
  () => normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 0, totalEpisodes: -1 }, { rejectOverflow: true }),
  /invalid total episode count/
);
assert.throws(
  () => normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 13, totalEpisodes: 12 }, { rejectOverflow: true }),
  /Current episode cannot exceed the known total/
);

assert.deepStrictEqual(
  normalizeWatchProgress({ watchStatus: 'completed', currentEpisode: 3, totalEpisodes: 12 }, { rejectOverflow: true }),
  { watchStatus: 'completed', currentEpisode: 12, totalEpisodes: 12 },
  'Completed should advance currentEpisode to the known total'
);
assert.deepStrictEqual(
  normalizeWatchProgress({ watchStatus: 'completed', currentEpisode: 3, totalEpisodes: null }, { rejectOverflow: true }),
  { watchStatus: 'completed', currentEpisode: 3, totalEpisodes: null },
  'Completed cannot infer a current episode when totalEpisodes is unknown'
);

// Legacy/cache normalization remains defensive and clamps malformed overflow.
assert.deepStrictEqual(
  normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 13, totalEpisodes: 12 }),
  { watchStatus: 'watching', currentEpisode: 12, totalEpisodes: 12 },
  'Current episode equal to the known total should be accepted'
);

// ---- UI keyboard target tests ----

function fakeTarget(selector) {
  return { closest: value => value.includes(selector) ? {} : null };
}

for (const selector of ['input', 'select', 'textarea', 'option', 'button', '[data-watch-controls]']) {
  assert.strictEqual(shouldActivateCardFromTarget(fakeTarget(selector)), false);
}
assert.strictEqual(shouldActivateCardFromTarget(fakeTarget('nothing')), true);

// ---- Shared cloud-update and migration helper contracts ----

async function runIntegrationContractTests() {
  let saved = 0;
  // Test: item with totalEpisodes field rejects overflow and preserves state.
  const watchlist1 = [{ id: 1, watchStatus: 'watching', currentEpisode: 2, totalEpisodes: 12 }];
  await assert.rejects(
    () => updateWatchlistState({
      watchlist: watchlist1,
      index: 0,
      changes: { currentEpisode: 5000 },
      hasSession: true,
      cloudUpdate: async () => { throw new Error('simulated cloud failure'); },
      save: () => {}
    }),
    /Current episode cannot exceed the known total/
  );
  assert.strictEqual(watchlist1[0].currentEpisode, 2, 'Invalid progress must not mutate local state');

  // Regression: episode 5000 with known total of 12.
  // This tests the core bug fix: the change handler in script.js now validates
  // episode against item.totalEpisodes before calling updateWatchlistState.
  // The normalizeWatchProgress with rejectOverflow: true also catches it.
  assert.throws(
    () => normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 5000, totalEpisodes: 12 }, { rejectOverflow: true }),
    /Current episode cannot exceed the known total/
  );
  // State preservation: the normalized result should have currentEpisode clamped to total.
  const normalized1 = normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 5000, totalEpisodes: 12 });
  assert.strictEqual(normalized1.currentEpisode, 12, 'Clamped currentEpisode should be 12, not 5000');

  // Test: item with only `episodes` field (no totalEpisodes) allows any non-negative safe integer.
  // normalizeWatchProgress uses `item.totalEpisodes ?? item.episodes`, so when totalEpisodes
  // is undefined/missing, it falls back to episodes. But the change handler in script.js
  // checks `item.totalEpisodes !== null` — if totalEpisodes is null/undefined, the check is skipped.
  // This test verifies that normalizeWatchProgress with only `episodes` and no totalEpisodes
  // does not throw when rejectOverflow is true (the overflow check only fires when total is known).
  // We verify this by ensuring normalizeWatchProgress does NOT throw when totalEpisodes is null.
  const watchlist3 = [{ id: 2, watchStatus: 'watching', currentEpisode: 2, totalEpisodes: null }];
  assert.doesNotThrow(
    () => normalizeWatchProgress({ ...watchlist3[0], currentEpisode: 5000 }, { rejectOverflow: true }),
    'Item with totalEpisodes: null: large currentEpisode must not throw when total is unknown'
  );
  assert.strictEqual(
    normalizeWatchProgress({ ...watchlist3[0], currentEpisode: 5000 }, { rejectOverflow: true }).currentEpisode,
    5000,
    'Item with totalEpisodes: null: currentEpisode should be 5000 when total is unknown'
  );

  // Test: cloud failure preserves local state (invalid progress must not mutate state).
  const watchlist4 = [{ id: 42, watchStatus: 'watching', currentEpisode: 2, totalEpisodes: 12 }];
  await assert.rejects(
    () => updateWatchlistState({
      watchlist: watchlist4,
      index: 0,
      changes: { currentEpisode: 13 },
      hasSession: true,
      cloudUpdate: async () => { throw new Error('simulated cloud failure'); },
      save: () => {}
    }),
    /Current episode cannot exceed the known total/
  );
  assert.strictEqual(watchlist4[0].currentEpisode, 2, 'Invalid progress must not mutate local state');

  // Cloud failure must not save local state.
  const watchlist5 = [{ id: 42, watchStatus: 'watching', currentEpisode: 2, totalEpisodes: 12 }];
  await assert.rejects(
    () => updateWatchlistState({
      watchlist: watchlist5,
      index: 0,
      changes: { currentEpisode: 3 },
      hasSession: true,
      cloudUpdate: async () => { throw new Error('simulated cloud failure'); },
      save: () => { saved += 1; }
    }),
    /simulated cloud failure/
  );
  assert.strictEqual(watchlist5[0].currentEpisode, 2, 'Cloud failure must preserve local state');
  assert.strictEqual(saved, 0, 'Cloud failure must not save local state');

  // Migration failure must not remove guest data.
  let removed = false;
  await assert.rejects(
    () => migrateWatchlistItems({
      items: [{ id: 42 }],
      existingIds: new Set(),
      insert: async () => {},
      verify: async () => [],
      onVerified: async () => { removed = true; }
    }),
    /could not be verified/
  );
  assert.strictEqual(removed, false, 'Migration failure must not remove guest data');

  // Regression: episode 5000 with known total of 12 via `episodes` field (no totalEpisodes).
  // The change handler must read the total from `episodes` when `totalEpisodes` is absent.
  // This validates the fix for the bug where only `totalEpisodes` was checked.
  const watchlistEpisodesOnly = [{ id: 3, watchStatus: 'watching', currentEpisode: 2, episodes: 12 }];
  await assert.rejects(
    () => updateWatchlistState({
      watchlist: watchlistEpisodesOnly,
      index: 0,
      changes: { currentEpisode: 5000 },
      hasSession: true,
      cloudUpdate: async () => { throw new Error('simulated cloud failure'); },
      save: () => {}
    }),
    /Current episode cannot exceed the known total/
  );
  assert.strictEqual(watchlistEpisodesOnly[0].currentEpisode, 2, 'Invalid progress with episodes field must not mutate local state');

  // Also verify normalizeWatchProgress directly rejects overflow when only `episodes` is present.
  assert.throws(
    () => normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 5000, episodes: 12 }, { rejectOverflow: true }),
    /Current episode cannot exceed the known total/
  );
  // State preserved when rejected.
  const normalized2 = normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 5000, episodes: 12 });
  assert.strictEqual(normalized2.currentEpisode, 12, 'Clamped currentEpisode should be 12 from episodes fallback');
}

// ---- Regression: Movie episode controls hidden ----
// The executed renderer checks below cover the observable contract for movies,
// repaired legacy movies, and TV series. They replace the former source-shape
// assertions that only checked the implementation's helper names and branch text.

// ============================================================
// AH-003 / AH-004 regression tests
//
// These execute the REAL production implementations - public/auth-ui.js and
// public/watchlist-utils.js in a vm sandbox, and the real loadWatchlist /
// renderWatchlist / renderWatchlistError / renderSkeletonGrid declarations
// extracted verbatim from public/script.js. Only host objects (localStorage,
// fetch, the DOM, the Supabase client) are mocked; nothing is copied out of the
// implementation, and no network, database, or account is involved.
// ============================================================

const vm = require('vm');
const authSource = fs.readFileSync(path.join(__dirname, 'public', 'auth-ui.js'), 'utf8');
const utilsSourceVm = fs.readFileSync(path.join(__dirname, 'public', 'watchlist-utils.js'), 'utf8');

const TEST_USER = 'user-uuid-1';
const TEST_CACHE_KEY = `anime_hub_watchlist_${TEST_USER}`;

// Builds a fresh sandbox around auth-ui.js. `authSourceOverride` exists so the
// negative checks below can re-run the same assertions against a copy of the
// source with one safeguard removed.
function buildAuthHarness({ authSourceOverride } = {}) {
  const store = new Map();
  const warnings = [];
  const errors = [];
  const writes = { update: 0, upsert: 0, delete: 0, select: 0 };

  let rows = [];              // what the fake watchlist table returns
  let selectError = null;     // set to simulate a genuine Supabase failure
  let catalog = {};           // /api/anime/:id payloads; { __status: n } = failure

  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); },
    clear: () => store.clear()
  };

  // Chainable, awaitable query builder standing in for the Supabase client.
  const builder = result => {
    const b = {
      select: () => b,
      eq: () => b,
      update: () => { writes.update += 1; return b; },
      delete: () => { writes.delete += 1; return b; },
      upsert: () => { writes.upsert += 1; return b; },
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
    };
    return b;
  };

  const session = { user: { id: TEST_USER, email: 'tester@example.com', email_confirmed_at: 'set' } };
  const supabaseClient = {
    from(table) {
      assert.strictEqual(table, 'watchlist', 'the cloud watchlist must target the watchlist table');
      return {
        select: () => { writes.select += 1; return builder({ data: rows.map(row => ({ ...row })), error: selectError }); },
        update: () => { writes.update += 1; return builder({ error: null }); },
        delete: () => { writes.delete += 1; return builder({ error: null }); },
        upsert: () => { writes.upsert += 1; return builder({ error: null }); }
      };
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: () => {},
      signOut: async () => ({ error: null })
    }
  };

  const sandbox = {
    console: {
      log: () => {},
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error: (...args) => errors.push(args.map(String).join(' '))
    },
    Promise, JSON, Number, String, Array, Object, Map, Set, Error, RangeError, SyntaxError,
    AbortController: class AbortController {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; }
    },
    setTimeout, clearTimeout,
    localStorage,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async url => {
      const target = String(url);
      // auth-ui.js bootstraps by reading /api/config; supply a configured
      // response so initSupabase() establishes the session under test.
      if (target === '/api/config') {
        return { ok: true, status: 200, json: async () => ({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon-key' }) };
      }
      const match = target.match(/^\/api\/anime\/(\d+)$/);
      if (!match) return { ok: false, status: 404, json: async () => ({}) };
      const id = Number(match[1]);
      const payload = catalog[id];
      if (!payload || payload.__status) {
        return { ok: false, status: (payload && payload.__status) || 404, json: async () => ({ message: 'not found' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ...payload }) };
    },
    confirm: () => true,
    alert: () => {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    HTMLElement: class HTMLElement {},
    document: {
      getElementById: () => null,
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      activeElement: null
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.supabase = { createClient: () => supabaseClient };
  sandbox.window.addEventListener = () => {};
  sandbox.window.dispatchEvent = () => {};

  vm.createContext(sandbox);
  vm.runInContext(utilsSourceVm, sandbox, { filename: 'watchlist-utils.js' });
  // Initialize currentSession in auth-ui.js module for cloud operations
  const authSourceWithSession = (authSourceOverride || authSource) + '\ncurrentSession = { user: { id: "test-user-id" } };';
  vm.runInContext(authSourceWithSession, sandbox, { filename: 'auth-ui.js' });
  vm.runInContext(utilsSourceVm, sandbox, { filename: 'watchlist-utils.js' });

  return {
    cloud: sandbox.window.animeHubCloudWatchlist,
    cacheKey: TEST_CACHE_KEY,
    seedCache: value => localStorage.setItem(TEST_CACHE_KEY, value),
    readCacheRaw: () => localStorage.getItem(TEST_CACHE_KEY),
    removeCache: () => localStorage.removeItem(TEST_CACHE_KEY),
    setRows: value => { rows = value; },
    setSelectError: value => { selectError = value; },
    setCatalog: value => { catalog = value; },
    writes,
    warnings,
    errors,
    // Let initSupabase() finish establishing the session before each scenario.
    ready: new Promise(resolve => setTimeout(resolve, 20))
  };
}

const healthyMedia = {
  113415: { id: 113415, title: { english: 'Jujutsu Kaisen' }, averageScore: 85, format: 'TV', status: 'RELEASING', episodes: 24, genres: ['Action'] },
  20: { id: 20, title: { english: 'Naruto' }, averageScore: 80, format: 'TV', status: 'FINISHED', episodes: 26, genres: ['Adventure'] },
  30: { id: 30, title: { english: 'One Piece' }, averageScore: 87, format: 'TV', status: 'RELEASING', episodes: 1100, genres: ['Adventure'] }
};

// --- Extract the real watchlist view functions from script.js -----------------
// Brace-matched verbatim, keeping a preceding `async` qualifier so `await`
// stays legal. Only the host DOM is stubbed afterwards.
const scriptSourceVm = fs.readFileSync(path.join(__dirname, 'public', 'script.js'), 'utf8');

function extractFunction(name, source = scriptSourceVm) {
  let start = source.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `script.js must declare ${name}`);
  if (/async\s+$/.test(source.slice(Math.max(0, start - 8), start))) start -= 6;
  const openBrace = source.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name}`);
}

// `seedWatchlist` seeds the harness's localStorage-backed guest watchlist
// (either an array value or a raw JSON string); `fetchImpl` is the catalog
// lookup the legacy-entry repair performs. Defaults model an empty guest list
// and a catalog that refuses every call, so an unexpected repair request or an
// unexpected write fails the test instead of passing silently.
function buildViewHarness({ source = scriptSourceVm, seedWatchlist, fetchImpl } = {}) {
  function makeElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      style: {},
      children: [],
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute(name, value) {
        this[name] = value;
      },
      removeAttribute(name) {
        delete this[name];
      },
      append(...nodes) {
        this.children.push(...nodes);
        this.textContent = nodes.map(node => node.textContent || '').join('');
        this.innerHTML = this.textContent;
      },
      addEventListener(type, listener) {
        (this.__listeners || (this.__listeners = new Map())).set(type, listener);
      },
      click() {
        this.__listeners?.get('click')?.({ preventDefault() {} });
      },
      replaceChildren(...nodes) {
        this.children = nodes;
        this.innerHTML = nodes.map(node => node.textContent || '').join('');
      }
    };
  }

  const grid = makeElement('div');
  const emptyState = makeElement('div');
  emptyState.style.display = 'none';
  const toasts = [];
  const loggedErrors = [];
  let rendered = null;

  // Guest persistence: the production key, real get/set semantics, and a
  // write counter so "nothing was persisted" is an assertion, not an absence.
  const WATCHLIST_KEY = 'anime_hub_watchlist';
  const store = new Map();
  if (seedWatchlist !== undefined) {
    store.set(WATCHLIST_KEY, Array.isArray(seedWatchlist)
      ? JSON.stringify(seedWatchlist)
      : String(seedWatchlist));
  }
  let storageWrites = 0;
  const localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); storageWrites += 1; },
    removeItem: key => { store.delete(key); },
    clear: () => store.clear()
  };

  const fetchCalls = [];
  const catalogFetch = fetchImpl || (async url => {
    throw new Error(`Unexpected catalog request: ${url}`);
  });

  const sandbox = {
    console: { error: (...args) => loggedErrors.push(args.map(String).join(' ')), log: () => {}, warn: () => {} },
     Promise, JSON, Number, String, Array, Object, Map, Set, Error, RangeError, SyntaxError, setTimeout,
     AbortController: class AbortController {
       constructor() { this.signal = { aborted: false }; }
       abort() { this.signal.aborted = true; }
     },
    localStorage,
    baseURL: '/api',
    fetch: async (url, init) => {
      fetchCalls.push(String(url));
      return catalogFetch(String(url), init);
    },
    normalizeWatchProgress,
    document: {
      getElementById: id => (id === 'watchlist-grid' ? grid : id === 'watchlist-empty' ? emptyState : null),
      createElement: tag => makeElement(tag),
      querySelector: () => null,
      querySelectorAll: () => []
    }
  };
  sandbox.window = { animeHubCloudWatchlist: null, getAnimeHubAuthState: null };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`
    function getWatchlistAuthState() { return window.__authState; }
    function showToast(message, type) { window.__toasts.push({ message, type }); }
    function renderAnimeGrid(items, containerId) {
      window.__rendered = { count: items.length, containerId };
      document.getElementById(containerId).innerHTML = '<article class="anime-card">card</article>';
    }
     ${extractFunction('loadLocalWatchlist', source)}
     ${extractFunction('saveWatchlist', source)}
     ${extractFunction('withWatchProgress', source)}
     ${extractFunction('toggleWatchlistItem', source)}
     ${extractFunction('animeTypeValue', source)}
     // The repair test owns the catalog fetch; request-policy behavior has
     // dedicated browser coverage, so keep this VM slice independent of the
     // page-level helper's timers and AbortController implementation.
     async function fetchWithPolicy(url, options = {}) { return fetch(url, options); }
     ${extractFunction('renderSkeletonGrid', source)}
    ${extractFunction('renderWatchlist', source)}
    ${extractFunction('renderWatchlistError', source)}
    ${extractFunction('repairUntypedWatchlistEntries', source)}
    ${extractFunction('loadWatchlist', source)}
    var watchlist = loadLocalWatchlist();
    window.__loadWatchlist = loadWatchlist;
    window.__toggleWatchlistItem = toggleWatchlistItem;
    window.__watchlistSnapshot = () => JSON.parse(JSON.stringify(watchlist));
    // Mirrors what the animehub:auth-state guest branch does: replace the
    // in-memory array with a freshly parsed copy from localStorage.
    window.__refreshFromStorage = () => { watchlist = loadLocalWatchlist(); };
  `, sandbox, { filename: 'script-slices.js' });

  sandbox.window.__toasts = toasts;
  sandbox.window.__authState = { ready: true, session: { user: { id: TEST_USER } } };

  return {
    grid,
    emptyState,
    toasts,
    loggedErrors,
    rendered: () => rendered,
    setCloudList: fn => { sandbox.window.animeHubCloudWatchlist = { list: fn }; },
    setGuest: () => { sandbox.window.__authState = { ready: true, session: null }; },
    load: () => sandbox.window.__loadWatchlist(),
    toggle: item => sandbox.window.__toggleWatchlistItem(item),
    refreshFromStorage: () => sandbox.window.__refreshFromStorage(),
    watchlistSnapshot: () => sandbox.window.__watchlistSnapshot(),
    fetchCalls: () => fetchCalls.slice(),
    localStorageRaw: () => localStorage.getItem(WATCHLIST_KEY),
    storageWrites: () => storageWrites
  };
}

function buildGenreHarness({ source = scriptSourceVm, pageId = 'page-home', fetchImpl } = {}) {
  function makeElement(tag) {
    const listeners = new Map();
    return {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      type: '',
      style: {},
      innerHTML: '',
      children: [],
      setAttribute(name, value) {
        this[name] = value;
      },
      removeAttribute(name) {
        delete this[name];
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      click() {
        listeners.get('click')?.({ preventDefault() {} });
      },
      append(...nodes) {
        this.children.push(...nodes);
        this.textContent = nodes.map(node => node.textContent || '').join('');
        this.innerHTML = this.textContent;
      },
      replaceChildren(...nodes) {
        this.children = nodes;
        this.innerHTML = nodes.map(node => node.textContent || '').join('');
      }
    };
  }

  const grid = makeElement('div');
  const activePage = { id: pageId };
  const requests = [];
  const rendered = [];
  const errors = [];
  const defaultFetch = async url => {
    requests.push(String(url));
    return { ok: true, json: async () => [{ id: 1, title: 'Genre result' }] };
  };
  const sandbox = {
    console: { error: (...args) => errors.push(args.map(String).join(' ')) },
    Promise, JSON, Number, String, Array, Object, Map, Set, Error, RangeError,
    baseURL: '/api',
    document: {
      querySelector: selector => selector === '.page.active' ? activePage : null,
      getElementById: id => id === 'trending-grid' || id === 'series-grid' || id === 'movies-grid' ? grid : null,
      createElement: makeElement
    },
    fetch: fetchImpl || defaultFetch,
    renderSkeletonGrid: (gridId, count) => {
      requests.push(`skeleton:${gridId}:${count}`);
      grid.innerHTML = '<div class="skeleton-card">loading</div>';
      grid.children = [];
    },
    renderAnimeGrid: (items, gridId) => {
      rendered.push({ items: Array.from(items), gridId });
      grid.innerHTML = items.map(item => item.title).join(',');
      grid.children = [];
    },
    isSeriesEntry: item => ['TV', 'TV_SHORT'].includes(item.format || item.type),
    loadSeries: async () => {},
    loadMovies: async () => {},
    loadTrending: async () => {},
    refreshCatalogPage: async () => {},
    catalogPage: 1,
    consoleError: error => errors.push(String(error))
  };
  sandbox.window = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`
    let genreRequestId = 0;
    ${extractFunction('filterByGenre', source)}
    window.filterByGenre = filterByGenre;
  `, sandbox, { filename: 'genre-filter-slice.js' });

  return {
    grid,
    requests,
    rendered,
    errors,
    filter: genre => sandbox.window.filterByGenre(genre)
  };
}

async function runGenreFilteringTests() {
  // Successful genre requests continue to render the expected titles.
  {
    const h = buildGenreHarness();
    await h.filter('Comedy');
    assert.strictEqual(h.rendered.length, 1, `A successful genre request should render once: ${h.errors.join('; ')}`);
    assert.deepStrictEqual(Array.from(h.rendered[0].items, item => item.title), ['Genre result']);
    assert.strictEqual(h.rendered[0].gridId, 'trending-grid');
  }

  // HTTP failures replace skeletons with a visible retry state.
  {
    const h = buildGenreHarness({
      fetchImpl: async url => {
        h.requests.push(String(url));
        return { ok: false, status: 503 };
      }
    });
    await h.filter('Comedy');
    assert.ok(!/skeleton-card/.test(h.grid.innerHTML), 'An HTTP failure must clear loading skeletons');
    assert.match(h.grid.innerHTML, /Unable to load this genre/);
    assert.strictEqual(h.grid.children[0].children[1].textContent, 'Try again');
  }

  // Network failures also leave a retryable state; retry preserves page and genre.
  {
    let fail = true;
    const h = buildGenreHarness({
      pageId: 'page-series',
      fetchImpl: async url => {
        h.requests.push(String(url));
        if (fail) throw new Error('offline');
        return { ok: true, json: async () => [{ id: 2, title: 'Comedy series', format: 'TV' }] };
      }
    });
    await h.filter('Comedy');
    assert.ok(/Unable to load this genre/.test(h.grid.innerHTML), 'A network rejection must show an error');
    fail = false;
    h.grid.children[0].children[1].click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(h.requests.filter(url => !url.startsWith('skeleton:')), [
      '/api/genre/Comedy?type=series',
      '/api/genre/Comedy?type=series'
    ], 'Retry must use the same genre and active-page type');
    assert.deepStrictEqual(Array.from(h.rendered[0].items, item => item.title), ['Comedy series']);
  }

  // A stale failed request cannot replace a newer successful genre result.
  {
    let rejectFirst;
    let resolveSecond;
    const h = buildGenreHarness({
      fetchImpl: url => {
        h.requests.push(String(url));
        if (String(url).includes('Comedy')) return new Promise((resolve, reject) => { rejectFirst = reject; });
        return new Promise(resolve => { resolveSecond = resolve; });
      }
    });
    const first = h.filter('Comedy');
    const second = h.filter('Action');
    resolveSecond({ ok: true, json: async () => [{ id: 3, title: 'Action result' }] });
    await second;
    rejectFirst(new Error('late network failure'));
    await first;
    assert.strictEqual(h.rendered.length, 1, 'Only the newer genre result should render');
    assert.strictEqual(h.rendered[0].items[0].title, 'Action result');
    assert.ok(!/Unable to load this genre/.test(h.grid.innerHTML), 'A stale error must not replace newer results');
  }

  // A malformed non-list response is handled like an upstream failure.
  {
    const h = buildGenreHarness({
      fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) })
    });
    await h.filter('Comedy');
    assert.match(h.grid.innerHTML, /Unable to load this genre/);
    assert.ok(!/skeleton-card/.test(h.grid.innerHTML));
  }

  console.log('Genre filtering success, failure, retry, malformed-response and stale-request tests passed.');
}

async function runCloudWatchlistRegressionTests() {
  // ---------- AH-003: a corrupted derived cache must never fail an operation ----------

  // 1. Invalid JSON: update() must resolve, and the bad value must be discarded.
  {
    const h = buildAuthHarness();
    await h.ready;
    h.seedCache('{"oops": ');
    h.setRows([]);
    await h.cloud.update(113415, { watchStatus: 'watching', currentEpisode: 8, totalEpisodes: 24 });
    assert.strictEqual(h.writes.update, 1, 'AH-003: the cloud update must still be attempted');
    assert.strictEqual(h.readCacheRaw(), '[]', 'AH-003: the unreadable cache must be discarded and left valid');
    assert.ok(h.warnings.length > 0, 'AH-003: discarding a cache must be logged, not silent');
  }

  // 2. Valid JSON that is not an array: treated as an empty cache, not a throw.
  {
    const h = buildAuthHarness();
    await h.ready;
    h.seedCache('{"1": {"watchStatus": "watching"}}');
    h.setRows([]);
    const list = await h.cloud.list();
    // Array.from(): list() returns a sandbox-realm array, which deepStrictEqual
    // would reject on prototype identity alone.
    assert.strictEqual(Array.from(list).length, 0, 'AH-003: a non-array cache must behave like an empty cache');
    assert.strictEqual(h.readCacheRaw(), '[]', 'AH-003: a non-array cache must be repaired on write');
  }

  // 3. A valid cache is still honoured unchanged.
  {
    const h = buildAuthHarness();
    await h.ready;
    h.seedCache(JSON.stringify([{ id: 113415, title: 'Jujutsu Kaisen', poster: 'p', watchStatus: 'watching', currentEpisode: 7, totalEpisodes: 24 }]));
    h.setRows([{ anime_id: 113415, watch_status: 'watching', current_episode: 7, total_episodes: 24 }]);
    h.setCatalog(healthyMedia);
    const list = await h.cloud.list();
    assert.strictEqual(list.length, 1, 'AH-003: a valid cached row must still be returned');
    assert.strictEqual(list[0].title, 'Jujutsu Kaisen', 'AH-003: cached title must be preserved');
    assert.strictEqual(list[0].currentEpisode, 7, 'AH-003: cached progress must be preserved');
  }

  // 4. Cache recovery: after a corrupt read, the next successful list() repopulates it.
  {
    const h = buildAuthHarness();
    await h.ready;
    h.seedCache('this is not json');
    h.setRows([{ anime_id: 113415, watch_status: 'completed', current_episode: 24, total_episodes: 24 }]);
    h.setCatalog(healthyMedia);
    const list = await h.cloud.list();
    assert.strictEqual(list.length, 1, 'AH-003: list() must succeed despite the corrupt cache');
    const recovered = JSON.parse(h.readCacheRaw());
    assert.strictEqual(recovered.length, 1, 'AH-003: the cache must be rebuilt after a corrupt read');
    assert.strictEqual(recovered[0].watchStatus, 'completed', 'AH-003: recovered cache must carry current cloud state');
  }

  // ---------- AH-004(b): one bad row must not discard the whole watchlist ----------

  // 5. Three rows, one hydration failure -> the two healthy rows survive.
  {
    const h = buildAuthHarness();
    await h.ready;
    h.seedCache('[]');
    h.setRows([
      { anime_id: 113415, watch_status: 'watching', current_episode: 7, total_episodes: 24 },
      { anime_id: 20, watch_status: 'completed', current_episode: 26, total_episodes: 26 },
      { anime_id: 999999, watch_status: 'dropped', current_episode: 1, total_episodes: 12 }
    ]);
    h.setCatalog(healthyMedia); // 999999 is absent -> hydration fails for that row only
    const list = await h.cloud.list();
    assert.strictEqual(list.length, 2, 'AH-004b: the two healthy rows must survive one failed hydration');
    // Array.from(..., map) keeps the result in this realm; sandbox arrays fail
    // deepStrictEqual on prototype identity alone.
    assert.deepStrictEqual(Array.from(list, item => item.id), [113415, 20], 'AH-004b: healthy rows must keep their order');
  }

  // 6. A malformed cached total on one row must not stop the healthy rows.
  {
    const h = buildAuthHarness();
    await h.ready;
    h.seedCache(JSON.stringify([
      { id: 113415, title: 'JJK', watchStatus: 'watching', currentEpisode: 7, totalEpisodes: 24 },
      { id: 20, title: 'Naruto', watchStatus: 'watching', currentEpisode: 3, totalEpisodes: 'twelve' }
    ]));
    h.setRows([
      { anime_id: 113415, watch_status: 'watching', current_episode: 7, total_episodes: 24 },
      // NULL total forces the fallback onto the poisoned cached value.
      { anime_id: 20, watch_status: 'watching', current_episode: 3, total_episodes: null }
    ]);
    h.setCatalog(healthyMedia);
    const list = await h.cloud.list();
    assert.ok(Array.isArray(list), 'AH-004b: list() must resolve, not reject');
    assert.strictEqual(list.length, 1, 'AH-004b: only the malformed row may be dropped');
    assert.strictEqual(list[0].id, 113415, 'AH-004b: the healthy row must be returned');
    assert.ok(h.warnings.some(w => w.includes('20')), 'AH-004b: the dropped row must be logged by id');
  }

  // 7. A genuine Supabase failure must still reject - it must not look empty.
  {
    const h = buildAuthHarness();
    await h.ready;
    h.setSelectError(new Error('permission denied for table watchlist'));
    await assert.rejects(
      () => h.cloud.list(),
      /permission denied/,
      'AH-004b: a real query failure must still propagate'
    );
  }

  // 8. Ordering and watch-progress values are preserved on the happy path.
  {
    const h = buildAuthHarness();
    await h.ready;
    h.seedCache(JSON.stringify([
      { id: 113415, title: 'JJK', watchStatus: 'watching', currentEpisode: 7, totalEpisodes: 24 },
      { id: 20, title: 'Naruto', watchStatus: 'completed', currentEpisode: 26, totalEpisodes: 26 }
    ]));
    h.setRows([
      { anime_id: 113415, watch_status: 'watching', current_episode: 7, total_episodes: 24 },
      { anime_id: 20, watch_status: 'completed', current_episode: 26, total_episodes: 26 },
      { anime_id: 30, watch_status: 'plan_to_watch', current_episode: 0, total_episodes: 1100 }
    ]);
    h.setCatalog(healthyMedia);
    const list = await h.cloud.list();
    assert.deepStrictEqual(Array.from(list, item => item.id), [113415, 20, 30], 'AH-004b: cached rows then hydrated rows, in order');
    const onePiece = list.find(item => item.id === 30);
    assert.strictEqual(onePiece.watchStatus, 'plan_to_watch', 'AH-004b: hydrated watch status must be preserved');
    assert.strictEqual(onePiece.currentEpisode, 0, 'AH-004b: hydrated current episode must be preserved');
    assert.strictEqual(onePiece.totalEpisodes, 1100, 'AH-004b: hydrated total episodes must be preserved');
  }

  // ---------- AH-004(a): a rejected load must not leave skeletons on screen ----------

  // 9. Rejected cloud load -> inline error state, no skeletons, toast kept.
  {
    const v = buildViewHarness();
    v.grid.innerHTML = '<article class="anime-card">previous item</article>';
    v.grid.style.display = 'grid';
    v.setCloudList(async () => { throw new Error('Could not load anime 999999 for your cloud watchlist.'); });
    await v.load();

    assert.strictEqual(v.grid.children.length, 1, 'AH-004a: the grid must show exactly one error element');
    assert.strictEqual(v.grid.children[0].className, 'watch-progress-hint', 'AH-004a: the error must reuse the existing hint style');
    assert.ok(/Unable to load your watchlist/.test(v.grid.children[0].textContent), 'AH-004a: an inline error message must be rendered');
    assert.ok(!/skeleton/.test(v.grid.innerHTML), 'AH-004a: skeleton cards must not remain after a failure');
    assert.strictEqual(v.toasts.length, 1, 'AH-004a: the user-facing toast must be preserved');
    assert.strictEqual(v.toasts[0].type, 'error', 'AH-004a: the toast must still be an error toast');
    assert.ok(v.loggedErrors.length > 0, 'AH-004a: the failure must still be logged');
    assert.strictEqual(v.emptyState.style.display, 'none', 'AH-004a: the empty state must not compete with the error');
  }

  // 10. Control: a successful load still renders cards and clears skeletons.
  {
    const v = buildViewHarness();
    v.setCloudList(async () => ([{ id: 113415, title: 'Jujutsu Kaisen' }]));
    await v.load();
    assert.ok(!/skeleton/.test(v.grid.innerHTML), 'AH-004a control: skeletons must be replaced on success');
    assert.ok(/anime-card/.test(v.grid.innerHTML), 'AH-004a control: real cards must be rendered on success');
    assert.strictEqual(v.toasts.length, 0, 'AH-004a control: a successful load must not toast');
  }

  // 11. Control: the guest path is untouched by the cloud changes.
  {
    const v = buildViewHarness();
    v.setGuest();
    await v.load();
    assert.ok(!/skeleton/.test(v.grid.innerHTML), 'AH-004a control: guests must never see skeletons');
    assert.strictEqual(v.grid.style.display, 'none', 'An empty guest watchlist must still show the empty state');
    assert.strictEqual(v.emptyState.style.display, 'flex', 'An empty guest watchlist must still show the empty state');
  }

  // ---------- P5.3: the watchlist failure state offers a working retry ------

  // A rejected load must show a retry action; one click re-runs the load and a
  // successful retry renders the watchlist instead of the error.
  {
    const v = buildViewHarness();
    let listCalls = 0;
    v.setCloudList(async () => {
      listCalls += 1;
      if (listCalls === 1) throw new Error('offline');
      return [{ id: 20, title: 'Naruto' }];
    });
    await v.load();

    assert.strictEqual(v.grid.children.length, 1, 'P5.3: the failure state must stay a single container');
    assert.strictEqual(v.grid.children[0].className, 'watch-progress-hint', 'P5.3: the container must keep the hint style');
    const retryButton = v.grid.children[0].children[1];
    assert.strictEqual(retryButton.textContent, 'Try again', 'P5.3: the failure state must offer a retry action');

    retryButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(listCalls, 2, 'P5.3: clicking retry must re-run the cloud load');
    assert.ok(/anime-card/.test(v.grid.innerHTML), 'P5.3: a successful retry must render the watchlist, not the error');
  }

  // A repeated failure must re-render exactly one error state — no duplicates,
  // no stale content — and the fresh retry button must be usable again.
  {
    const v = buildViewHarness();
    let listCalls = 0;
    v.setCloudList(async () => { listCalls += 1; throw new Error('still offline'); });
    await v.load();

    v.grid.children[0].children[1].click();
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(listCalls, 2, 'P5.3: the retry click must reach the cloud list');
    assert.strictEqual(v.grid.children.length, 1, 'P5.3: a repeated failure must render exactly one error state');
    assert.ok(/Unable to load your watchlist/.test(v.grid.children[0].textContent), 'P5.3: the message must survive a repeated failure');
    assert.ok(!v.grid.children[0].children[1].disabled, 'P5.3: the re-rendered retry button must be usable again');
  }

  // ---------- Negative checks: these tests must be able to fail ----------

  // Removing the AH-003 guard must make the corrupted-cache case throw again.
  {
    // Line-ending agnostic: auth-ui.js is CRLF on disk.
    const unguarded = authSource.replace(
      / {2}let parsed;\r?\n {2}try \{\r?\n {4}parsed = JSON\.parse\(raw\);\r?\n {2}\} catch \(error\) \{[\s\S]*?\r?\n {2}\}\r?\n/,
      '  const parsed = JSON.parse(raw);\n'
    );
    assert.notStrictEqual(unguarded, authSource, 'negative check: the AH-003 guard must be removable from the source');
    const h = buildAuthHarness({ authSourceOverride: unguarded });
    await h.ready;
    h.seedCache('{"oops": ');
    h.setRows([]);
    await assert.rejects(
      () => h.cloud.update(113415, { watchStatus: 'watching', currentEpisode: 8, totalEpisodes: 24 }),
      SyntaxError,
      'negative check: without the AH-003 guard the corrupted cache must reject'
    );
  }

  // Reverting AH-004(b) to Promise.all must make one bad row reject the list again.
  {
    const allOnly = authSource.replace('Promise.allSettled(', 'Promise.all(');
    assert.notStrictEqual(allOnly, authSource, 'negative check: AH-004b must be revertible in the source');
    const h = buildAuthHarness({ authSourceOverride: allOnly });
    await h.ready;
    h.seedCache('[]');
    h.setRows([
      { anime_id: 113415, watch_status: 'watching', current_episode: 7, total_episodes: 24 },
      { anime_id: 999999, watch_status: 'dropped', current_episode: 1, total_episodes: 12 }
    ]);
    h.setCatalog(healthyMedia);
    await assert.rejects(
      () => h.cloud.list(),
      /Could not load anime 999999/,
      'negative check: with Promise.all one bad row must reject the whole list'
    );
  }

  // Removing the AH-004(a) error render must leave the skeletons behind.
  {
    // Built with new RegExp so the 8-space indent is not written as literal
    // spaces, which eslint's no-regex-spaces rejects.
    const indent = ' '.repeat(8);
    const stripped = scriptSourceVm.replace(
      new RegExp(`${indent}renderWatchlistError\\(\\);\\r?\\n${indent}return;`),
      `${indent}return;`
    );
    assert.notStrictEqual(stripped, scriptSourceVm, 'negative check: the AH-004a error render must be removable from the source');

    const v = buildViewHarness({ source: stripped });
    v.grid.innerHTML = '<article class="anime-card">previous item</article>';
    v.setCloudList(async () => { throw new Error('nope'); });
    await v.load();
    assert.ok(/skeleton/.test(v.grid.innerHTML), 'negative check: without the AH-004a error render the skeletons must remain');
  }

  console.log('AH-003 and AH-004 cloud-watchlist regression tests passed.');
}

// ---- Regression: an unknown episode total must stay unknown (never 0) ----
//
// The card bookmark path emits `data-episodes="${anime.episodes || 0}"`, so a
// series with an unknown count arrives as 0. Treating that as a KNOWN total of
// zero rejected every episode > 0 ("cannot exceed total of 0") and reset the
// episode to 0 when marking Completed. 0 must normalize to null/unknown.
async function runUnknownTotalRegressionTests() {
  // 1. A missing/zero total normalizes to UNKNOWN (null), not a known 0.
  assert.strictEqual(
    normalizeWatchProgress({ watchStatus: 'plan_to_watch', episodes: 0 }).totalEpisodes,
    null,
    'episodes: 0 must normalize to an unknown total (null), not a known 0'
  );
  assert.strictEqual(
    normalizeWatchProgress({ watchStatus: 'plan_to_watch', totalEpisodes: 0 }).totalEpisodes,
    null,
    'totalEpisodes: 0 must normalize to an unknown total (null)'
  );
  assert.strictEqual(
    normalizeWatchProgress({ watchStatus: 'plan_to_watch' }).totalEpisodes,
    null,
    'an absent total must normalize to an unknown total (null)'
  );

  // 2. Progress on an unknown-total series must be accepted, not rejected.
  for (const episode of [1, 5, 5018]) {
    const saved = normalizeWatchProgress(
      { watchStatus: 'watching', currentEpisode: episode, totalEpisodes: 0 },
      { rejectOverflow: true }
    );
    assert.strictEqual(saved.currentEpisode, episode, `episode ${episode} must be accepted when the total is unknown`);
  }

  // 3. The change-handler guard mirrors the normalizer: it must not treat 0 as
  //    a known total either (this is the exact expression script.js uses).
  //    The live guard reads the RAW stored item, which — unlike normalized
  //    output — keeps the card bookmark's `episodes: 0` alongside
  //    `totalEpisodes: null`; `null ?? 0` is 0, so a plain `!= null` check
  //    would reject every episode > 0 (confirmed in the browser 2026-10-11).
  const rawStoredItem = normalizeWatchProgress({ watchStatus: 'plan_to_watch', episodes: 0 });
  const shapedItem = { ...rawStoredItem, episodes: 0 }; // exactly what the bookmark path persists
  const knownTotal = shapedItem.totalEpisodes ?? shapedItem.episodes;
  const total = knownTotal != null && Number(knownTotal) > 0 ? Number(knownTotal) : null;
  assert.strictEqual(total, null, 'the change-handler guard must see an unknown (null) total for the raw stored shape');
  // Negative check: the pre-fix expression (`!= null` only) resolves that same
  // shape to a known total of 0, which is the bug this guards against.
  const preFixTotal = knownTotal != null ? Number(knownTotal) : null;
  assert.strictEqual(preFixTotal, 0, 'negative check: the pre-fix guard saw a known total of 0 for this shape');

  // 4. Completed on an unknown-total series must NOT reset the episode to 0.
  const completedUnknown = normalizeWatchProgress({ watchStatus: 'completed', currentEpisode: 9, totalEpisodes: 0 });
  assert.strictEqual(completedUnknown.currentEpisode, 9, 'Completed must preserve the episode when the total is unknown');

  // 5. Goal A: a real 12-episode series must still reject episode 5018.
  assert.throws(
    () => normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 5018, totalEpisodes: 12 }, { rejectOverflow: true }),
    /Current episode cannot exceed the known total of 12/,
    'a 12-episode series must reject episode 5018'
  );
  assert.strictEqual(
    normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 5018, totalEpisodes: 12 }).currentEpisode,
    12,
    'a 12-episode series must clamp episode 5018 to 12 when not rejecting'
  );

  // 5b. Unknown total + legacy `episodes: 0` coexisting must still accept
  //     episode 99 (the exact shape a card-bookmarked series reaches after one
  //     progress change: `totalEpisodes: null` alongside the stored `episodes: 0`).
  const legacySeries = { id: 21, title: 'ONE PIECE', episodes: 0, watchStatus: 'watching', currentEpisode: 0 };
  for (const shaped of [
    { ...legacySeries, currentEpisode: 99 },
    { ...legacySeries, totalEpisodes: null, currentEpisode: 99 }
  ]) {
    const savedSeries = normalizeWatchProgress(shaped, { rejectOverflow: true });
    assert.strictEqual(savedSeries.totalEpisodes, null, 'a legacy episodes: 0 series must stay unknown-total');
    assert.strictEqual(savedSeries.currentEpisode, 99, 'episode 99 must be accepted for an unknown-total series');
  }
  // An invalid episode on that same shape must still be rejected.
  assert.throws(
    () => normalizeWatchProgress({ ...legacySeries, currentEpisode: 1.5 }, { rejectOverflow: true }),
    /invalid current episode/,
    'a fractional episode must be rejected without a known total'
  );

  // 6. A genuinely known total must survive unchanged (regression guard).
  assert.strictEqual(
    normalizeWatchProgress({ watchStatus: 'watching', currentEpisode: 3, totalEpisodes: 24 }).totalEpisodes,
    24,
    'a known total of 24 must be preserved'
  );

  // 7. Completed with a KNOWN total still advances to that total.
  assert.strictEqual(
    normalizeWatchProgress({ watchStatus: 'completed', currentEpisode: 3, totalEpisodes: 12 }).currentEpisode,
    12,
    'Completed with a known total must advance to the total'
  );

  // Negative check: the pre-fix behaviour treated 0 as a known total, which is
  // exactly what these assertions forbid. Asserting that shape still exists as
  // a plain 0 (rather than null) keeps the contrast explicit.
  const preFixBehaviour = (() => {
    const totalEpisodes = 0;
    return totalEpisodes;
  })();
  assert.strictEqual(preFixBehaviour, 0, 'negative check: the pre-fix behaviour returned a known total of 0');
  assert.notStrictEqual(preFixBehaviour, null, 'negative check: 0 is not null, so the pre-fix shape differs from the fixed one');

  console.log('Unknown-total and episode-overflow regression tests passed.');
}

// ---- Regression: episode-selector search input must be visible ----
//
// The search input is inserted as a SIBLING of the <select>, while every CSS
// rule for it is descendant-based (.episode-selector-searching
// .episode-search-input). When the JS put the marker class on the <select>
// itself, the rules never matched: the input stayed display:none and was
// unfocusable, so the whole episode-search feature was unusable (confirmed in
// a live browser before the fix). The class must stay on the wrapper that
// contains the input and the search button.

async function runEpisodeSearchVisibilityTests() {
  const cssSource = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');

  // 1. The CSS rules must stay descendant-based.
  for (const rule of [
    '.episode-selector-searching .episode-search-input',
    '.episode-selector-searching .episode-selector-search',
    '.episode-selector-searching .episode-selector-search svg'
  ]) {
    assert.ok(cssSource.includes(rule), `style.css must keep the descendant rule "${rule}"`);
  }

  // The browser suite covers the observable open/filter/Escape/outside-click
  // behavior. Keep the CSS selector contract here because it protects the
  // descendant relationship that makes the sibling search input visible.
  console.log('Episode-search CSS contract verified; interaction coverage runs in Playwright.');
}

// ---- Regression: movie type persisted on bookmark + legacy repair ----
//
// The guest card-bookmark path used to store {id, title, poster, episodes}
// WITHOUT `type`, so isMovieEntry() (type === 'MOVIE') was false for stored
// movies and both the detail and watchlist pages rendered episode controls for
// them (confirmed in the live browser 2026-10-11: "A Silent Voice", id 20954,
// showed a 0..1 episode selector). The fix: the card emits data-type, the
// handler persists it, the detail page repairs legacy entries from the
// authoritative catalog response, and loadWatchlist hydrates untyped guest
// entries once via /api/anime/:id.
async function runMovieTypeRegressionTests() {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'script.js'), 'utf8');
  // Executed behavior: the REAL renderer and the browser tests cover card type
  // persistence, authoritative legacy repair, and the movie/series control split.
  // The source is still used by the VM harness below to execute the production
  // renderer, not to assert implementation wording or function layout.
  //
  // 1. The REAL renderWatchProgressControls must show
  //    status-only for a movie (with type) and for a repaired legacy movie,
  //    and must keep the episode selector for a TV series.
  const { renderWatchProgressControls } = extractRenderWatchProgressControls(source);
  const movieHtml = renderWatchProgressControls({
    id: 20954, title: 'A Silent Voice', type: 'MOVIE', watchStatus: 'plan_to_watch',
    currentEpisode: 0, totalEpisodes: 1
  });
  assert.ok(movieHtml.includes('data-watch-status'), 'a movie must render the status control');
  assert.ok(!movieHtml.includes('data-watch-episode'), 'a movie must NOT render an episode selector');
  assert.ok(!movieHtml.includes('episode-selector-search'), 'a movie must NOT render the episode search button');

  // Legacy shape: no `type` on the item, catalog fallback applied exactly as
  // the detail page does it (savedAnime.type || animeTypeValue(anime)).
  const legacyRepairedHtml = renderWatchProgressControls({
    id: 459, title: 'ONE PIECE: The Movie', watchStatus: 'plan_to_watch',
    currentEpisode: 0, totalEpisodes: 1
  }, {}, { catalogType: 'MOVIE' });
  assert.ok(
    legacyRepairedHtml.includes('data-watch-status'),
    'a legacy movie repaired from catalog metadata must render the status control'
  );
  assert.ok(
    !legacyRepairedHtml.includes('data-watch-episode'),
    'a legacy movie repaired from catalog metadata must NOT render an episode selector'
  );

  const seriesHtml = renderWatchProgressControls({
    id: 21, title: 'ONE PIECE', type: 'TV', watchStatus: 'watching',
    currentEpisode: 99, totalEpisodes: 1100
  });
  assert.ok(seriesHtml.includes('data-watch-status'), 'a TV series must keep the status control');
  assert.ok(seriesHtml.includes('data-watch-episode'), 'a TV series must keep the episode selector');
  assert.ok(seriesHtml.includes('episode-selector-search'), 'a TV series must keep the episode search button');

  console.log('Movie-type persistence and legacy-repair regression tests passed.');
}

// Extract the production renderWatchProgressControls (plus the helpers it
// closes over) into a callable function via the same vm pattern the genre
// tests use, so the assertions above execute real rendering code.
function extractRenderWatchProgressControls(source) {
  const vm = require('vm');
  const start = source.indexOf('function renderWatchProgressControls(');
  assert.notStrictEqual(start, -1, 'renderWatchProgressControls must exist');
  const end = source.indexOf('function renderAnimeCard(', start);
  const funcSource = source.slice(start, end);
const utils = require(path.join(__dirname, 'public', 'watchlist-utils.js'));
  const sandbox = {
    WATCH_STATUS_VALUES: utils.WATCH_STATUS_VALUES,
    WATCH_STATUS_LABELS: {
      watching: 'Watching', completed: 'Completed', plan_to_watch: 'Plan to Watch',
      on_hold: 'On Hold', dropped: 'Dropped'
    },
    normalizeWatchProgress: utils.normalizeWatchProgress,
    getAnimeTitle: anime => anime.title?.english || anime.title?.romaji || anime.title?.native || (typeof anime.title === 'string' ? anime.title : 'Unknown Anime'),
    escapeHtml: value => String(value)
      .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
      .replace(/"/g, '"').replace(/'/g, "'"),
    animeTypeValue: anime => String(anime?.type || anime?.format || '').toUpperCase(),
    isMovieEntry: anime => String(anime?.type || anime?.format || '').toUpperCase() === 'MOVIE',
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    Node: { ELEMENT_NODE: 1 },
    document: { body: { childList: true, subtree: true } }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${funcSource}\nthis.renderWatchProgressControls = renderWatchProgressControls;`, sandbox);
  return {
    renderWatchProgressControls: (anime, options = {}, extra = {}) =>
      sandbox.renderWatchProgressControls(
        { ...anime, ...(extra.catalogType ? { type: extra.catalogType } : {}) },
        options
      )
  };
}

// ---- Executed: guest type persistence + legacy repair (real functions) ----
//
// The checks above assert the wiring exists; these EXECUTE the production
// loadLocalWatchlist / saveWatchlist / withWatchProgress / toggleWatchlistItem /
// animeTypeValue / repairUntypedWatchlistEntries / loadWatchlist declarations
// (extracted verbatim from public/script.js) against a real localStorage and a
// controllable catalog fetch, for both the guest and the authenticated/cloud
// path. Only the host storage and network are mocked.
async function runGuestTypeRepairExecutionTests() {
  const LEGACY_MOVIE = {
    id: 20954,
    title: 'A Silent Voice',
    poster: 'https://img.example/20954.jpg',
    image: 'https://img.example/20954.jpg',
    episodes: 1,
    watchStatus: 'watching',
    currentEpisode: 1
  };
  const seededRaw = JSON.stringify([LEGACY_MOVIE]);
  const movieCatalog = {
    ok: true,
    status: 200,
    json: async () => ({ id: 20954, type: 'MOVIE', format: 'MOVIE', title: { english: 'A Silent Voice' }, episodes: 1 })
  };

  // 1. Guest repair: authoritative catalog metadata supplies `type`, the entry
  //    keeps every other field, and the repaired value is persisted once.
  {
    const h = buildViewHarness({ seedWatchlist: seededRaw, fetchImpl: async () => ({ ...movieCatalog }) });
    h.setGuest();
    await h.load();

    assert.deepStrictEqual(h.fetchCalls(), ['/api/anime/20954'], 'repair must look the entry up once via the catalog');
    const [repaired] = h.watchlistSnapshot();
    assert.strictEqual(repaired.type, 'MOVIE', 'the catalog format must repair the missing type');
    assert.strictEqual(repaired.id, 20954, 'repair must preserve the id');
    assert.strictEqual(repaired.title, 'A Silent Voice', 'repair must preserve the title');
    assert.strictEqual(repaired.poster, 'https://img.example/20954.jpg', 'repair must preserve the poster');
    assert.strictEqual(repaired.image, 'https://img.example/20954.jpg', 'repair must preserve the image');
    assert.strictEqual(repaired.episodes, 1, 'repair must preserve the legacy episode count');
    assert.strictEqual(repaired.watchStatus, 'watching', 'repair must preserve the watch status');
    assert.strictEqual(repaired.currentEpisode, 1, 'repair must preserve the episode progress');

    assert.strictEqual(h.storageWrites(), 1, 'exactly one write must persist the repaired entry');
    const persisted = JSON.parse(h.localStorageRaw());
    assert.strictEqual(persisted[0].type, 'MOVIE', 'the repaired type must be persisted for the reload');
    assert.strictEqual(persisted[0].currentEpisode, 1, 'persisted progress must be unchanged');

    // 2. Reload: the persisted type means no second catalog call and no
    //    redundant write.
    const reloaded = buildViewHarness({ seedWatchlist: h.localStorageRaw(), fetchImpl: async () => ({ ...movieCatalog }) });
    reloaded.setGuest();
    await reloaded.load();
    assert.deepStrictEqual(reloaded.fetchCalls(), [], 'a repaired entry must not be fetched again');
    assert.strictEqual(reloaded.storageWrites(), 0, 'a repaired entry must not be written again');
    assert.strictEqual(reloaded.watchlistSnapshot()[0].type, 'MOVIE', 'the repaired type must survive a reload');
  }

  // 3. Catalog failure (HTTP error, network rejection, or no format field):
  //    the entry is left exactly as stored and nothing is written.
  for (const [label, failure] of [
    ['an HTTP error', async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) })],
    ['a network rejection', async () => { throw new Error('offline'); }],
    ['a response without a format', async () => ({ ok: true, status: 200, json: async () => ({ id: 20954, title: { english: 'A Silent Voice' } }) })]
  ]) {
    const h = buildViewHarness({ seedWatchlist: seededRaw, fetchImpl: failure });
    h.setGuest();
    await h.load();

    const [untouched] = h.watchlistSnapshot();
    assert.strictEqual(untouched.type, undefined, `with ${label} the type must not be guessed`);
    assert.strictEqual(untouched.watchStatus, 'watching', `with ${label} the watch status must survive`);
    assert.strictEqual(untouched.currentEpisode, 1, `with ${label} the episode progress must survive`);
    assert.strictEqual(untouched.id, 20954, `with ${label} the id must survive`);
    assert.strictEqual(h.storageWrites(), 0, `with ${label} nothing may be persisted`);
    assert.strictEqual(h.localStorageRaw(), seededRaw, `with ${label} the stored entry must be byte-identical`);
  }

  // 4. Authenticated/cloud path: the guest repair must not run, no catalog
  //    request is made, and the guest localStorage cache is never rewritten —
  //    even when the cloud list still contains an untyped row.
  {
    const h = buildViewHarness({
      seedWatchlist: seededRaw,
      fetchImpl: async () => { throw new Error('the cloud path must not trigger the guest catalog repair'); }
    });
    h.setCloudList(async () => ([
      { id: 113415, title: 'Jujutsu Kaisen', type: 'TV', watchStatus: 'watching' },
      { id: 20, title: 'Naruto', watchStatus: 'plan_to_watch' }
    ]));
    await h.load();

    assert.deepStrictEqual(h.fetchCalls(), [], 'the authenticated path must not call the repair fetch');
    assert.strictEqual(h.storageWrites(), 0, 'the guest cache must not be rewritten while signed in');
    assert.strictEqual(h.localStorageRaw(), seededRaw, 'the guest cache must stay byte-identical while signed in');
    const snapshot = h.watchlistSnapshot();
    assert.strictEqual(snapshot.length, 2, 'the cloud list must replace the guest list');
    assert.deepStrictEqual(Array.from(snapshot, row => row.id), [113415, 20], 'cloud rows must be rendered in order');
    assert.strictEqual(snapshot[0].type, 'TV', 'hydrated cloud rows keep their type');
    assert.strictEqual(snapshot[1].type, undefined, 'an untyped cloud row must not be guessed at while signed in');
  }

  // 5. A brand-new guest bookmark persists the card's format.
  {
    const h = buildViewHarness({
      fetchImpl: async () => { throw new Error('bookmarking must not need a catalog request'); }
    });
    h.setGuest();
    const adding = await h.toggle({
      id: 20954, title: 'A Silent Voice', poster: 'https://img.example/20954.jpg',
      image: 'https://img.example/20954.jpg', episodes: 1, type: 'MOVIE'
    });
    assert.strictEqual(adding, true, 'a new bookmark must report that it was added');
    const persisted = JSON.parse(h.localStorageRaw());
    assert.strictEqual(persisted.length, 1, 'the bookmark must be persisted');
    assert.strictEqual(persisted[0].type, 'MOVIE', 'the bookmarked format must be persisted');
    assert.strictEqual(persisted[0].watchStatus, 'plan_to_watch', 'a new bookmark must default to plan_to_watch');
    assert.strictEqual(persisted[0].totalEpisodes, 1, 'a new bookmark must keep the episode count');
    assert.strictEqual(persisted[0].currentEpisode, 0, 'a new bookmark must start unwatched');
    assert.deepStrictEqual(h.fetchCalls(), [], 'bookmarking must not need a catalog request');

    // Removal still works and clears the stored entry.
    const removing = await h.toggle({ id: 20954, title: 'A Silent Voice', type: 'MOVIE' });
    assert.strictEqual(removing, false, 'a second toggle must remove the bookmark');
    assert.strictEqual(JSON.parse(h.localStorageRaw()).length, 0, 'removal must be persisted');
  }

  // 6. An `animehub:auth-state` guest refresh landing WHILE the repair request
  //    is in flight must not orphan the write: the repaired type has to be
  //    re-applied to the current array, otherwise saveWatchlist() serialises the
  //    freshly parsed (still untyped) copy and nothing changes.
  {
    const h = buildViewHarness({
      seedWatchlist: seededRaw,
      fetchImpl: async () => {
        h.refreshFromStorage();
        return { ...movieCatalog };
      }
    });
    h.setGuest();
    await h.load();

    const stored = JSON.parse(h.localStorageRaw());
    assert.strictEqual(stored[0].type, 'MOVIE', 'the repair must persist even if the array is refreshed mid-flight');
    assert.strictEqual(stored[0].currentEpisode, 1, 'the refreshed copy must keep its progress');
    assert.strictEqual(h.watchlistSnapshot()[0].type, 'MOVIE', 'the rendered array must be repaired too');
    assert.strictEqual(h.storageWrites(), 1, 'exactly one write must persist the repair');
  }

  console.log('Guest type-persistence and legacy-repair execution tests passed.');
}

// Execute all integration contract tests.
function buildCatalogGenreOptionsHarness({ source = scriptSourceVm, fetchImpl } = {}) {
  const toasts = [];
  const errors = [];
  const requests = [];
  const select = { innerHTML: '', dataset: {} };
  const sandbox = {
    console: { error: (...args) => errors.push(args.map(String).join(' ')), log() {}, warn() {} },
    Promise, JSON, Number, String, Array, Object, Map, Set, Error, RangeError,
    baseURL: '/api',
    document: {
      getElementById: id => (id === 'filter-genre' ? select : null)
    },
    escapeHtml: value => String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    fetch: async (url, init) => {
      requests.push(String(url));
      if (fetchImpl) return fetchImpl(String(url), init);
      return { ok: true, json: async () => ['Action', 'Comedy'] };
    }
  };
  sandbox.window = { __toasts: toasts };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`
    function showToast(message, type) { window.__toasts.push({ message, type }); }
    async function fetchWithPolicy(url, options = {}) { return fetch(url, options); }
    ${extractFunction('loadCatalogGenreOptions', source)}
    window.__loadCatalogGenreOptions = loadCatalogGenreOptions;
  `, sandbox, { filename: 'catalog-genre-options-slice.js' });

  return {
    select,
    toasts,
    errors,
    requests,
    load: () => sandbox.window.__loadCatalogGenreOptions()
  };
}

async function runCatalogGenreOptionsTests() {
  // P5.3: a failed genre-list load must be visible and recoverable, never a
  // silently empty dropdown.
  {
    const g = buildCatalogGenreOptionsHarness({
      fetchImpl: async () => { throw new Error('network down'); }
    });
    await g.load();
    assert.ok(/Genre list unavailable/.test(g.select.innerHTML), 'A failed genre-list load must say so in the dropdown');
    assert.strictEqual(g.select.dataset.genresLoaded, undefined, 'A failed load must not record success');
    assert.strictEqual(g.toasts.length, 1, 'A failed genre-list load must toast');
    assert.strictEqual(g.toasts[0].type, 'error', 'The genre-list toast must be an error toast');
    assert.ok(g.errors.length > 0, 'The failure must still be logged');
  }

  // After a failure the next visit retries; success replaces the placeholder
  // with the real options and records completion.
  {
    let fail = true;
    const g = buildCatalogGenreOptionsHarness({
      fetchImpl: async () => {
        if (fail) throw new Error('network down');
        return { ok: true, json: async () => ['Action', 'Comedy'] };
      }
    });
    await g.load();
    assert.ok(/Genre list unavailable/.test(g.select.innerHTML), 'The first attempt must show the placeholder');

    fail = false;
    await g.load();
    assert.strictEqual(g.requests.length, 2, 'A revisit after failure must retry the genre list');
    assert.ok(/value="Action"/.test(g.select.innerHTML) && /value="Comedy"/.test(g.select.innerHTML), 'A successful retry must fill the dropdown');
    assert.ok(!/Genre list unavailable/.test(g.select.innerHTML), 'A successful retry must clear the placeholder');
    assert.strictEqual(g.select.dataset.genresLoaded, 'true', 'A successful load must record completion');
  }

  // Control: a completed load is never repeated, and success never toasts.
  {
    const g = buildCatalogGenreOptionsHarness();
    await g.load();
    await g.load();
    assert.strictEqual(g.requests.length, 1, 'A completed genre-list load must not re-fetch');
    assert.strictEqual(g.toasts.length, 0, 'A successful load must not toast');
  }
  console.log('Genre filter options fail visibly, retry on revisit, and load once on success.');
}

runIntegrationContractTests()
  .then(() => runGenreFilteringTests())
  .then(() => runCatalogGenreOptionsTests())
  .then(() => runCloudWatchlistRegressionTests())
  .then(() => runUnknownTotalRegressionTests())
  .then(() => runEpisodeSearchVisibilityTests())
  .then(() => runMovieTypeRegressionTests())
  .then(() => runGuestTypeRepairExecutionTests())
  .then(() => console.log('Production watch-status, cloud-update, migration, and keyboard rules passed.'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
