const { test, expect } = require('@playwright/test');

// Minimal card payload: renderAnimeCard reads title (string ok), poster, rating,
// status, type and episodes; nothing else is required to render a card.
function mockCard(id, title) {
  return {
    id,
    anilistId: id,
    title,
    poster: 'https://placehold.co/300x450',
    rating: 8,
    status: 'Finished',
    type: 'TV',
    episodes: 12
  };
}

// Below 901px the nav links live in an off-canvas drawer (script.js toggles
// `#nav-links.open` from `#mobile-menu`), so `[data-nav]` resolves but is not
// actionable until the hamburger opens it — on a desktop viewport the same
// links sit inline. Opening the drawer explicitly keeps this one spec valid on
// every viewport project instead of hanging for the whole test timeout.
async function clickNav(page, nav) {
  const { width } = page.viewportSize();
  if (width < 901) {
    const isOpen = await page.locator('#nav-links').evaluate(el => el.classList.contains('open'));
    if (!isOpen) await page.locator('#mobile-menu').click();
  }
  // Scoped to the nav: `[data-nav]` also appears on in-page CTA and
  // "View All" links, which a bare selector would match ambiguously.
  await page.locator(`#nav-links [data-nav="${nav}"]`).click();
}

// Mock data for home page catalog endpoints to avoid rate limits and AniList latency.
const MOCK_TRENDING = [mockCard(900001, 'Mock Trending 1'), mockCard(900002, 'Mock Trending 2')];
const MOCK_POPULAR = [mockCard(900003, 'Mock Popular 1'), mockCard(900004, 'Mock Popular 2')];
const MOCK_MOVIES = [
  { ...mockCard(900005, 'Mock Movie 1'), type: 'MOVIE', format: 'MOVIE' },
  { ...mockCard(900006, 'Mock Movie 2'), type: 'MOVIE', format: 'MOVIE' }
];
const MOCK_GENRE_ACTION = [mockCard(900007, 'Mock Action 1'), mockCard(900008, 'Mock Action 2')];

