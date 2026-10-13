const { test, expect } = require('@playwright/test');

function mockItem(id, title, format = 'TV', countryOfOrigin = 'JP') {
  return {
    id,
    anilistId: id,
    title: { english: title, romaji: title, native: title },
    poster: 'https://placehold.co/300x450',
    coverImage: { large: 'https://placehold.co/300x450', extraLarge: 'https://placehold.co/300x450' },
    bannerImage: null,
    rating: 8.5,
    status: 'Completed',
    type: format,
    format: format,
    countryOfOrigin,
    episodes: format === 'MOVIE' ? 1 : 12,
    genres: ['Action', 'Fantasy'],
    description: `${title} description.`
  };
}

async function clickNav(page, nav) {
  const { width } = page.viewportSize();
  if (width < 901) {
    const isOpen = await page.locator('#nav-links').evaluate(el => el.classList.contains('open'));
    if (!isOpen) await page.locator('#mobile-menu').click();
  }
  await page.locator(`#nav-links [data-nav="${nav}"]`).click();
}

test.describe('Chinese Animation (Donghua) Compatibility Journeys', () => {
  const CN_MOVIE = mockItem(900050, 'Ne Zha', 'MOVIE', 'CN');
  const CN_SERIES = mockItem(900051, 'The Kings Avatar', 'TV', 'CN');
  const JP_MOVIE = mockItem(900023, 'One Piece Film: Red', 'MOVIE', 'JP');
  const JP_SERIES = mockItem(900021, 'One Piece', 'TV', 'JP');
  const UNKNOWN_ORIGIN = mockItem(900052, 'Unknown Origin Title', 'TV', null);

  test.beforeEach(async ({ page }) => {
    // Hermetic: abort external network calls so test runs deterministically offline
    await page.route('**/*', route => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      return route.abort();
    });

    // Mock API endpoints
    await page.route('**/api/trending', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CN_SERIES, JP_SERIES]) })
    );

    await page.route('**/api/popular', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CN_MOVIE, CN_SERIES, JP_SERIES, JP_MOVIE]) })
    );

    // The Popular *page* (page-popular / #popular-page-grid) uses /api/browse,
    // not /api/popular.  Supply pagination headers the client reads.
    await page.route('**/api/browse**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'X-Catalog-Has-Next': 'false',
          'X-Catalog-Total': '4',
          'X-Catalog-Page': '1',
          'X-Catalog-Per-Page': '20',
          'X-Catalog-Total-Pages': '1',
          'X-Catalog-Source': 'mock',
        },
        body: JSON.stringify([CN_MOVIE, CN_SERIES, JP_SERIES, JP_MOVIE]),
      })
    );

    await page.route('**/api/movies', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CN_MOVIE, JP_MOVIE]) })
    );

    await page.route('**/api/series', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CN_SERIES, JP_SERIES]) })
    );

    await page.route('**/api/search?**', route => {
      const url = new URL(route.request().url());
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (q.includes('ne zha')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CN_MOVIE]) });
      }
      if (q.includes('avatar') || q.includes('king')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([CN_SERIES]) });
      }
      if (q.includes('piece')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([JP_SERIES, JP_MOVIE]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
    });

    await page.route('**/api/anime/900050', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CN_MOVIE) })
    );
    await page.route('**/api/anime/900051', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CN_SERIES) })
    );
    await page.route('**/api/anime/900021', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(JP_SERIES) })
    );
    await page.route('**/api/anime/900052', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(UNKNOWN_ORIGIN) })
    );
  });

  test('Journey 1 — Search: returns Chinese-origin titles and navigates to detail page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Open search overlay
    await page.locator('#nav-search-trigger').click();
    await expect(page.locator('#search-overlay')).toBeVisible();

    const searchInput = page.locator('#search-overlay-input');
    await searchInput.fill('Ne Zha');
    await searchInput.press('Enter');

    // Search results page should be active and display the result card
    await expect(page.locator('#page-search')).toHaveClass(/active/);
    const resultCard = page.locator('#search-results-grid .anime-card[data-id="900050"]');
    await expect(resultCard).toBeVisible({ timeout: 10000 });
    await expect(resultCard.locator('.card-title')).toHaveText('Ne Zha');

    // Click card to open detail page
    await resultCard.click();
    await expect(page.locator('#page-detail')).toHaveClass(/active/);
    await expect(page.locator('.detail-title')).toHaveText('Ne Zha');
    await expect(page.locator('.detail-meta-row')).toContainText('Format: MOVIE');
    await expect(page.locator('.detail-facts')).toContainText('Country of origin');
    await expect(page.locator('.detail-facts')).toContainText('China');
  });

  test('Journey 2 — Popular: Chinese-origin titles appear alongside Japanese anime', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickNav(page, 'popular');

    await expect(page.locator('#page-popular')).toHaveClass(/active/);
    const popularGrid = page.locator('#popular-page-grid');
    await expect(popularGrid).toBeVisible();

    // Both Chinese and Japanese titles appear
    await expect(popularGrid.locator('.anime-card[data-id="900050"]')).toBeVisible();
    await expect(popularGrid.locator('.anime-card[data-id="900051"]')).toBeVisible();
    await expect(popularGrid.locator('.anime-card[data-id="900021"]')).toBeVisible();
  });

  test('Journey 3 — Movies: Chinese animated movies appear without TV series leaking in', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickNav(page, 'movies');

    await expect(page.locator('#page-movies')).toHaveClass(/active/);
    const moviesGrid = page.locator('#movies-grid');
    await expect(moviesGrid).toBeVisible();

    // Chinese animated movie appears
    await expect(moviesGrid.locator('.anime-card[data-id="900050"] .card-title')).toHaveText('Ne Zha');
    // Japanese animated movie control appears
    await expect(moviesGrid.locator('.anime-card[data-id="900023"] .card-title')).toHaveText('One Piece Film: Red');

    // TV series (Chinese or Japanese) must not appear in the movies catalog
    await expect(moviesGrid.locator('.anime-card[data-id="900051"]')).toHaveCount(0);
    await expect(moviesGrid.locator('.anime-card[data-id="900021"]')).toHaveCount(0);
  });

  test('Journey 4 — Series: Chinese animated series appear without movies leaking in', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickNav(page, 'series');

    await expect(page.locator('#page-series')).toHaveClass(/active/);
    const seriesGrid = page.locator('#series-grid');
    await expect(seriesGrid).toBeVisible();

    // Chinese animated series appears
    await expect(seriesGrid.locator('.anime-card[data-id="900051"] .card-title')).toHaveText('The Kings Avatar');
    // Japanese animated series control appears
    await expect(seriesGrid.locator('.anime-card[data-id="900021"] .card-title')).toHaveText('One Piece');

    // Movies (Chinese or Japanese) must not appear in the series catalog
    await expect(seriesGrid.locator('.anime-card[data-id="900050"]')).toHaveCount(0);
    await expect(seriesGrid.locator('.anime-card[data-id="900023"]')).toHaveCount(0);
  });

  test('Journey 5 — Detail pages: Chinese titles, Japanese controls, and missing metadata', async ({ page }) => {
    // Chinese animated movie detail
    await page.goto('/?id=900050', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#page-detail')).toHaveClass(/active/);
    await expect(page.locator('.detail-title')).toHaveText('Ne Zha');
    await expect(page.locator('.detail-meta-row')).toContainText('Format: MOVIE');
    await expect(page.locator('.detail-facts')).toContainText('Country of origin');
    await expect(page.locator('.detail-facts')).toContainText('China');

    // Chinese animated series detail
    await page.goto('/?id=900051', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#page-detail')).toHaveClass(/active/);
    await expect(page.locator('.detail-title')).toHaveText('The Kings Avatar');
    await expect(page.locator('.detail-meta-row')).toContainText('Format: TV');
    await expect(page.locator('.detail-facts')).toContainText('China');

    // Japanese series regression control
    await page.goto('/?id=900021', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#page-detail')).toHaveClass(/active/);
    await expect(page.locator('.detail-title')).toHaveText('One Piece');
    await expect(page.locator('.detail-facts')).toContainText('Japan');

    // Missing / unknown country of origin safely handled
    await page.goto('/?id=900052', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#page-detail')).toHaveClass(/active/);
    await expect(page.locator('.detail-title')).toHaveText('Unknown Origin Title');
    await expect(page.locator('.detail-facts')).toContainText('Country of origin');
    await expect(page.locator('.detail-facts')).toContainText('Not listed');
  });
});
