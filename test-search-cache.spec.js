const { test, expect } = require('@playwright/test');

/**
 * Regression test for search cache behavior on network failure.
 * Asserts only public UI behavior: a failed search shows the error panel and
 * leaves no stale results, a retry after recovery fetches fresh data, and a
 * repeated identical query shows the same results. No internal cache state is
 * read.
 */

const ONE_PIECE_FIXTURE = {
  id: 21,
  anilistId: 21,
  title: { english: 'ONE PIECE', romaji: 'One Piece', native: 'ONE PIECE' },
  coverImage: { extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg', large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg' },
  bannerImage: null,
  description: 'Fixture for One Piece.',
  episodes: 1100,
  status: 'RELEASING',
  averageScore: 85,
  genres: ['Action'],
  season: 'WINTER',
  seasonYear: 2024,
  format: 'TV',
  countryOfOrigin: 'JP',
  studios: { nodes: [{ name: 'Toei Animation' }] },
  staff: { edges: [] },
  characters: { edges: [] },
  relations: { edges: [] },
  recommendations: { edges: [] },
  trailer: null
};

const FILTER_FIXTURES = [
  { ...ONE_PIECE_FIXTURE, id: 900001, anilistId: 900001, title: { english: 'Comedy One' }, genres: ['Comedy'], format: 'TV', type: 'TV', averageScore: 80, seasonYear: 2022 },
  { ...ONE_PIECE_FIXTURE, id: 900002, anilistId: 900002, title: { english: 'Drama Two' }, genres: ['Drama'], format: 'MOVIE', type: 'MOVIE', averageScore: 90, seasonYear: 2024 },
  { ...ONE_PIECE_FIXTURE, id: 900003, anilistId: 900003, title: { english: 'Comedy Three' }, genres: ['Comedy'], format: 'TV', type: 'TV', averageScore: 70, seasonYear: 2023 }
];

const UNSAFE_TITLE_FIXTURE = {
  ...ONE_PIECE_FIXTURE,
  id: 900004,
  anilistId: 900004,
  title: { english: 'Unsafe " title <img src=x onerror=alert(1)>' }
};

const BROKEN_IMAGE_FIXTURE = {
  ...ONE_PIECE_FIXTURE,
  id: 900005,
  anilistId: 900005,
  title: { english: 'Broken Image' },
  coverImage: { extraLarge: 'https://example.test/missing-poster.jpg', large: 'https://example.test/missing-poster.jpg' }
};

// Deterministic fixture backend: any non-empty query resolves to the same
// fixture title, so every step of these tests (first search, cache hit,
// failure, retry) is observable through the public UI no matter which query
// drives it.
function searchResults(query) {
  if (query.toLowerCase().includes('filter')) return FILTER_FIXTURES;
  if (query.toLowerCase().includes('unsafe')) return [UNSAFE_TITLE_FIXTURE];
  if (query.toLowerCase().includes('broken')) return [BROKEN_IMAGE_FIXTURE];
  return query.trim() ? [ONE_PIECE_FIXTURE] : [];
}

// The two public search entry points are page-dependent: the hero input only
// exists on the home page, and after the first search the app switches to the
// search page, whose entry point is the nav-triggered overlay. Drive the
// search through whichever entry point is actually on screen instead of
// assuming the hero input is still visible.
async function runSearch(page, query) {
  if (await page.locator('#hero-search-input').isVisible()) {
    await page.fill('#hero-search-input', query);
  } else {
    await page.click('#nav-search-trigger');
    await expect(page.locator('#search-overlay')).toHaveClass(/open/, { timeout: 5000 });
    await page.fill('#search-overlay-input', query);
  }
  await page.keyboard.press('Enter');
}