test.describe('Genre Loading', () => {
  test.beforeEach(async ({ page }) => {
    // Hermetic run: index.html loads render-blocking Google Fonts CSS and a
    // synchronous Supabase UMD script from public CDNs. If those hosts hang or
    // are unreachable, DOMContentLoaded never fires and page.goto times out
    // even though the local app is healthy. These specs exercise the LOCAL
    // app, so every non-local request is aborted; auth-ui.js treats a missing
    // Supabase library as "not signed in", which matches these guest flows.
    await page.route('**/*', route => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      return route.abort();
    });

    // Mock home page catalog endpoints to avoid rate limits and AniList latency.
    await page.route('**/api/trending', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_TRENDING) }));
    await page.route('**/api/popular', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_POPULAR) }));
    await page.route('**/api/movies', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_MOVIES) }));
    // Mock genre endpoint used by the home page genre chip test.
    await page.route('**/api/genre/Action', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_GENRE_ACTION) }));

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  });

  test('Home page genre chip loads results', async ({ page }) => {
    // Click on a genre chip on the home page
    const actionChip = page.locator('.genre-btn[data-genre="Action"]').first();
    await expect(actionChip).toBeVisible({ timeout: 15000 });

    // Click the genre chip
    await actionChip.click();

    // Wait for results to load
    await expect(page.locator('#trending-grid .anime-card').first()).toBeVisible({ timeout: 30000 });
  });

  test('Series page genre chip loads results', async ({ page }) => {
    // Navigate to series page
    await clickNav(page, 'series');
    await expect(page.locator('#page-series')).toHaveClass(/active/, { timeout: 15000 });

    // Wait for genre buttons to be visible
    await expect(page.locator('#series-genre-filter .genre-btn[data-genre="Action"]')).toBeVisible({ timeout: 15000 });

    // Click on a genre chip
    const actionChip = page.locator('#series-genre-filter .genre-btn[data-genre="Action"]');
    await actionChip.click();

    // Wait for results to load
    await expect(page.locator('#series-grid .anime-card').first()).toBeVisible({ timeout: 30000 });
  });

  test('Movies page loads (no genre chips)', async ({ page }) => {
    // Navigate to movies page
    await clickNav(page, 'movies');
    await expect(page.locator('#page-movies')).toHaveClass(/active/, { timeout: 15000 });

    // Movies page doesn't have genre chips - verify it loads
    await expect(page.locator('#movies-grid .anime-card').first()).toBeVisible({ timeout: 15000 });
  });

  test('Popular page genre filter works', async ({ page }) => {
    // Navigate to popular page
    await clickNav(page, 'popular');
    await expect(page.locator('#page-popular')).toHaveClass(/active/, { timeout: 15000 });

    // Wait for the genre filter dropdown to populate
    await page.waitForSelector('#filter-genre option', { timeout: 15000 });

    // Select a genre
    await page.selectOption('#filter-genre', 'Action');

    // Wait for results to load
    await expect(page.locator('#popular-page-grid .anime-card').first()).toBeVisible({ timeout: 30000 });
  });

  test('Popular page shows a retryable error when the catalog request fails', async ({ page }) => {
    let failFirst = true;
    await page.route('**/api/browse*', route => {
      if (failFirst) {
        failFirst = false;
        return route.abort('failed');
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Catalog-Has-Next': 'false', 'X-Catalog-Total': '1' },
        body: JSON.stringify([mockCard(900011, 'Retry Catalog Title')])
      });
    });

    await clickNav(page, 'popular');
    const errorState = page.locator('#popular-page-grid .catalog-load-error');
    await expect(errorState).toBeVisible({ timeout: 15000 });
    await expect(errorState).toHaveAttribute('role', 'alert');
    await errorState.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('#popular-page-grid .anime-card')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('#popular-page-grid')).toContainText('Retry Catalog Title');
  });

  test('Popular catalog timeout leaves a retryable alert instead of skeletons', async ({ page }) => {
    await page.evaluate(() => { window.__ANIME_HUB_REQUEST_TIMEOUTS = { catalog: 50 }; });
    await page.route('**/api/browse*', async () => {
      await new Promise(() => {});
    });

    await clickNav(page, 'popular');
    const errorState = page.locator('#popular-page-grid .catalog-load-error');
    await expect(errorState).toBeVisible({ timeout: 15000 });
    await expect(errorState).toHaveAttribute('role', 'alert');
    await expect(errorState).toContainText('Unable to load the catalog');
  });

  test('Retry button works after network failure', async ({ page }) => {
    // The first Action request fails at the network level; the retry succeeds.
    let failFirst = true;
    await page.route('**/api/genre/Action', route => {
      if (failFirst) {
        failFirst = false;
        return route.abort('failed');
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([mockCard(900001, 'Retry Mock Title')])
      });
    });

    await page.click('#genre-filter-bar .genre-btn[data-genre="Action"]');

    // The failure renders an alert with a retry button, not a blank grid.
    const errorState = page.locator('#trending-grid .genre-load-error');
    await expect(errorState).toBeVisible({ timeout: 15000 });
    await expect(errorState).toHaveAttribute('role', 'alert');
    await expect(page.locator('#trending-grid .anime-card')).toHaveCount(0);

    // Retry re-issues the request, which now succeeds.
    await errorState.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('#trending-grid .anime-card')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('#trending-grid')).toContainText('Retry Mock Title');
    await expect(page.locator('#trending-grid .genre-load-error')).toHaveCount(0);
  });

  test('Malformed response handled safely', async ({ page }) => {
    // 200 OK but not an array: the client must show the error state, never crash.
    await page.route('**/api/genre/Action', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ not: 'an array' })
    }));

    await page.click('#genre-filter-bar .genre-btn[data-genre="Action"]');

    await expect(page.locator('#trending-grid .genre-load-error')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#trending-grid .anime-card')).toHaveCount(0);

    // The page must stay interactive: navigating away and back still works.
    await clickNav(page, 'movies');
    await expect(page.locator('#page-movies')).toHaveClass(/active/, { timeout: 15000 });
    await expect(page.locator('#movies-grid .anime-card').first()).toBeVisible({ timeout: 15000 });
  });

  test('Stale request cannot overwrite newer results', async ({ page }) => {
    // The Action response is held until released, so it lands AFTER the newer
    // Drama response. The genreRequestId guard must discard it.
    let releaseAction;
    const actionHeld = new Promise(resolve => { releaseAction = resolve; });
    let markActionStarted;
    const actionStarted = new Promise(resolve => { markActionStarted = resolve; });

    await page.route('**/api/genre/Action', async route => {
      markActionStarted();
      await actionHeld;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([mockCard(900002, 'STALE ACTION TITLE')])
      });
    });
    await page.route('**/api/genre/Drama', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([mockCard(900003, 'FRESH DRAMA TITLE')])
    }));

    await page.click('#genre-filter-bar .genre-btn[data-genre="Action"]');
    await actionStarted; // the slow request is now in flight
    await page.click('#genre-filter-bar .genre-btn[data-genre="Drama"]');

    const grid = page.locator('#trending-grid');
    await expect(grid).toContainText('FRESH DRAMA TITLE', { timeout: 15000 });

    // Let the stale response arrive; it must be ignored.
    releaseAction();
    await page.waitForTimeout(700);
    await expect(grid).toContainText('FRESH DRAMA TITLE');
    await expect(grid).not.toContainText('STALE ACTION TITLE');
    await expect(page.locator('#trending-grid .anime-card')).toHaveCount(1);
  });
});
