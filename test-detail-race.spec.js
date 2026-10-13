const { test, expect } = require('@playwright/test');

const fixture = (id, title) => ({
  id,
  title: { english: title, romaji: title, native: title },
  coverImage: { large: `https://example.test/${id}.jpg` },
  bannerImage: null,
  description: `${title} fixture`,
  episodes: 12,
  format: 'TV',
  status: 'FINISHED',
  averageScore: 80,
  genres: [],
  studios: { nodes: [] },
  staff: { edges: [] },
  characters: { edges: [] },
  relations: { edges: [] },
  recommendations: { edges: [] }
});

test.describe('Detail request race protection', () => {
  test('an older detail response cannot overwrite a newer title', async ({ page }) => {
    let releaseFirst;
    const firstResponse = new Promise(resolve => { releaseFirst = resolve; });

    await page.route('**/*', route => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      return route.abort();
    });
    await page.route('**/api/anime/1', async route => {
      await firstResponse;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture(1, 'Older Title')) });
    });
    await page.route('**/api/anime/2', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture(2, 'Newer Title')) }));

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => {
      history.pushState({}, '', '?id=1');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForRequest(request => request.url().endsWith('/api/anime/1'));

    await page.evaluate(() => {
      history.pushState({}, '', '?id=2');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.locator('.detail-title')).toHaveText('Newer Title', { timeout: 10000 });

    releaseFirst();
    await page.waitForTimeout(100);
    await expect(page.locator('.detail-title')).toHaveText('Newer Title');
  });
});
