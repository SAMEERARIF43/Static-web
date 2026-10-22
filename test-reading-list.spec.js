const { test, expect } = require('@playwright/test');

const READING_LIST_KEY = 'anime_hub_reading_list';
const WATCHLIST_KEY = 'anime_hub_watchlist';
const FIXTURE_TIME = '2026-10-19T00:00:00.000Z';
const CONTENT_TYPES = ['manga', 'manhwa', 'manhua'];
const READING_STATUSES = ['reading', 'completed', 'plan_to_read', 'on_hold', 'dropped'];
const WATCHLIST_SENTINEL = [{
  id: 77,
  title: 'Anime sentinel',
  poster: 'https://fixtures.example/anime-77.jpg',
  type: 'TV',
  episodes: 24,
  totalEpisodes: 24,
  watchStatus: 'watching',
  currentEpisode: 3,
  updatedAt: FIXTURE_TIME
}];

const comic = {
  id: 101,
  title: { romaji: 'Fixture Manga' },
  image: 'https://placehold.co/300x450',
  type: 'Manga',
  contentType: 'manga',
  category: 'manga',
  status: 'RELEASING',
  chapters: 80,
  genres: ['Fantasy']
};

// Deliberately reuse the same numeric provider ID in every category. A bare
// numeric key would accidentally merge these three independently saved titles.
const comics = {
  manga: comic,
  manhwa: { ...comic, title: { romaji: 'Fixture Manhwa' }, image: 'https://fixtures.example/manhwa-101.jpg', type: 'Manhwa', contentType: 'manhwa', category: 'manhwa', chapters: 16 },
  manhua: { ...comic, title: { romaji: 'Fixture Manhua' }, image: 'https://fixtures.example/manhua-101.jpg', type: 'Manhua', contentType: 'manhua', category: 'manhua', chapters: null }
};

function savedEntry(item = comic, overrides = {}) {
  return {
    provider: 'anilist',
    providerId: item.id,
    contentType: item.category,
    title: item.title.romaji,
    poster: item.image,
    readingStatus: 'reading',
    currentChapter: 12,
    totalChapters: item.chapters,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides
  };
}

const readingRaw = entries => JSON.stringify({ schemaVersion: 1, entries });
const savedReadingList = () => readingRaw([savedEntry()]);
const entryKey = entry => `anilist:${entry.contentType}:${entry.providerId}`;

function comicForEntry(entry) {
  return {
    ...comic,
    id: entry.providerId,
    title: { romaji: entry.title },
    image: entry.poster,
    type: entry.contentType,
    contentType: entry.contentType,
    category: entry.contentType,
    chapters: entry.totalChapters
  };
}

async function setup(page, { readingRaw = null, catalog = Object.values(comics) } = {}) {
  const origin = new URL(test.info().project.use.baseURL).origin;
  const anime = {
    ...WATCHLIST_SENTINEL[0],
    title: { romaji: WATCHLIST_SENTINEL[0].title },
    image: WATCHLIST_SENTINEL[0].poster,
    format: 'TV', status: 'RELEASING', genres: ['Fantasy'],
    staff: { edges: [] }, characters: { edges: [] }, relations: { edges: [] },
    recommendations: { edges: [] }, studios: { nodes: [] }, trailer: null
  };
  const fixtures = new Map([
    ['/api/health', { ok: true }],
    ['/api/config', { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' }],
    ['/api/site-config', {}],
    ['/api/trending', [anime]],
    ['/api/popular', [anime]],
    ['/api/movies', []],
    ['/api/series', [anime]],
    ['/api/genres', ['Fantasy']],
    ['/api/browse', [anime]],
    [`/api/anime/${anime.id}`, anime]
  ]);
  const responseStatuses = new Map();
  const requests = [];
  for (const category of CONTENT_TYPES) {
    const items = catalog.filter(item => item.category === category);
    fixtures.set(`/api/${category}`, items);
    for (const item of items) fixtures.set(`/api/${category}/${item.id}`, item);
  }

  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) {
      // Never let an unstubbed API request reach an upstream service.
      requests.push({ path: url.pathname, method: route.request().method() });
      const found = fixtures.has(url.pathname);
      return route.fulfill({
        status: responseStatuses.get(url.pathname) || (found ? 200 : 404),
        contentType: 'application/json',
        body: JSON.stringify(found ? fixtures.get(url.pathname) : { message: 'No fixture for this API request.' })
      });
    }
    return route.continue();
  });

  // Seed once on a same-origin response with no app scripts. An init script
  // would run again on reload and invalidate the persistence assertions.
  await page.goto('/api/health', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ readingKey, watchlistKey, raw, sentinel }) => {
    if (raw === null) localStorage.removeItem(readingKey);
    else localStorage.setItem(readingKey, raw);
    localStorage.setItem(watchlistKey, JSON.stringify(sentinel));
  }, { readingKey: READING_LIST_KEY, watchlistKey: WATCHLIST_KEY, raw: readingRaw, sentinel: WATCHLIST_SENTINEL });
  return { fixtures, responseStatuses, requests };
}

const readReadingList = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), READING_LIST_KEY);
const readRawReadingList = page => page.evaluate(key => localStorage.getItem(key), READING_LIST_KEY);
const detailControls = page => page.locator('#comic-reading-detail-controls [data-reading-controls]');
const listControls = page => page.locator('#reading-list-grid [data-reading-controls]');
const controlsFor = (page, entry) => page.locator(`#reading-list-grid [data-reading-controls="${entryKey(entry)}"]`);
const detailToggle = (page, item = comic) => page.locator(`#comic-detail-content [data-reading-toggle="${item.id}"][data-reading-category="${item.category}"]`);
const catalogToggle = (page, item) => page.locator(`#${item.category}-grid [data-reading-toggle="${item.id}"][data-reading-category="${item.category}"]`);
const removeEntry = (page, entry) => page.locator(`#reading-list-grid [data-reading-remove="${entryKey(entry)}"]`);

async function cardKeys(page, grid = 'reading-list-grid') {
  return page.locator(`#${grid} .anime-card`).evaluateAll(cards => cards.map(card => `anilist:${card.dataset.category}:${card.dataset.id}`));
}

async function expectCardKeys(page, keys, grid) {
  await expect.poll(() => cardKeys(page, grid)).toEqual(keys);
}

async function expectSummary(page, counts) {
  const ids = ['reading', 'completed', 'planned', 'on-hold', 'dropped'];
  for (const [index, id] of ids.entries()) {
    await expect(page.locator(`#reading-summary-${id}`)).toHaveText(String(counts[index]));
  }
}