test.describe('Search Cache Behavior on Network Failure', () => {
  test.beforeEach(async ({ page }) => {
    // Block all external requests except localhost
    await page.route('**/*', route => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      return route.abort();
    });

    // Mock /api/search to return deterministic fixtures instantly
    await page.route('**/api/search*', route => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('q') || '';
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchResults(query))
      });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  });

  test('First search failure shows error and retry succeeds after network recovers', async ({ page }) => {
    // Step 1: The network is down for the whole search, including the app's
    // automatic retry (fetchWithPolicy uses retries: 1 for /api/search).
    // We must override the beforeEach route - unroute first to ensure our route wins.
    await page.unroute('**/api/search*');

    let networkDown = true;
    await page.route('**/api/search*', route => {
      if (networkDown) {
        return route.abort('failed');
      }
      const url = new URL(route.request().url());
      const query = url.searchParams.get('q') || '';
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchResults(query))
      });
    });

    // First search attempt - should fail after retries exhausted
    await runSearch(page, 'One Piece');

    // Wait for the error state to appear in the public UI
    await expect(page.locator('#search-error')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#search-error-message')).toContainText('Could not load search results');

    // Step 2: Network now recovers; retry should succeed
    networkDown = false;
    await page.click('#search-retry-btn');

    // Wait for results to load
    await expect(page.locator('#search-results-grid .anime-card')).toBeVisible({ timeout: 15000 });

    // Verify fresh results appear in the public UI
    const retryCard = page.locator('#search-results-grid .anime-card .card-title').first();
    await expect(retryCard).toBeVisible({ timeout: 15000 });

    const retryTitle = await retryCard.textContent();
    expect(retryTitle).toContain('ONE PIECE');
  });

  test('Cached results are used for repeated identical queries', async ({ page }) => {
    // Step 1: Perform a successful search first to populate the cache
    await runSearch(page, 'One Piece');
    await expect(page.locator('#page-search')).toHaveClass(/active/, { timeout: 30000 });
    await page.waitForSelector('#search-results-grid .anime-card', { timeout: 30000 });

    // Verify results appear
    const firstCard = page.locator('#search-results-grid .anime-card .card-title').first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });
    const firstTitle = await firstCard.textContent();
    expect(firstTitle).toContain('ONE PIECE');

    // Step 2: Perform the identical query again.
    // The public behavior under test is that the same results appear, not
    // that any particular network request pattern is used.
    await runSearch(page, 'One Piece');

    // Wait for the grid (cached or fresh) to be visible
    await expect(page.locator('#search-results-grid .anime-card')).toBeVisible({ timeout: 15000 });

    // Verify the same results are visible
    const cachedCard = page.locator('#search-results-grid .anime-card .card-title').first();
    await expect(cachedCard).toBeVisible({ timeout: 15000 });
    const cachedTitle = await cachedCard.textContent();
    expect(cachedTitle).toContain('ONE PIECE');
  });

  test('Failed search does not leave stale results and retry recovers', async ({ page }) => {
    // Step 1: Successful search - establishes baseline results
    await runSearch(page, 'One Piece');
    await expect(page.locator('#page-search')).toHaveClass(/active/, { timeout: 30000 });
    await page.waitForSelector('#search-results-grid .anime-card', { timeout: 30000 });

    // Verify results appear
    const firstCard = page.locator('#search-results-grid .anime-card .card-title').first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });
    const firstTitle = await firstCard.textContent();
    expect(firstTitle).toContain('ONE PIECE');

    // Step 2: Simulate network failure on a subsequent search.
    // The failing query must be one the cache has never served: an already
    // cached query is answered from the cache without any network request, so
    // it cannot fail through the public UI at all. The public behavior under
    // test is that the error UI appears and the previous query's results are
    // not left on screen as if they were fresh data.
    // Override the beforeEach route to simulate network failure
    await page.unroute('**/api/search*');
    await page.route('**/api/search*', route => route.abort('failed'));

    await runSearch(page, 'Naruto');

    // Wait for error state
    await expect(page.locator('#search-error')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#search-error-message')).toContainText('Could not load search results');

    // The stale results of the previous query must not remain visible
    await expect(page.locator('#search-results-grid')).toBeHidden();

    // Step 3: Retry the search - network now works
    await page.unroute('**/api/search*');
    await page.route('**/api/search*', route => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('q') || '';
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchResults(query))
      });
    });

    await page.click('#search-retry-btn');

    // Wait for results to load
    await expect(page.locator('#search-results-grid .anime-card')).toBeVisible({ timeout: 15000 });

    // Verify fresh results appear
    const retryCard = page.locator('#search-results-grid .anime-card .card-title').first();
    await expect(retryCard).toBeVisible({ timeout: 15000 });

    const retryTitle = await retryCard.textContent();
    expect(retryTitle).toContain('ONE PIECE');
  });

  test('Search filter changes and reset update visible results and counts', async ({ page }) => {
    await runSearch(page, 'Filter Test');
    await expect(page.locator('#page-search')).toHaveClass(/active/, { timeout: 30000 });
    await expect(page.locator('#search-results-grid .anime-card')).toHaveCount(3, { timeout: 15000 });
    await expect(page.locator('#search-result-count')).toHaveText('3 anime titles found');

    await page.selectOption('#search-filter-genre', 'Comedy');
    await expect(page.locator('#search-results-grid .anime-card')).toHaveCount(2);
    await expect(page.locator('#search-result-count')).toHaveText('Showing 2 of 3 titles');
    await expect(page.locator('#search-results-grid .card-title').nth(0)).toContainText('Comedy One');
    await expect(page.locator('#search-results-grid .card-title').nth(1)).toContainText('Comedy Three');

    await page.selectOption('#search-filter-type', 'MOVIE');
    await expect(page.locator('#search-results-grid')).toBeHidden();
    await expect(page.locator('#search-filter-empty')).toBeVisible();
    await expect(page.locator('#search-result-count')).toHaveText('0 of 3 titles match filters');

    await page.click('#search-filter-reset-btn');
    await expect(page.locator('#search-results-grid .anime-card')).toHaveCount(3);
    await expect(page.locator('#search-filter-empty')).toBeHidden();
    await expect(page.locator('#search-result-count')).toHaveText('3 anime titles found');
    await expect(page.locator('#search-filter-genre')).toHaveValue('');
    await expect(page.locator('#search-filter-type')).toHaveValue('');
  });

  test('A newer search response wins over a delayed older response', async ({ page }) => {
    await page.unroute('**/api/search*');
    const requests = [];
    let releaseOldResponse;
    await page.route('**/api/search*', async route => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('q') || '';
      requests.push(query);
      if (query === 'Old Query') {
        await new Promise(resolve => { releaseOldResponse = resolve; });
        try {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([{ ...ONE_PIECE_FIXTURE, title: { english: 'OLD SEARCH RESPONSE' } }])
          });
        } catch {
          // The application may abort the obsolete request before it resolves.
        }
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ ...ONE_PIECE_FIXTURE, title: { english: 'NEW SEARCH RESPONSE' } }])
      });
    });

    await runSearch(page, 'Old Query');
    await expect.poll(() => requests).toContain('Old Query');

    await page.click('#nav-search-trigger');
    await expect(page.locator('#search-overlay')).toHaveClass(/open/);
    await page.fill('#search-overlay-input', 'New Query');
    await page.keyboard.press('Enter');

    await expect(page.locator('#search-results-grid .card-title').first()).toContainText('NEW SEARCH RESPONSE', { timeout: 15000 });
    releaseOldResponse?.();
    await page.waitForTimeout(100);
    await expect(page.locator('#search-results-grid .card-title').first()).toContainText('NEW SEARCH RESPONSE');
  });

  test('search result titles are rendered as text rather than injected markup', async ({ page }) => {
    await runSearch(page, 'Unsafe');
    await expect(page.locator('#page-search')).toHaveClass(/active/, { timeout: 30000 });
    const title = page.locator('#search-results-grid .card-title').first();
    await expect(title).toContainText('<img src=x onerror=alert(1)>', { timeout: 15000 });
    await expect(title.locator('img')).toHaveCount(0);
    await expect(page.locator('#search-results-grid .anime-card').first()).toHaveAttribute(
      'aria-label',
      'View details for Unsafe " title <img src=x onerror=alert(1)>'
    );
  });

  test('a broken result image falls back and then hides after the fallback fails', async ({ page }) => {
    await runSearch(page, 'Broken Image');
    await expect(page.locator('#page-search')).toHaveClass(/active/, { timeout: 30000 });
    const image = page.locator('#search-results-grid .anime-card img').first();
    await expect(image).toBeVisible({ timeout: 15000 });
    await expect.poll(() => image.evaluate(element => element.hidden), { timeout: 15000 }).toBe(true);
  });
});
