const { test, expect } = require('@playwright/test');

/**
 * Minimal anime fixtures for episode selector tests.
 * Matches the shape expected by renderAnimeCard and the detail page.
 */
function animeFixture(id, title, episodes, type = 'TV') {
  return {
    id,
    anilistId: id,
    title: { english: title, romaji: title, native: title },
    coverImage: {
      extraLarge: `https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx${id}.jpg`,
      large: `https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx${id}.jpg`
    },
    bannerImage: `https://s4.anilist.co/file/anilistcdn/media/anime/banner/${id}.jpg`,
    description: `${title} is a test fixture.`,
    episodes: type === 'MOVIE' ? null : episodes,
    status: 'RELEASING',
    averageScore: 85,
    genres: ['Action'],
    season: 'WINTER',
    seasonYear: 2024,
    format: type,
    countryOfOrigin: 'JP',
    studios: { nodes: [{ name: 'Test Studio' }] },
    staff: { edges: [] },
    characters: { edges: [] },
    trailer: null,
    relations: { edges: [] },
    recommendations: { edges: [] }
  };
}

const ONE_PIECE_FIXTURE = animeFixture(21, 'ONE PIECE', 1100);
const JUJUTSU_FIXTURE = animeFixture(113415, 'Jujutsu Kaisen', 24);

/**
 * Mock search results for the two titles under test.
 */
function searchResults(query) {
  const q = query.toLowerCase();
  if (q.includes('one piece')) return [ONE_PIECE_FIXTURE];
  if (q.includes('jujutsu')) return [JUJUTSU_FIXTURE];
  return [];
}

test.describe('Episode Selector', () => {
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

    // Mock /api/search to return deterministic fixtures instantly.
    await page.route('**/api/search*', route => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('q') || '';
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchResults(query))
      });
    });

    // Mock /api/anime/:id for detail page loads.
    await page.route('**/api/anime/21', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONE_PIECE_FIXTURE) }));
    await page.route('**/api/anime/113415', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(JUJUTSU_FIXTURE) }));

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Add One Piece and Jujutsu Kaisen to watchlist via localStorage
    await page.evaluate(() => {
      const watchlist = [
        {
          id: 21,
          title: 'ONE PIECE',
          poster: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg',
          image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg',
          rating: 9.0,
          totalEpisodes: 1100,
          currentEpisode: 0,
          watchStatus: 'plan_to_watch'
        },
        {
          id: 113415,
          title: 'Jujutsu Kaisen',
          poster: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg',
          image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg',
          rating: 8.6,
          totalEpisodes: 24,
          currentEpisode: 0,
          watchStatus: 'plan_to_watch'
        }
      ];
      localStorage.setItem('anime_hub_watchlist', JSON.stringify(watchlist));
    });

    // Reload to re-initialize the module-level watchlist variable from localStorage
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  });

  // Below 901px the nav links live in an off-canvas drawer (script.js toggles
  // `#nav-links.open` from `#mobile-menu`), so `[data-nav]` resolves but is not
  // actionable until the hamburger opens it — on a desktop viewport the same
  // links sit inline. Opening the drawer explicitly keeps this one spec valid on
  // every viewport project instead of hanging for the whole test timeout.
  async function _clickNav(page, nav) {
    const { width } = page.viewportSize();
    if (width < 901) {
      const isOpen = await page.locator('#nav-links').evaluate(el => el.classList.contains('open'));
      if (!isOpen) await page.locator('#mobile-menu').click();
    }
    // Scoped to the nav: `[data-nav]` also appears on in-page CTA and
    // "View All" links, which a bare selector would match ambiguously.
    await page.locator(`#nav-links [data-nav="${nav}"]`).click();
  }

  test('One Piece episode selector shows correct total', async ({ page }) => {
    await page.fill('#hero-search-input', 'One Piece');
    await page.keyboard.press('Enter');

    await expect(page.locator('#page-search')).toHaveClass(/active/, { timeout: 30000 });
    await page.waitForSelector('#search-results-grid .anime-card', { timeout: 30000 });

    const firstCardTitle = page.locator('#search-results-grid .anime-card .card-title').first();
    await expect(firstCardTitle).toBeVisible({ timeout: 15000 });
    await firstCardTitle.click();

    await expect(page.locator('.detail-title')).toBeVisible({ timeout: 15000 });

    const episodeSelect = page.locator('[data-watch-episode]');
    await expect(episodeSelect).toBeVisible({ timeout: 15000 });

    const options = await episodeSelect.locator('option').all();
    const lastOption = options[options.length - 1];
    const lastValue = await lastOption.getAttribute('value');

    expect(parseInt(lastValue)).toBe(1100);
  });

  test('Jujutsu Kaisen episode selector search works', async ({ page }) => {
    await page.fill('#hero-search-input', 'Jujutsu Kaisen');
    await page.keyboard.press('Enter');

    await expect(page.locator('#page-search')).toHaveClass(/active/, { timeout: 30000 });
    await page.waitForSelector('#search-results-grid .anime-card', { timeout: 30000 });

    const firstCardTitle = page.locator('#search-results-grid .anime-card .card-title').first();
    await expect(firstCardTitle).toBeVisible({ timeout: 15000 });
    await firstCardTitle.click();

    await expect(page.locator('.detail-title')).toBeVisible({ timeout: 15000 });

    const searchBtn = page.locator('.episode-selector-search');
    await expect(searchBtn).toBeVisible({ timeout: 15000 });
    await searchBtn.click();

    const searchInput = page.locator('.episode-search-input');
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    await page.fill('.episode-search-input', '5');

    const visibleTexts = await page.locator('[data-watch-episode] option:not([style*="display: none"])').allTextContents();
    expect(visibleTexts.some(t => t.includes('5'))).toBeTruthy();
  });

  test('Escape closes episode search', async ({ page }) => {
    await page.fill('#hero-search-input', 'Jujutsu Kaisen');
    await page.keyboard.press('Enter');

    await expect(page.locator('#page-search')).toHaveClass(/active/, { timeout: 30000 });
    await page.waitForSelector('#search-results-grid .anime-card', { timeout: 30000 });

    const firstCardTitle = page.locator('#search-results-grid .anime-card .card-title').first();
    await expect(firstCardTitle).toBeVisible({ timeout: 15000 });
    await firstCardTitle.click();

    await expect(page.locator('.detail-title')).toBeVisible({ timeout: 15000 });

    const searchBtn = page.locator('.episode-selector-search');
    await expect(searchBtn).toBeVisible({ timeout: 15000 });
    await searchBtn.click();

    await page.keyboard.press('Escape');

    await expect(page.locator('.episode-search-input')).not.toBeVisible({ timeout: 10000 });
  });
});