// Inject failures only at the browser storage boundary, never at the reading
// store itself. The one-time seed above is not rerun by these fault scripts.
function failReadingStorage({ key, mode }) {
  const storage = window.localStorage;
  if (mode === 'getter') {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Fixture storage access denied.', 'SecurityError'); }
    });
    window.__restoreReadingListStorage = () => Object.defineProperty(window, 'localStorage', descriptor);
    return;
  }
  const method = { read: 'getItem', write: 'setItem', remove: 'removeItem' }[mode];
  const original = Storage.prototype[method];
  Storage.prototype[method] = function (storageKey, ...args) {
    if (this === storage && storageKey === key) {
      throw new DOMException(`Fixture reading-list ${mode} failure.`, mode === 'write' ? 'QuotaExceededError' : 'SecurityError');
    }
    return original.call(this, storageKey, ...args);
  };
  window.__restoreReadingListStorage = () => { Storage.prototype[method] = original; };
}

function recordUnexpectedDialogs(page) {
  const dialogs = [];
  page.on('dialog', async dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.dismiss();
  });
  return dialogs;
}

async function expectWatchlistUnchanged(page) {
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), WATCHLIST_KEY)).toEqual(WATCHLIST_SENTINEL);
}

async function openNav(page, name) {
  const link = page.locator(`#nav-links [data-nav="${name}"]`);
  const menu = page.locator('#mobile-menu');
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') {
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
  }
  await link.click();
  await expect(page.locator(`#page-${name}`)).toHaveClass(/active/);
}

const openReadingList = page => openNav(page, 'reading-list');

async function openComic(page, item = comic) {
  await page.goto(`/?page=${item.category}`, { waitUntil: 'domcontentloaded' });
  await page.locator(`#${item.category}-grid .anime-card[data-id="${item.id}"] .card-title`).click();
  await expect(page.locator('#page-comic-detail')).toHaveClass(/active/);
  await expect(page.locator('#comic-detail-content .detail-title')).toHaveText(item.title.romaji);
}

async function expectProgress(controls, status, chapter, total = comic.chapters) {
  await expect(controls).toHaveCount(1);
  await expect(controls.locator('[data-reading-status]')).toHaveValue(status);
  await expect(controls.locator('[data-reading-chapter]')).toHaveValue(String(chapter));
  await expect(controls.locator('.reading-progress-summary')).toHaveText(`Chapter ${chapter}${total === null ? '' : ` of ${total}`}`);
}

async function changeChapter(controls, value) {
  const chapter = controls.locator('[data-reading-chapter]');
  await chapter.fill(value);
  await chapter.dispatchEvent('change');
}

async function clearWithConfirmation(page, confirmed) {
  const handledDialog = page.waitForEvent('dialog').then(async dialog => {
    const details = { type: dialog.type(), message: dialog.message() };
    if (confirmed) await dialog.accept();
    else await dialog.dismiss();
    return details;
  });
  const [dialog] = await Promise.all([handledDialog, page.locator('#reading-list-clear').click()]);
  expect(dialog.type).toBe('confirm');
  expect(dialog.message).toMatch(/clear.*reading-list/i);
}

