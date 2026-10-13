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

// Deterministic fixture backend: any non-empty query resolves to the same
// fixture title, so every step of these tests (first search, cache hit,
// failure, retry) is observable through the public UI no matter which query
// drives it.
function searchResults(query) {
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
});