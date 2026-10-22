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

  test('detail navigation updates canonical metadata and renders hostile titles as text', async ({ page }) => {
    await page.route('**/*', route => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      return route.abort();
    });
    await page.route('**/api/anime/3', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...fixture(3, 'Quoted <em>Title</em>'),
          bannerImage: 'https://example.test/missing-banner.jpg'
        })
      }));

    await page.goto('/?id=3', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('.detail-title')).toHaveText('Quoted <em>Title</em>', { timeout: 15000 });
    await expect(page.locator('.detail-title em')).toHaveCount(0);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      'http://127.0.0.1:3100/?id=3'
    );
    const detailBanner = page.locator('.detail-banner img');
    await expect(detailBanner).toHaveAttribute('data-fallback-src', 'https://example.test/3.jpg');
    await expect(detailBanner).toHaveAttribute('src', 'https://example.test/3.jpg');
    await expect.poll(() => detailBanner.evaluate(element => element.hidden)).toBe(true);
  });

  test('recommendations render valid items and clear on the next detail', async ({ page }) => {
    const withRecommendation = {
      ...fixture(4, 'First Detail'),
      recommendations: {
        edges: [
          {
            node: {
              mediaRecommendation: {
                id: 44,
                title: { english: 'Recommended Title' },
                coverImage: { large: 'https://example.test/recommendation.jpg' },
                bannerImage: null,
                averageScore: 75,
                seasonYear: 2020,
                format: 'TV',
                status: 'FINISHED'
              }
            }
          },
          {
            node: {
              mediaRecommendation: {
                id: 45,
                title: { english: 'Unsafe <img src=x onerror=alert(1)>' },
                coverImage: null,
                bannerImage: 'https://example.test/banner-only.jpg',
                averageScore: 0,
                seasonYear: null,
                format: 'TV',
                status: 'RELEASING'
              }
            }
          },
          { node: { mediaRecommendation: null } }
        ]
      }
    };
    await page.route('**/*', route => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
      return route.abort();
    });
    await page.route('**/api/anime/4', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(withRecommendation) }));
    await page.route('**/api/anime/5', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture(5, 'Second Detail')) }));
    await page.goto('/?id=4', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('.detail-title')).toHaveText('First Detail', { timeout: 15000 });
    await expect(page.locator('.reco-section')).toHaveCount(1);
    await expect(page.locator('.reco-section .card-title')).toHaveCount(2);
    await expect(page.locator('.reco-section .card-title').nth(0)).toContainText('Recommended Title');
    await expect(page.locator('.reco-section .card-title').nth(1)).toContainText('<img src=x onerror=alert(1)>');
    await expect(page.locator('.reco-section .card-title img')).toHaveCount(0);

    await page.goto('/?id=5', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('.detail-title')).toHaveText('Second Detail', { timeout: 15000 });
    await expect(page.locator('.reco-section')).toHaveCount(0);
  });
});
