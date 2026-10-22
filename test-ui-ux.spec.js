const { test, expect } = require('@playwright/test');

const anime = {
  id: 42,
  anilistId: 42,
  title: { romaji: 'Fixture Anime', english: 'Fixture Anime' },
  image: 'https://placehold.co/300x450',
  coverImage: { large: 'https://placehold.co/300x450' },
  bannerImage: 'https://placehold.co/1280x420',
  type: 'TV',
  format: 'TV',
  status: 'RELEASING',
  episodes: 12,
  averageScore: 84,
  genres: ['Action'],
};

const comic = {
  id: 'm-42',
  title: 'Fixture Manga',
  image: 'https://placehold.co/300x450',
  type: 'Manga',
  contentType: 'manga',
  category: 'manga',
  status: 'Ongoing',
  chapters: 40,
  rating: 8.7,
  genres: ['Fantasy'],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });

  await page.route('**/api/site-config', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));

  const apiFixtures = new Map([
    ['/api/config', { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' }],
    ['/api/trending', [anime]],
    ['/api/popular', [anime]],
    ['/api/movies', []],
    ['/api/series', [anime]],
    ['/api/genres', ['Action', 'Fantasy']],
    ['/api/manga', [comic]],
    ['/api/manhwa', []],
    ['/api/manhua', []],
  ]);

  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const body = apiFixtures.get(url.pathname) || (url.pathname === '/api/health' ? { ok: true } : []);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
});

test.describe('Anime Hub UI/UX regression coverage', () => {
  test('mobile navigation uses a dismissible scrim and locks page scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#nav-scrim')).toBeHidden();
    await page.locator('#mobile-menu').click();
    await expect(page.locator('#nav-links')).toHaveClass(/open/);
    await expect(page.locator('#nav-scrim')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/nav-open/);

    await page.keyboard.press('Escape');
    await expect(page.locator('#nav-links')).not.toHaveClass(/open/);
    await expect(page.locator('#nav-scrim')).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/nav-open/);
    await expect(page.locator('#mobile-menu')).toBeFocused();
  });

  test('comic search controls and cards remain usable without mobile overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/?page=manga', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#manga-grid .anime-card')).toHaveCount(1);
    await expect(page.locator('#manga-sort')).toBeVisible();

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    await expect(page.locator('#manga-grid .anime-card')).toBeVisible();
  });
});
