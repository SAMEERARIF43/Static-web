const { test, expect } = require('@playwright/test');

/**
 * Browser verification for the movie/TV classification of watch controls.
 *
 * Two things are asserted here that no unit test can reach:
 *   1. the real DOM on BOTH surfaces (detail page + watchlist page) — a movie
 *      must expose only the status control, a TV series must keep its episode
 *      selector and progress controls;
 *   2. persistence across a real page reload after a status/episode change, and
 *      the legacy guest repair (missing `type`) being written to localStorage.
 *
 * The catalog is served from fixtures so the suite does not depend on live
 * AniList availability, and every non-local request is aborted so the
 * render-blocking Google Fonts CSS and the Supabase UMD script can never stall
 * DOMContentLoaded (auth-ui.js treats a missing Supabase library as "not
 * signed in", which matches the guest flows under test).
 */

const WATCHLIST_KEY = 'anime_hub_watchlist';
const MOVIE_ID = 20954;
const SERIES_ID = 21;

const MOVIE_FIXTURE = {
  id: MOVIE_ID,
  type: 'MOVIE',
  format: 'MOVIE',
  title: { english: 'A Silent Voice', romaji: 'Koe no Katachi', native: '声の形' },
  coverImage: { extraLarge: 'https://img.example/20954.jpg', large: 'https://img.example/20954.jpg' },
  bannerImage: null,
  description: 'Fixture movie used by the watch-control browser tests.',
  episodes: 1,
  status: 'FINISHED',
  averageScore: 84,
  genres: ['Drama'],
  season: 'SUMMER',
  seasonYear: 2016,
  duration: 130,
  source: 'MANGA',
  countryOfOrigin: 'JP',
  studios: { nodes: [{ name: 'Kyoto Animation' }] },
  staff: { edges: [] },
  characters: { edges: [] },
  relations: { edges: [] },
  recommendations: { edges: [] },
  trailer: null
};

const SERIES_FIXTURE = {
  id: SERIES_ID,
  type: 'TV',
  format: 'TV',
  title: { english: 'ONE PIECE', romaji: 'One Piece', native: 'ONE PIECE' },
  coverImage: { extraLarge: 'https://img.example/21.jpg', large: 'https://img.example/21.jpg' },
  bannerImage: null,
  description: 'Fixture TV series used by the watch-control browser tests.',
  episodes: 1100,
  status: 'RELEASING',
  averageScore: 90,
  genres: ['Action'],
  season: 'FALL',
  seasonYear: 1999,
  duration: 24,
  source: 'MANGA',
  countryOfOrigin: 'JP',
  studios: { nodes: [{ name: 'Toei Animation' }] },
  staff: { edges: [] },
  characters: { edges: [] },
  relations: { edges: [] },
  recommendations: { edges: [] },
  trailer: null
};

// Seeded guest entries: the movie is LEGACY (no `type`, exactly what the old
// card-bookmark path wrote); the series already carries its type.
const legacyMovie = () => ({
  id: MOVIE_ID,
  title: 'A Silent Voice',
  poster: 'https://img.example/20954.jpg',
  image: 'https://img.example/20954.jpg',
  episodes: 1,
  watchStatus: 'watching',
  currentEpisode: 1
});

const typedSeries = (overrides = {}) => ({
  id: SERIES_ID,
  title: 'ONE PIECE',
  poster: 'https://img.example/21.jpg',
  image: 'https://img.example/21.jpg',
  type: 'TV',
  episodes: 1100,
  totalEpisodes: 1100,
  watchStatus: 'plan_to_watch',
  currentEpisode: 0,
  ...overrides
});

// Routes are matched last-registered-first, so the catch-all abort is
// installed first and the local catalog fixtures override it.
async function setupRoutes(page, { catalogDown = false } = {}) {
  await page.route('**/*', route => {
    const { hostname } = new URL(route.request().url());
    if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });

  await page.route('**/api/anime/*', route => {
    if (catalogDown) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    const fixture = id === MOVIE_ID ? MOVIE_FIXTURE : id === SERIES_ID ? SERIES_FIXTURE : null;
    if (!fixture) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"not found"}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
  });

  await page.route('**/api/movies', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([MOVIE_FIXTURE]) }));
}