test.describe('Comic reading-list integration', () => {
  test('adding and removing immediately updates detail controls and the reading-list surface', async ({ page }) => {
    await setup(page);
    await openComic(page);
    const toggle = detailToggle(page);
    await expect(toggle).toHaveAttribute('aria-label', 'Add to reading list');
    await expect(detailControls(page)).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', 'Remove from reading list');
    await expectProgress(detailControls(page), 'plan_to_read', 0);
    expect((await readReadingList(page)).entries).toHaveLength(1);

    await openReadingList(page);
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(1);
    await expectProgress(listControls(page), 'plan_to_read', 0);
    await listControls(page).locator('[data-reading-status]').selectOption('reading');
    await expectProgress(listControls(page), 'reading', 0);
    expect((await readReadingList(page)).entries[0]).toMatchObject({ readingStatus: 'reading', currentChapter: 0 });
    await page.locator('#reading-list-grid .card-title').click();
    await expectProgress(detailControls(page), 'reading', 0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', 'Add to reading list');
    await expect(detailControls(page)).toHaveCount(0);
    expect((await readReadingList(page)).entries).toEqual([]);

    await openReadingList(page);
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(0);
    await expect(page.locator('#reading-list-empty')).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#reading-list-empty')).toBeVisible();
    expect((await readReadingList(page)).entries).toEqual([]);
    await expectWatchlistUnchanged(page);
  });

  test('status changes at chapter zero and detail progress survive reload on both surfaces', async ({ page }) => {
    await setup(page);
    await openComic(page);
    await detailToggle(page).click();
    const controls = detailControls(page);
    await expectProgress(controls, 'plan_to_read', 0);

    // Select a status before touching the chapter field: zero must not be
    // rendered as an empty string and rejected by the delegated change handler.
    await controls.locator('[data-reading-status]').selectOption('reading');
    await expectProgress(controls, 'reading', 0);
    expect((await readReadingList(page)).entries[0]).toMatchObject({ readingStatus: 'reading', currentChapter: 0 });

    await changeChapter(controls, '12');
    await expectProgress(controls, 'reading', 12);
    const stored = await readReadingList(page);
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]).toMatchObject({
      provider: 'anilist', providerId: 101, contentType: 'manga',
      readingStatus: 'reading', currentChapter: 12, totalChapters: 80
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#page-comic-detail')).toHaveClass(/active/);
    await expectProgress(detailControls(page), 'reading', 12);
    await openReadingList(page);
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(1);
    await expectProgress(listControls(page), 'reading', 12);

    // Editing the card must keep the reading-list page active rather than
    // activating its surrounding detail link.
    await listControls(page).locator('[data-reading-status]').selectOption('on_hold');
    await expect(page.locator('#page-reading-list')).toHaveClass(/active/);
    await changeChapter(listControls(page), '13');
    await expectProgress(listControls(page), 'on_hold', 13);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#page-reading-list')).toHaveClass(/active/);
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(1);
    await expectProgress(listControls(page), 'on_hold', 13);
    await page.locator('#reading-list-grid .card-title').click();
    await expectProgress(detailControls(page), 'on_hold', 13);
    expect((await readReadingList(page)).entries[0]).toMatchObject({ readingStatus: 'on_hold', currentChapter: 13 });
    await expectWatchlistUnchanged(page);
  });

  test('completion immediately refreshes the detail chapter input and progress summary', async ({ page }) => {
    await setup(page, { readingRaw: savedReadingList() });
    await page.goto(`/?page=manga&comicId=${comic.id}`, { waitUntil: 'domcontentloaded' });
    const controls = detailControls(page);
    await expectProgress(controls, 'reading', 12);
    await controls.locator('[data-reading-status]').selectOption('completed');
    await expectProgress(controls, 'completed', 80);
    expect((await readReadingList(page)).entries[0]).toMatchObject({ readingStatus: 'completed', currentChapter: 80 });
    await openReadingList(page);
    await expectProgress(listControls(page), 'completed', 80);
  });

  test('cancelled clear preserves malformed data and confirmed clear stays cleared after reload', async ({ page }) => {
    const malformed = '{broken';
    await setup(page, { readingRaw: malformed });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#reading-list-error')).toBeVisible();
    await expect(page.locator('#reading-list-error-message')).toContainText('malformed');
    await expect(page.locator('#reading-list-empty')).toBeHidden();
    await clearWithConfirmation(page, false);
    await expect(page.locator('#reading-list-error')).toBeVisible();
    expect(await readRawReadingList(page)).toBe(malformed);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#reading-list-error')).toBeVisible();
    expect(await readRawReadingList(page)).toBe(malformed);

    await clearWithConfirmation(page, true);
    await expect(page.locator('#reading-list-error')).toBeHidden();
    await expect(page.locator('#reading-list-empty')).toBeVisible();
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(0);
    expect(await readRawReadingList(page)).toBeNull();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#reading-list-empty')).toBeVisible();
    await expect(page.locator('#reading-list-error')).toBeHidden();
    expect(await readRawReadingList(page)).toBeNull();
    await expectWatchlistUnchanged(page);
  });

  for (const surface of ['detail', 'reading list']) {
    test(`invalid chapter progress on ${surface} shows an error and restores saved controls`, async ({ page }) => {
      const original = savedReadingList();
      await setup(page, { readingRaw: original });
      const url = surface === 'detail' ? `/?page=manga&comicId=${comic.id}` : '/?page=reading-list';
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const controls = surface === 'detail' ? detailControls(page) : listControls(page);
      await expectProgress(controls, 'reading', 12);

      for (const invalidChapter of ['-1', '1.5', '']) {
        await changeChapter(controls, invalidChapter);
        await expect(page.locator('#toast')).toHaveClass(/error/);
        await expect(page.locator('#toast')).toContainText(/currentChapter.*non-negative.*integer/);
        await expectProgress(controls, 'reading', 12);
        expect(await readRawReadingList(page)).toBe(original);
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectProgress(controls, 'reading', 12);
      expect(await readRawReadingList(page)).toBe(original);
      await expectWatchlistUnchanged(page);
    });
  }

  test('storage write failures preserve the saved entry, toggle, and progress on both surfaces', async ({ page }) => {
    const original = savedReadingList();
    await setup(page, { readingRaw: original });
    await page.goto(`/?page=manga&comicId=${comic.id}`, { waitUntil: 'domcontentloaded' });
    await expectProgress(detailControls(page), 'reading', 12);

    // Fail only reading-list writes after the real store has loaded. Keep all
    // storage reads and unrelated keys working, just as a quota failure would.
    await page.evaluate(key => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (storageKey, value) {
        if (this === window.localStorage && storageKey === key) {
          throw new DOMException('Fixture storage quota exceeded.', 'QuotaExceededError');
        }
        return setItem.call(this, storageKey, value);
      };
    }, READING_LIST_KEY);

    const toggle = detailToggle(page);
    await toggle.click();
    await expect(page.locator('#toast')).toHaveClass(/error/);
    await expect(page.locator('#toast')).toContainText(/Could not save the reading list.*previous state was kept/);
    await expect(toggle).toHaveAttribute('aria-label', 'Remove from reading list');
    await expectProgress(detailControls(page), 'reading', 12);
    expect(await readRawReadingList(page)).toBe(original);

    await detailControls(page).locator('[data-reading-status]').selectOption('completed');
    await expect(page.locator('#toast')).toHaveClass(/error/);
    await expectProgress(detailControls(page), 'reading', 12);
    expect(await readRawReadingList(page)).toBe(original);

    await openReadingList(page);
    await expectProgress(listControls(page), 'reading', 12);
    await changeChapter(listControls(page), '20');
    await expect(page.locator('#toast')).toHaveClass(/error/);
    await expect(page.locator('#toast')).toContainText(/Could not save the reading list.*previous state was kept/);
    await expectProgress(listControls(page), 'reading', 12);
    expect(await readRawReadingList(page)).toBe(original);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectProgress(listControls(page), 'reading', 12);
    expect(await readRawReadingList(page)).toBe(original);
    await expectWatchlistUnchanged(page);
  });

  test('catalog and detail saves keep all three categories, metadata, and composite identities without duplicates', async ({ page }) => {
    await setup(page);
    const dialogs = recordUnexpectedDialogs(page);
    await page.goto('/?page=manga', { waitUntil: 'domcontentloaded' });

    for (const [index, category] of CONTENT_TYPES.entries()) {
      const item = comics[category];
      if (index) await openNav(page, category);
      const cardButton = catalogToggle(page, item);
      await expect(cardButton).toHaveAttribute('aria-label', 'Add to reading list');
      await expect(cardButton).toHaveAttribute('data-reading-title', item.title.romaji);
      await expect(cardButton).toHaveAttribute('data-reading-poster', item.image);
      await expect(cardButton).toHaveAttribute('data-reading-chapters', item.chapters === null ? '' : String(item.chapters));
      await cardButton.click();
      await expect(page.locator(`#page-${category}`)).toHaveClass(/active/);
      await expect(cardButton).toHaveAttribute('aria-label', 'Remove from reading list');

      await page.locator(`#${category}-grid .card-title`).click();
      await expectProgress(detailControls(page), 'plan_to_read', 0, item.chapters);
      const toggle = detailToggle(page, item);
      await expect(toggle).toHaveAttribute('aria-label', 'Remove from reading list');

      // Removing and re-adding from detail exercises its independent metadata
      // source while the hidden catalog card still contains a matching toggle.
      await toggle.click();
      await expect(cardButton).toHaveAttribute('aria-label', 'Add to reading list');
      await toggle.click();
      await expectProgress(detailControls(page), 'plan_to_read', 0, item.chapters);
      await expect(cardButton).toHaveAttribute('aria-label', 'Remove from reading list');
      const stored = await readReadingList(page);
      expect(stored.entries).toHaveLength(index + 1);
      const entry = stored.entries.find(entry => entry.contentType === category);
      expect(entry).toMatchObject({
        provider: 'anilist', providerId: item.id, contentType: category,
        title: item.title.romaji, poster: item.image, readingStatus: 'plan_to_read',
        currentChapter: 0, totalChapters: item.chapters
      });
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(entry.updatedAt))).toBe(false);
    }

    await openReadingList(page);
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(3);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(3);
    expect(new Set((await readReadingList(page)).entries.map(entryKey)).size).toBe(3);

    const manhwa = savedEntry(comics.manhwa);
    await removeEntry(page, manhwa).click();
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(2);
    expect((await readReadingList(page)).entries.map(entry => entry.contentType).sort()).toEqual(['manga', 'manhua']);
    expect(dialogs).toEqual([]);
    await expectWatchlistUnchanged(page);
  });

  test('all five statuses at chapter zero with an unknown total sync across navigation and reload', async ({ page }) => {
    const item = comics.manhua;
    await setup(page, { readingRaw: readingRaw([savedEntry(item, { currentChapter: 0, readingStatus: 'plan_to_read' })]) });
    const dialogs = recordUnexpectedDialogs(page);
    await page.goto(`/?page=manhua&comicId=${item.id}`, { waitUntil: 'domcontentloaded' });

    for (const status of ['reading', 'on_hold', 'dropped', 'plan_to_read', 'completed']) {
      await detailControls(page).locator('[data-reading-status]').selectOption(status);
      await expectProgress(detailControls(page), status, 0, null);
      expect((await readReadingList(page)).entries[0]).toMatchObject({ readingStatus: status, currentChapter: 0, totalChapters: null });
      await openReadingList(page);
      await expectProgress(listControls(page), status, 0, null);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectProgress(listControls(page), status, 0, null);
      await page.locator('#reading-list-grid .card-title').click();
      await expectProgress(detailControls(page), status, 0, null);
    }

    await changeChapter(detailControls(page), '7');
    await expectProgress(detailControls(page), 'completed', 7, null);
    await openReadingList(page);
    await expectProgress(listControls(page), 'completed', 7, null);
    expect(dialogs).toEqual([]);
    await expectWatchlistUnchanged(page);
  });

  test('status and type filters combine, retain memory through edits and navigation, and reset without changing summary totals', async ({ page }) => {
    const entries = [
      savedEntry(comics.manga, { currentChapter: 0 }),
      savedEntry(comics.manhwa, { readingStatus: 'completed', currentChapter: 16 }),
      savedEntry(comics.manhua, { readingStatus: 'plan_to_read', currentChapter: 0 }),
      savedEntry(comics.manga, { providerId: 102, title: 'Held manga', readingStatus: 'on_hold', currentChapter: 5 }),
      savedEntry(comics.manhwa, { providerId: 102, title: 'Dropped manhwa', readingStatus: 'dropped', currentChapter: 2 }),
      savedEntry(comics.manhua, { providerId: 102, title: 'Reading manhua', currentChapter: 10, totalChapters: 20 }),
      savedEntry(comics.manga, { providerId: 103, title: 'Unstarted reading manga', currentChapter: 0 })
    ];
    await setup(page, { readingRaw: readingRaw(entries), catalog: entries.map(comicForEntry) });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    const statusFilter = page.locator('#reading-list-status-filter');
    const typeFilter = page.locator('#reading-list-type-filter');
    const sort = page.locator('#reading-list-sort');
    await expect(page.locator('#reading-list-summary')).toBeVisible();
    await expectSummary(page, [3, 1, 1, 1, 1]);
    expect(await statusFilter.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['all', ...READING_STATUSES]);
    expect(await typeFilter.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['all', ...CONTENT_TYPES]);

    for (const status of READING_STATUSES) {
      await statusFilter.selectOption(status);
      await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(status === 'reading' ? 3 : 1);
    }
    await statusFilter.selectOption('all');
    for (const [category, count] of [['manga', 3], ['manhwa', 2], ['manhua', 2]]) {
      await typeFilter.selectOption(category);
      await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(count);
    }

    await typeFilter.selectOption('manhua');
    await statusFilter.selectOption('reading');
    await sort.selectOption('title');
    const activeEntry = entries[5];
    await expectCardKeys(page, [entryKey(activeEntry)]);
    await changeChapter(controlsFor(page, activeEntry), '11');
    await expectProgress(controlsFor(page, activeEntry), 'reading', 11, 20);
    await expectSummary(page, [3, 1, 1, 1, 1]);
    await openNav(page, 'manga');
    await openReadingList(page);
    await expect(statusFilter).toHaveValue('reading');
    await expect(typeFilter).toHaveValue('manhua');
    await expect(sort).toHaveValue('title');
    await expectCardKeys(page, [entryKey(activeEntry)]);

    await statusFilter.selectOption('completed');
    await expect(page.locator('#reading-list-no-results')).toBeVisible();
    await expect(page.locator('#reading-list-empty')).toBeHidden();
    await expect(page.locator('#reading-list-error')).toBeHidden();
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(0);
    await expectSummary(page, [3, 1, 1, 1, 1]);
    await page.locator('#reading-list-reset').click();
    await expect(statusFilter).toHaveValue('all');
    await expect(typeFilter).toHaveValue('all');
    await expect(sort).toHaveValue('updated');
    await expect(page.locator('#reading-list-no-results')).toBeHidden();
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(7);

    await statusFilter.selectOption('reading');
    await typeFilter.selectOption('manhua');
    await removeEntry(page, activeEntry).click();
    await expect(page.locator('#reading-list-no-results')).toBeVisible();
    await expectSummary(page, [2, 1, 1, 1, 1]);
    expect((await readReadingList(page)).entries).toHaveLength(6);
    await expectWatchlistUnchanged(page);
  });

  test('all sort modes have deterministic equal-value ordering and chapter sorting does not invent unknown totals', async ({ page }) => {
    const same = { title: 'Same title', updatedAt: '2026-10-18T00:00:00.000Z' };
    const manga = savedEntry(comics.manga, { ...same, currentChapter: 4, totalChapters: 8 });
    const manhwa = savedEntry(comics.manhwa, { ...same, currentChapter: 1, totalChapters: 2 });
    const completed = savedEntry(comics.manhua, { title: 'Alpha title', readingStatus: 'completed', currentChapter: 2, totalChapters: 2 });
    const heldUnknown = savedEntry(comics.manhua, { ...same, providerId: 102, readingStatus: 'on_hold', currentChapter: 90, totalChapters: null });
    const droppedUnknown = savedEntry(comics.manga, { providerId: 102, title: 'Zulu title', readingStatus: 'dropped', currentChapter: 0, totalChapters: null, updatedAt: '2026-10-17T00:00:00.000Z' });
    const entries = [manhwa, heldUnknown, droppedUnknown, manga, completed];
    const original = readingRaw(entries);
    await setup(page, { readingRaw: original, catalog: entries.map(comicForEntry) });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    const sort = page.locator('#reading-list-sort');
    expect(await sort.locator('option').evaluateAll(options => options.map(option => option.value))).toEqual(['updated', 'title', 'status', 'progress']);
    const orders = {
      updated: [completed, manga, heldUnknown, manhwa, droppedUnknown],
      title: [completed, manga, heldUnknown, manhwa, droppedUnknown],
      status: [manga, manhwa, completed, heldUnknown, droppedUnknown],
      progress: [heldUnknown, manga, completed, manhwa, droppedUnknown]
    };
    for (const [value, order] of Object.entries(orders)) {
      await sort.selectOption(value);
      await expectCardKeys(page, order.map(entryKey));
    }
    await expectProgress(controlsFor(page, heldUnknown), 'on_hold', 90, null);
    await expectProgress(controlsFor(page, droppedUnknown), 'dropped', 0, null);
    await expect(page.locator('#reading-list-grid')).not.toContainText(/NaN|Infinity|undefined/);
    await openNav(page, 'home');
    await openReadingList(page);
    await expect(sort).toHaveValue('progress');
    await expectCardKeys(page, orders.progress.map(entryKey));
    expect(await readRawReadingList(page)).toBe(original);
  });

  test('Continue Reading includes zero, omitted progress, and unknown totals, orders recent identities, and limits to six', async ({ page }) => {
    const newest = '2026-10-19T12:00:00.000Z';
    const zero = savedEntry(comics.manga, { currentChapter: 0, updatedAt: newest });
    const unknown = savedEntry(comics.manhua, { currentChapter: 3, updatedAt: newest });
    const omitted = savedEntry(comics.manhwa, { updatedAt: newest });
    delete omitted.currentChapter;
    const older = [
      savedEntry(comics.manga, { providerId: 102, title: 'Older manga', currentChapter: 4, totalChapters: 10, updatedAt: '2026-10-18T00:00:00.000Z' }),
      savedEntry(comics.manhwa, { providerId: 102, title: 'Unknown zero', currentChapter: 0, totalChapters: null, updatedAt: '2026-10-17T00:00:00.000Z' }),
      savedEntry(comics.manhua, { providerId: 102, title: 'Sixth title', currentChapter: 5, totalChapters: 20, updatedAt: '2026-10-16T00:00:00.000Z' }),
      savedEntry(comics.manga, { providerId: 103, title: 'Seventh title', currentChapter: 5, updatedAt: '2026-10-15T00:00:00.000Z' })
    ];
    const excluded = [
      savedEntry(comics.manga, { providerId: 104, title: 'Reached total', currentChapter: 10, totalChapters: 10 }),
      savedEntry(comics.manga, { providerId: 105, title: 'Past total', currentChapter: 11, totalChapters: 10 }),
      ...['completed', 'plan_to_read', 'on_hold', 'dropped'].map((readingStatus, index) => savedEntry(comics.manhua, { providerId: 110 + index, title: `${readingStatus} excluded`, readingStatus, currentChapter: 3 }))
    ];
    const entries = [omitted, ...excluded, ...older.slice().reverse(), unknown, zero];
    const original = readingRaw(entries);
    await setup(page, { readingRaw: original, catalog: entries.map(comicForEntry) });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#section-continue-reading')).toBeVisible();
    await expectCardKeys(page, [zero, unknown, omitted, ...older.slice(0, 3)].map(entryKey), 'continue-reading-grid');
    // Merely rendering normalized omitted progress must not rewrite the source.
    expect(await readRawReadingList(page)).toBe(original);
    await page.locator('#continue-reading-grid .anime-card[data-category="manhua"][data-id="101"] .card-title').click();
    await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ page: 'manhua', comicId: '101' });
    await expectProgress(detailControls(page), 'reading', 3, null);
    await detailControls(page).locator('[data-reading-status]').selectOption('on_hold');
    await openNav(page, 'home');
    await expectCardKeys(page, [zero, omitted, ...older].map(entryKey), 'continue-reading-grid');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectCardKeys(page, [zero, omitted, ...older].map(entryKey), 'continue-reading-grid');
    await expectWatchlistUnchanged(page);
  });

  test('Continue Reading updates after completion, chapter edits, removal, and clear without leaving stale cards', async ({ page }) => {
    await setup(page, { readingRaw: savedReadingList() });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expectCardKeys(page, [entryKey(savedEntry())], 'continue-reading-grid');
    await page.locator('#continue-reading-grid .card-title').click();
    await detailControls(page).locator('[data-reading-status]').selectOption('completed');
    await openNav(page, 'home');
    await expect(page.locator('#section-continue-reading')).toBeHidden();
    await expect(page.locator('#continue-reading-grid .anime-card')).toHaveCount(0);

    await openReadingList(page);
    await listControls(page).locator('[data-reading-status]').selectOption('reading');
    await openNav(page, 'home');
    await expect(page.locator('#section-continue-reading')).toBeHidden();
    await openReadingList(page);
    await changeChapter(listControls(page), '0');
    await openNav(page, 'home');
    await expectCardKeys(page, [entryKey(savedEntry())], 'continue-reading-grid');
    await openReadingList(page);
    await removeEntry(page, savedEntry()).click();
    await openNav(page, 'home');
    await expect(page.locator('#section-continue-reading')).toBeHidden();
    await expect(page.locator('#continue-reading-grid .anime-card')).toHaveCount(0);

    await openNav(page, 'manga');
    await catalogToggle(page, comic).click();
    await openReadingList(page);
    await listControls(page).locator('[data-reading-status]').selectOption('reading');
    await clearWithConfirmation(page, true);
    await openNav(page, 'home');
    await expect(page.locator('#section-continue-reading')).toBeHidden();
    await expect(page.locator('#continue-reading-grid .anime-card')).toHaveCount(0);
    expect(await readRawReadingList(page)).toBeNull();
  });

  for (const invalid of [
    { name: 'malformed JSON', raw: '{broken', message: /malformed/i },
    { name: 'an unsupported schema', raw: JSON.stringify({ schemaVersion: 99, entries: [] }), message: /unsupported.*version/i },
    { name: 'an invalid entry among valid entries', raw: readingRaw([savedEntry(), savedEntry(comics.manhwa, { providerId: 0 })]), message: /entries.*recovery/i }
  ]) {
    test(`${invalid.name} remains intact through retry and a blocked add, then recovers after storage is repaired`, async ({ page }) => {
      await setup(page, { readingRaw: invalid.raw });
      await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#reading-list-error')).toBeVisible();
      await expect(page.locator('#reading-list-error-message')).toContainText(invalid.message);
      await expect(page.locator('#reading-list-empty')).toBeHidden();
      await expect(page.locator('#reading-list-no-results')).toBeHidden();
      await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(0);
      await page.locator('#reading-list-retry').click();
      await expect(page.locator('#reading-list-error')).toBeVisible();
      expect(await readRawReadingList(page)).toBe(invalid.raw);

      await openNav(page, 'manga');
      await catalogToggle(page, comic).click();
      await expect(page.locator('#toast')).toHaveClass(/error/);
      await expect(catalogToggle(page, comic)).toHaveAttribute('aria-label', 'Add to reading list');
      expect(await readRawReadingList(page)).toBe(invalid.raw);
      await openReadingList(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#reading-list-error')).toBeVisible();
      expect(await readRawReadingList(page)).toBe(invalid.raw);

      // This is an explicit external repair, not an init-script reseed. Retry
      // must read the repaired value rather than retain its old failure cache.
      await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: READING_LIST_KEY, raw: savedReadingList() });
      await page.locator('#reading-list-retry').click();
      await expect(page.locator('#reading-list-error')).toBeHidden();
      await expectProgress(listControls(page), 'reading', 12);
      await expectSummary(page, [1, 0, 0, 0, 0]);
      await expectWatchlistUnchanged(page);
    });
  }

  for (const mode of ['read', 'getter']) {
    test(`a localStorage ${mode} denial shows recoverable reading-list UI and retry restores the saved list`, async ({ page }) => {
      const original = savedReadingList();
      await setup(page, { readingRaw: original });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.addInitScript(failReadingStorage, { key: READING_LIST_KEY, mode });
      await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#page-reading-list')).toHaveClass(/active/);
      await expect(page.locator('#reading-list-error')).toBeVisible();
      await expect(page.locator('#reading-list-error-message')).toContainText(/read|storage|unavailable/i);
      await expect(page.locator('#reading-list-empty')).toBeHidden();
      await expect(page.locator('#reading-list-no-results')).toBeHidden();
      await page.locator('#reading-list-retry').click();
      await expect(page.locator('#reading-list-error')).toBeVisible();

      await page.evaluate(() => window.__restoreReadingListStorage());
      expect(await readRawReadingList(page)).toBe(original);
      await page.locator('#reading-list-retry').click();
      await expect(page.locator('#reading-list-error')).toBeHidden();
      await expectProgress(listControls(page), 'reading', 12);
      await openNav(page, 'manga');
      await expect(catalogToggle(page, comic)).toHaveAttribute('aria-label', 'Remove from reading list');
      await openNav(page, 'home');
      await expectCardKeys(page, [entryKey(savedEntry())], 'continue-reading-grid');
      expect(pageErrors).toEqual([]);
      expect(await readRawReadingList(page)).toBe(original);
      await expectWatchlistUnchanged(page);
    });
  }

  test('failed catalog adds and list removes preserve prior data and can be retried after writes recover', async ({ page }) => {
    await setup(page);
    await page.goto('/?page=manhwa', { waitUntil: 'domcontentloaded' });
    const item = comics.manhwa;
    const entry = savedEntry(item);
    await page.evaluate(failReadingStorage, { key: READING_LIST_KEY, mode: 'write' });
    await catalogToggle(page, item).click();
    await expect(page.locator('#toast')).toHaveClass(/error/);
    await expect(catalogToggle(page, item)).toHaveAttribute('aria-label', 'Add to reading list');
    expect(await readRawReadingList(page)).toBeNull();
    await openReadingList(page);
    await expect(page.locator('#reading-list-empty')).toBeVisible();

    await page.evaluate(() => window.__restoreReadingListStorage());
    await openNav(page, 'manhwa');
    await catalogToggle(page, item).click();
    await expect(catalogToggle(page, item)).toHaveAttribute('aria-label', 'Remove from reading list');
    const stored = await readRawReadingList(page);
    await openReadingList(page);
    await page.evaluate(failReadingStorage, { key: READING_LIST_KEY, mode: 'write' });
    await removeEntry(page, entry).click();
    await expect(page.locator('#toast')).toHaveClass(/error/);
    await expectProgress(listControls(page), 'plan_to_read', 0, item.chapters);
    await expect(page.locator('#reading-list-empty')).toBeHidden();
    expect(await readRawReadingList(page)).toBe(stored);

    await page.evaluate(() => window.__restoreReadingListStorage());
    await removeEntry(page, entry).click();
    await expect(page.locator('#reading-list-empty')).toBeVisible();
    expect((await readReadingList(page)).entries).toEqual([]);
    await expectWatchlistUnchanged(page);
  });

  test('a valid list can cancel clear, safely report a failed clear, and explicitly clear while filtered', async ({ page }) => {
    const original = readingRaw([savedEntry(), savedEntry(comics.manhua, { readingStatus: 'plan_to_read', currentChapter: 0 })]);
    await setup(page, { readingRaw: original });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    await page.locator('#reading-list-status-filter').selectOption('completed');
    await expect(page.locator('#reading-list-no-results')).toBeVisible();
    await expect(page.locator('#reading-list-clear')).toBeVisible();
    await clearWithConfirmation(page, false);
    expect(await readRawReadingList(page)).toBe(original);
    await expectSummary(page, [1, 0, 1, 0, 0]);

    await page.evaluate(failReadingStorage, { key: READING_LIST_KEY, mode: 'remove' });
    await clearWithConfirmation(page, true);
    await expect(page.locator('#toast')).toHaveClass(/error/);
    await expect(page.locator('#toast')).toContainText(/could not clear/i);
    await expect(page.locator('#reading-list-no-results')).toBeVisible();
    await expect(page.locator('#reading-list-empty')).toBeHidden();
    await expectSummary(page, [1, 0, 1, 0, 0]);
    expect(await readRawReadingList(page)).toBe(original);

    await page.evaluate(() => window.__restoreReadingListStorage());
    await clearWithConfirmation(page, true);
    await expect(page.locator('#reading-list-empty')).toBeVisible();
    await expect(page.locator('#reading-list-no-results')).toBeHidden();
    await expect(page.locator('#reading-list-error')).toBeHidden();
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(0);
    expect(await readRawReadingList(page)).toBeNull();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#reading-list-empty')).toBeVisible();
    expect(await readRawReadingList(page)).toBeNull();
    await expectWatchlistUnchanged(page);
  });

  test('a failed recovery clear leaves malformed data and its error visible', async ({ page }) => {
    const malformed = '{broken';
    await setup(page, { readingRaw: malformed });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#reading-list-error')).toBeVisible();
    await page.evaluate(failReadingStorage, { key: READING_LIST_KEY, mode: 'remove' });
    await clearWithConfirmation(page, true);
    await expect(page.locator('#toast')).toHaveClass(/error/);
    await expect(page.locator('#reading-list-error')).toBeVisible();
    await expect(page.locator('#reading-list-error-message')).toContainText(/malformed/i);
    await expect(page.locator('#reading-list-empty')).toBeHidden();
    expect(await readRawReadingList(page)).toBe(malformed);
    await page.evaluate(() => window.__restoreReadingListStorage());
    await page.locator('#reading-list-retry').click();
    await expect(page.locator('#reading-list-error')).toBeVisible();
    expect(await readRawReadingList(page)).toBe(malformed);
    await expectWatchlistUnchanged(page);
  });

  for (const status of [404, 503]) {
    test(`an unavailable ${status} detail retains its saved item and provides retry, back, and reading-list escapes`, async ({ page }) => {
      const item = comics.manhua;
      const entry = savedEntry(item, { currentChapter: 9 });
      const original = readingRaw([entry]);
      const { fixtures, responseStatuses } = await setup(page, { readingRaw: original });
      fixtures.set('/api/manhua', []);
      responseStatuses.set(`/api/manhua/${item.id}`, status);
      await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
      await page.locator('#reading-list-grid .card-title').click();
      await expect(page.locator('#comic-detail-content').getByRole('heading', { name: 'Title details unavailable' })).toBeVisible();
      await expect(page.locator('#comic-detail-retry')).toBeVisible();
      await expect(page.locator('#comic-detail-back')).toBeVisible();
      expect(await readRawReadingList(page)).toBe(original);
      await page.locator('#comic-detail-retry').click();
      await expect(page.locator('#comic-detail-content').getByRole('heading', { name: 'Title details unavailable' })).toBeVisible();
      await page.locator('#comic-detail-back').click();
      await expect(page.locator('#page-manhua')).toHaveClass(/active/);
      await expect(page.locator('#manhua-empty')).toBeVisible();
      await openReadingList(page);
      await expectProgress(listControls(page), 'reading', 9, null);
      expect(await readRawReadingList(page)).toBe(original);

      responseStatuses.set(`/api/manhua/${item.id}`, 200);
      await page.locator('#reading-list-grid .card-title').click();
      await expectProgress(detailControls(page), 'reading', 9, null);
      await expect(detailToggle(page, item)).toHaveAttribute('aria-label', 'Remove from reading list');
      expect(await readRawReadingList(page)).toBe(original);
      await expectWatchlistUnchanged(page);
    });
  }

  test('a changed catalog total never clamps saved progress, including completion beyond a lowered total', async ({ page }) => {
    const entry = savedEntry(comic, { currentChapter: 12, totalChapters: 8 });
    const original = readingRaw([entry]);
    const { fixtures } = await setup(page, { readingRaw: original, catalog: [{ ...comic, chapters: 8 }] });
    await page.goto(`/?page=manga&comicId=${comic.id}`, { waitUntil: 'domcontentloaded' });
    await expectProgress(detailControls(page), 'reading', 12, 8);
    await expect(detailControls(page).locator('.reading-progress-warning')).toContainText(/total changed.*progress preserved/i);
    expect(await readRawReadingList(page)).toBe(original);
    await detailControls(page).locator('[data-reading-status]').selectOption('completed');
    await expectProgress(detailControls(page), 'completed', 12, 8);
    await openReadingList(page);
    await expectProgress(listControls(page), 'completed', 12, 8);
    await expect(listControls(page).locator('.reading-progress-warning')).toBeVisible();

    // A subsequent provider response can disagree again. Opening details is
    // never permission to replace a person's already saved chapter count.
    fixtures.set(`/api/manga/${comic.id}`, { ...comic, chapters: 4 });
    await page.locator('#reading-list-grid .card-title').click();
    await expect(page.locator('#comic-detail-content .detail-meta-row')).toContainText('Chapters: 4');
    await expect(detailControls(page).locator('[data-reading-chapter]')).toHaveValue('12');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(detailControls(page).locator('[data-reading-chapter]')).toHaveValue('12');
    expect((await readReadingList(page)).entries[0].currentChapter).toBe(12);
    await expectWatchlistUnchanged(page);
  });

  test('focused edits and native keyboard controls never activate their surrounding card', async ({ page }) => {
    const first = savedEntry();
    const second = savedEntry(comics.manhua, { currentChapter: 4 });
    await setup(page, { readingRaw: readingRaw([first, second]) });
    const dialogs = recordUnexpectedDialogs(page);
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    const controls = controlsFor(page, first);
    const status = controls.locator('[data-reading-status]');
    const chapter = controls.locator('[data-reading-chapter]');
    await status.focus();
    await status.selectOption('on_hold');
    await expect(status).toBeFocused();
    await expectSummary(page, [1, 0, 0, 1, 0]);
    await changeChapter(controls, '14');
    await expect(chapter).toBeFocused();
    await chapter.press('ArrowUp');
    await chapter.press('Enter');
    await expectProgress(controls, 'on_hold', 15);
    await expect(chapter).toBeFocused();
    await expect(page.locator('#page-reading-list')).toHaveClass(/active/);
    await status.focus();
    await status.press('End');
    await status.press('Enter');
    await status.press('Escape');
    await expect(status).toHaveValue('dropped');
    await expect(status).toBeFocused();
    await expect(page.locator('#page-reading-list')).toHaveClass(/active/);
    expect((await readReadingList(page)).entries.find(entry => entryKey(entry) === entryKey(first))).toMatchObject({ readingStatus: 'dropped', currentChapter: 15 });

    await removeEntry(page, first).focus();
    await removeEntry(page, first).press('Space');
    await expectCardKeys(page, [entryKey(second)]);
    await expect(page.locator('#page-reading-list')).toHaveClass(/active/);
    await openNav(page, 'manga');
    const toggle = catalogToggle(page, comic);
    await toggle.focus();
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-label', 'Remove from reading list');
    await expect(toggle).toBeFocused();
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-label', 'Add to reading list');
    await expect(page.locator('#page-manga')).toHaveClass(/active/);
    await openReadingList(page);
    const card = page.locator('#reading-list-grid .anime-card .reading-detail-link').first();
    await card.focus();
    await card.press('Enter');
    await expect(page.locator('#page-comic-detail')).toHaveClass(/active/);
    await expectProgress(detailControls(page), 'reading', 4, null);
    expect(dialogs).toEqual([]);
    await expectWatchlistUnchanged(page);
  });

  test('reading controls have native accessible names, usable mobile targets, no page overflow, and reduced-motion styles', async ({ page }) => {
    const longTitle = 'LongComicTitleWithoutSpaces'.repeat(12);
    const entry = savedEntry(comic, { title: longTitle, currentChapter: 0 });
    await setup(page, { readingRaw: readingRaw([entry]) });
    await page.setViewportSize({ width: 375, height: 667 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    const surface = page.locator('#page-reading-list');
    await expect(surface.getByRole('combobox', { name: /filter.*status|status.*filter/i })).toHaveAttribute('id', 'reading-list-status-filter');
    await expect(surface.getByRole('combobox', { name: /filter.*type|type.*filter/i })).toHaveAttribute('id', 'reading-list-type-filter');
    await expect(surface.getByRole('combobox', { name: /sort/i })).toHaveAttribute('id', 'reading-list-sort');
    await expect(surface.getByRole('combobox', { name: `Reading status for ${longTitle}`, exact: true })).toHaveValue('reading');
    const chapter = surface.getByRole('spinbutton', { name: `Current chapter for ${longTitle}`, exact: true });
    await expect(chapter).toHaveAttribute('min', '0');
    await expect(chapter).toHaveAttribute('step', '1');
    await expect(surface.getByRole('button', { name: /reset/i })).toHaveAttribute('id', 'reading-list-reset');
    await expect(surface.getByRole('button', { name: /clear/i })).toHaveAttribute('id', 'reading-list-clear');
    await expect(removeEntry(page, entry)).toHaveAccessibleName(/remove.*reading list/i);
    await expect(page.locator('#reading-list-status')).toHaveAttribute('role', 'status');
    await expect(page.locator('#reading-list-status')).toHaveAttribute('aria-live', 'polite');

    const nativeControls = surface.locator('#reading-list-status-filter, #reading-list-type-filter, #reading-list-sort, #reading-list-reset, #reading-list-clear, [data-reading-status], [data-reading-chapter], [data-reading-remove]');
    for (const control of await nativeControls.all()) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await control.evaluate(element => element.tagName)).toMatch(/^(SELECT|INPUT|BUTTON)$/);
    }
    const expectNoOverflow = async () => {
      const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
      expect(widths.content).toBeLessThanOrEqual(widths.viewport + 1);
    };
    await expectNoOverflow();
    const durations = await page.locator('#reading-list-grid .anime-card').evaluate(element => {
      const style = getComputedStyle(element);
      return [style.animationDuration, style.transitionDuration].flatMap(value => value.split(',').map(duration => parseFloat(duration) / (duration.trim().endsWith('ms') ? 1000 : 1)));
    });
    expect(Math.max(...durations)).toBeLessThanOrEqual(0.01);
    await openNav(page, 'home');
    await expect(page.locator('#section-continue-reading')).toBeVisible();
    await expectNoOverflow();
    await expectWatchlistUnchanged(page);
  });

  test('metadata increases and explicit completed-chapter corrections survive detail refresh and reload without invented progress', async ({ page }) => {
    const entry = savedEntry(comic, { readingStatus: 'completed', currentChapter: 8, totalChapters: 8 });
    const { fixtures } = await setup(page, { readingRaw: readingRaw([entry]), catalog: [{ ...comic, chapters: 12 }] });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    await page.locator('#reading-list-grid .reading-detail-link').first().focus();
    await page.locator('#reading-list-grid .reading-detail-link').first().press('Enter');
    await expect(page.locator('#comic-detail-content h1')).toBeFocused();
    await expectProgress(detailControls(page), 'completed', 8, 12);
    expect((await readReadingList(page)).entries[0]).toMatchObject({ currentChapter: 8, totalChapters: 12, updatedAt: entry.updatedAt });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectProgress(detailControls(page), 'completed', 8, 12);
    await changeChapter(detailControls(page), '3');
    await expectProgress(detailControls(page), 'completed', 3, 12);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectProgress(detailControls(page), 'completed', 3, 12);
    fixtures.set('/api/manga/101', { ...comic, chapters: null });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectProgress(detailControls(page), 'completed', 3, null);
    await expectWatchlistUnchanged(page);
  });

  test('a storage read failure during an edit reveals recovery immediately and preserves bytes for retry', async ({ page }) => {
    const original = savedReadingList();
    await setup(page, { readingRaw: original });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    await expectProgress(listControls(page), 'reading', 12);
    await page.evaluate(failReadingStorage, { key: READING_LIST_KEY, mode: 'read' });
    await changeChapter(listControls(page), '15');
    await expect(page.locator('#reading-list-error')).toBeVisible();
    await expect(page.locator('#reading-list-retry')).toBeFocused();
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(0);
    await page.evaluate(() => window.__restoreReadingListStorage());
    expect(await readRawReadingList(page)).toBe(original);
    await page.locator('#reading-list-retry').click();
    await expectProgress(listControls(page), 'reading', 12);
    await expect(page.locator('#reading-list-error')).toBeHidden();
    await expectWatchlistUnchanged(page);
  });

  test('real cross-tab updates preserve a pending chapter draft and merge only the edited field', async ({ page, context }) => {
    const entry = savedEntry();
    const extra = savedEntry(comics.manhua, { title: 'Another tab title', currentChapter: 0 });
    await setup(page, { readingRaw: readingRaw([entry]) });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    const chapter = controlsFor(page, entry).locator('[data-reading-chapter]');
    await chapter.fill('15');
    const other = await context.newPage();
    await other.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === new URL(test.info().project.use.baseURL).origin && url.pathname === '/api/health'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
        : route.abort();
    });
    await other.goto('/api/health', { waitUntil: 'domcontentloaded' });
    const external = [{ ...entry, readingStatus: 'on_hold', currentChapter: 4 }, extra];
    await other.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: READING_LIST_KEY, raw: readingRaw(external) });
    await expect(page.locator('#toast')).toContainText('changed in another tab');
    await expect(chapter).toHaveValue('15');
    await chapter.dispatchEvent('change');
    await expectProgress(controlsFor(page, entry), 'on_hold', 15);
    await expect(controlsFor(page, entry).locator('[data-reading-chapter]')).toBeFocused();
    await expect(page.locator('#reading-list-grid .anime-card')).toHaveCount(2);
    expect((await readReadingList(page)).entries.find(item => entryKey(item) === entryKey(entry))).toMatchObject({ readingStatus: 'on_hold', currentChapter: 15 });
    await expectWatchlistUnchanged(page);
    await other.close();
  });

  test('saved titles and posters render as inert text and safe image URLs', async ({ page }) => {
    const title = '<img src=x onerror="window.__readingInjected=true"> & "comic"';
    const entry = savedEntry(comic, { title, poster: 'javascript:window.__readingInjected=true' });
    await setup(page, { readingRaw: readingRaw([entry]) });
    await page.goto('/?page=reading-list', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#reading-list-grid .card-title')).toHaveText(title);
    await expect(page.locator('#reading-list-grid [onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => window.__readingInjected)).toBeUndefined();
    const image = await page.locator('#reading-list-grid .card-image').getAttribute('src');
    expect(image).not.toMatch(/^javascript:/i);
    await expectWatchlistUnchanged(page);
  });

  test('anime episode controls and sentinel storage remain isolated from comic chapter edits in both directions', async ({ page }) => {
    const original = savedReadingList();
    const { requests } = await setup(page, { readingRaw: original });
    await page.goto('/?page=watchlist', { waitUntil: 'domcontentloaded' });
    const watchControls = page.locator('#watchlist-grid [data-watch-controls]');
    await expect(watchControls.locator('[data-watch-status]')).toHaveValue('watching');
    await expect(watchControls.locator('[data-watch-episode]')).toHaveValue('3');
    await expect(page.locator('#watchlist-grid [data-reading-controls], #watchlist-grid [data-reading-toggle], #watchlist-grid [data-reading-remove]')).toHaveCount(0);
    await watchControls.locator('[data-watch-episode]').selectOption('4');
    await expect(watchControls.locator('[data-watch-episode]')).toHaveValue('4');
    const animeRaw = await page.evaluate(key => localStorage.getItem(key), WATCHLIST_KEY);
    expect(JSON.parse(animeRaw)[0]).toMatchObject({ id: 77, watchStatus: 'watching', currentEpisode: 4, totalEpisodes: 24 });
    expect(await readRawReadingList(page)).toBe(original);

    await openReadingList(page);
    await expect(page.locator('#reading-list-grid [data-watch-controls], #reading-list-grid [data-watch-episode], #reading-list-grid [data-bookmark-id]')).toHaveCount(0);
    await changeChapter(listControls(page), '15');
    await listControls(page).locator('[data-reading-status]').selectOption('on_hold');
    await expectProgress(listControls(page), 'on_hold', 15);
    expect(await page.evaluate(key => localStorage.getItem(key), WATCHLIST_KEY)).toBe(animeRaw);
    for (const entry of (await readReadingList(page)).entries) {
      for (const field of ['watchStatus', 'currentEpisode', 'totalEpisodes', 'episodes']) expect(entry).not.toHaveProperty(field);
    }
    for (const entry of JSON.parse(animeRaw)) {
      for (const field of ['readingStatus', 'currentChapter', 'totalChapters', 'providerId', 'contentType']) expect(entry).not.toHaveProperty(field);
    }
    await openNav(page, 'home');
    await expect(page.locator('#continue-watching-grid .card-title')).toHaveText('Anime sentinel');
    await expect(page.locator('#section-continue-reading')).toBeHidden();
    await openNav(page, 'watchlist');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(watchControls.locator('[data-watch-episode]')).toHaveValue('4');
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });
});