// Seed localStorage without booting the app, then navigate to the real page.
async function seedAndGo(page, entries, url) {
  await page.goto('/api/health');
  await page.evaluate(
    ([key, list]) => localStorage.setItem(key, JSON.stringify(list)),
    [WATCHLIST_KEY, entries]
  );
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

const readWatchlist = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), WATCHLIST_KEY);

test.describe('Watch controls: movie vs TV series', () => {
  test('legacy movie on the detail page: status-only controls, repair persisted, status survives reload', async ({ page }) => {
    await setupRoutes(page);
    await seedAndGo(page, [legacyMovie()], `/?id=${MOVIE_ID}`);

    await expect(page.locator('.detail-title')).toHaveText('A Silent Voice', { timeout: 20000 });

    const controls = page.locator('.detail-info [data-watch-controls]');
    await expect(controls).toHaveCount(1);
    await expect(controls.locator('[data-watch-status]')).toHaveCount(1);
    await expect(controls.locator('[data-watch-episode]')).toHaveCount(0);
    await expect(controls.locator('.episode-selector')).toHaveCount(0);
    await expect(controls.locator('.episode-selector-search')).toHaveCount(0);

    // The repair must have been written by the real saveWatchlist() path.
    const afterRepair = await readWatchlist(page);
    expect(afterRepair).toHaveLength(1);
    expect(afterRepair[0].type).toBe('MOVIE');
    expect(afterRepair[0].watchStatus).toBe('watching');
    expect(afterRepair[0].currentEpisode).toBe(1);
    expect(afterRepair[0].title).toBe('A Silent Voice');
    expect(afterRepair[0].id).toBe(MOVIE_ID);

    // Change the status and wait for the real persistence, then reload.
    await controls.locator('[data-watch-status]').selectOption('completed');
    await page.waitForFunction(([key, id]) => {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      return list.some(item => String(item.id) === String(id) && item.watchStatus === 'completed');
    }, [WATCHLIST_KEY, MOVIE_ID], { timeout: 15000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.detail-title')).toHaveText('A Silent Voice', { timeout: 20000 });
    const reloaded = page.locator('.detail-info [data-watch-controls]');
    await expect(reloaded.locator('[data-watch-status]')).toHaveValue('completed');
    await expect(reloaded.locator('[data-watch-episode]')).toHaveCount(0);

    const persisted = await readWatchlist(page);
    expect(persisted[0].type).toBe('MOVIE');
    expect(persisted[0].watchStatus).toBe('completed');
    expect(persisted[0].currentEpisode).toBe(1);
    expect(persisted[0].id).toBe(MOVIE_ID);
  });

  test('TV series on the detail page: episode selector kept, episode 99 survives reload', async ({ page }) => {
    await setupRoutes(page);
    await seedAndGo(page, [typedSeries()], `/?id=${SERIES_ID}`);

    await expect(page.locator('.detail-title')).toHaveText('ONE PIECE', { timeout: 20000 });

    const controls = page.locator('.detail-info [data-watch-controls]');
    await expect(controls).toHaveCount(1);
    await expect(controls.locator('[data-watch-status]')).toHaveCount(1);
    const episodeSelect = controls.locator('[data-watch-episode]');
    await expect(episodeSelect).toBeVisible();
    await expect(episodeSelect.locator('option')).toHaveCount(1101);
    await expect(controls.locator('.episode-selector-search')).toHaveCount(1);

    await episodeSelect.selectOption('99');
    await page.waitForFunction(([key, id]) => {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      return list.some(item => String(item.id) === String(id) && item.currentEpisode === 99);
    }, [WATCHLIST_KEY, SERIES_ID], { timeout: 15000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.detail-title')).toHaveText('ONE PIECE', { timeout: 20000 });
    const reloaded = page.locator('.detail-info [data-watch-controls]');
    await expect(reloaded.locator('[data-watch-episode]')).toHaveValue('99');
    await expect(reloaded.locator('[data-watch-status]')).toHaveValue('plan_to_watch');

    const persisted = await readWatchlist(page);
    expect(persisted[0].currentEpisode).toBe(99);
    expect(persisted[0].type).toBe('TV');
  });

  test('watchlist page: movie card is status-only (after repair), series card keeps its episode selector', async ({ page }) => {
    await setupRoutes(page);
    await seedAndGo(page, [legacyMovie(), typedSeries()], '/?page=watchlist');

    await expect(page.locator('#watchlist-grid .anime-card')).toHaveCount(2, { timeout: 20000 });

    // The watchlist-page repair must have run before the grid rendered.
    const stored = await readWatchlist(page);
    expect(stored.find(item => item.id === MOVIE_ID).type).toBe('MOVIE');
    expect(stored.find(item => item.id === SERIES_ID).type).toBe('TV');
    expect(stored.find(item => item.id === MOVIE_ID).currentEpisode).toBe(1);

    const movieCard = page.locator(`#watchlist-grid .anime-card[data-id="${MOVIE_ID}"]`);
    const movieControls = movieCard.locator('[data-watch-controls]');
    await expect(movieControls).toHaveCount(1);
    await expect(movieControls.locator('[data-watch-status]')).toHaveCount(1);
    await expect(movieControls.locator('[data-watch-episode]')).toHaveCount(0);
    await expect(movieControls.locator('.episode-selector-search')).toHaveCount(0);

    const seriesCard = page.locator(`#watchlist-grid .anime-card[data-id="${SERIES_ID}"]`);
    const seriesControls = seriesCard.locator('[data-watch-controls]');
    await expect(seriesControls).toHaveCount(1);
    await expect(seriesControls.locator('[data-watch-status]')).toHaveCount(1);
    await expect(seriesControls.locator('[data-watch-episode]')).toHaveCount(1);
    await expect(seriesControls.locator('.episode-selector-search')).toHaveCount(1);

    // Change the movie status on the watchlist surface.
    await movieControls.locator('[data-watch-status]').selectOption('dropped');
    await page.waitForFunction(([key, id]) => {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      return list.some(item => String(item.id) === String(id) && item.watchStatus === 'dropped');
    }, [WATCHLIST_KEY, MOVIE_ID], { timeout: 15000 });

    // Change the series episode on the same surface.
    await seriesControls.locator('[data-watch-episode]').selectOption('99');
    await page.waitForFunction(([key, id]) => {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      return list.some(item => String(item.id) === String(id) && item.currentEpisode === 99);
    }, [WATCHLIST_KEY, SERIES_ID], { timeout: 15000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#watchlist-grid .anime-card')).toHaveCount(2, { timeout: 20000 });

    const movieAfter = page.locator(`#watchlist-grid .anime-card[data-id="${MOVIE_ID}"] [data-watch-controls]`);
    await expect(movieAfter.locator('[data-watch-status]')).toHaveValue('dropped');
    await expect(movieAfter.locator('[data-watch-episode]')).toHaveCount(0);

    const seriesAfter = page.locator(`#watchlist-grid .anime-card[data-id="${SERIES_ID}"] [data-watch-controls]`);
    await expect(seriesAfter.locator('[data-watch-episode]')).toHaveValue('99');
    await expect(seriesAfter.locator('[data-watch-status]')).toHaveValue('plan_to_watch');
  });

  test('watchlist page with the catalog down: the legacy entry is left intact, not guessed and not lost', async ({ page }) => {
    await setupRoutes(page, { catalogDown: true });
    const seeded = [legacyMovie()];
    await seedAndGo(page, seeded, '/?page=watchlist');

    await expect(page.locator('#watchlist-grid .anime-card')).toHaveCount(1, { timeout: 20000 });
    const stored = await readWatchlist(page);
    expect(stored, 'a failed repair must never drop the entry').toHaveLength(1);
    expect(stored[0].type, 'a failed repair must not guess the type').toBeUndefined();
    expect(stored[0].watchStatus).toBe('watching');
    expect(stored[0].currentEpisode).toBe(1);
    expect(stored[0].id).toBe(MOVIE_ID);
  });

  test('a brand-new guest movie bookmark stores type MOVIE', async ({ page }) => {
    await setupRoutes(page);
    await page.goto('/?page=movies', { waitUntil: 'domcontentloaded' });

    const bookmark = page.locator(`#movies-grid .anime-card[data-id="${MOVIE_ID}"] .card-watchlist-btn`);
    await expect(bookmark).toBeVisible({ timeout: 20000 });
    await expect(bookmark).toHaveAttribute('data-type', 'MOVIE');
    await bookmark.click();

    await page.waitForFunction(([key, id]) => {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      return list.some(item => String(item.id) === String(id) && item.type === 'MOVIE');
    }, [WATCHLIST_KEY, MOVIE_ID], { timeout: 15000 });

    const stored = await readWatchlist(page);
    const saved = stored.find(item => String(item.id) === String(MOVIE_ID));
    expect(saved.type).toBe('MOVIE');
    expect(saved.watchStatus).toBe('plan_to_watch');
    expect(saved.episodes).toBe(1);

    // Reload the watchlist surface and confirm the card is classified as a movie.
    await page.goto('/?page=watchlist', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#watchlist-grid .anime-card')).toHaveCount(1, { timeout: 20000 });
    const controls = page.locator(`#watchlist-grid .anime-card[data-id="${MOVIE_ID}"] [data-watch-controls]`);
    await expect(controls.locator('[data-watch-status]')).toHaveCount(1);
    await expect(controls.locator('[data-watch-episode]')).toHaveCount(0);
  });

  test('unknown total (totalEpisodes null + legacy episodes 0) still accepts episode 99', async ({ page }) => {
    await setupRoutes(page);
    await seedAndGo(page, [typedSeries({ episodes: 0, totalEpisodes: null, watchStatus: 'watching' })], '/?page=watchlist');

    await expect(page.locator('#watchlist-grid .anime-card')).toHaveCount(1, { timeout: 20000 });
    const controls = page.locator(`#watchlist-grid .anime-card[data-id="${SERIES_ID}"] [data-watch-controls]`);
    await expect(controls.locator('[data-watch-episode]')).toHaveCount(1);

    const episodeInput = controls.locator('[data-watch-episode]');
    await episodeInput.fill('99');
    // Playwright's fill() guarantees an `input` event; commit it the way a blur
    // would so the delegated `change` handler is the one under test.
    await episodeInput.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));

    await page.waitForFunction(([key, id]) => {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      return list.some(item => String(item.id) === String(id) && item.currentEpisode === 99);
    }, [WATCHLIST_KEY, SERIES_ID], { timeout: 15000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#watchlist-grid .anime-card')).toHaveCount(1, { timeout: 20000 });
    await expect(
      page.locator(`#watchlist-grid .anime-card[data-id="${SERIES_ID}"] [data-watch-episode]`)
    ).toHaveValue('99');

    const stored = await readWatchlist(page);
    expect(stored[0].currentEpisode).toBe(99);
    expect(stored[0].totalEpisodes).toBeNull();
  });

  test('home page shows unfinished guest progress in Continue Watching', async ({ page }) => {
    await setupRoutes(page);
    await seedAndGo(page, [typedSeries({ currentEpisode: 7, watchStatus: 'watching' })], '/');

    const shelf = page.locator('#section-continue-watching');
    await expect(shelf).toBeVisible({ timeout: 15000 });
    await expect(shelf.locator('.anime-card')).toHaveCount(1);
    await expect(shelf).toContainText('ONE PIECE');
  });
});
