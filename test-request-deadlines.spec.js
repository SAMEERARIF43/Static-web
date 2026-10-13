const { test, expect } = require('@playwright/test');

const detail = (id, title) => ({
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

test.describe('response-body request deadlines', () => {
  test('times out while response.json is stalled after headers', async ({ page }) => {
    await page.addInitScript(() => {
      window.__ANIME_HUB_REQUEST_TIMEOUTS = { detail: 75 };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname !== '/api/anime/99') return nativeFetch(input, init);

        const stream = new ReadableStream({
          start(controller) {
            // Headers and an incomplete JSON body arrive immediately. The
            // request deadline must still cover the pending body read.
            controller.enqueue(new TextEncoder().encode('{"id":99'));
            init.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('body deadline', 'AbortError'));
            }, { once: true });
          }
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      };
    });

    await page.goto('/?id=99', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#detail-content')).toContainText('Failed to load anime details.', { timeout: 2000 });
  });

  test('navigation cancellation does not show the cancelled detail error', async ({ page }) => {
    await page.addInitScript(({ newer }) => {
      window.__ANIME_HUB_REQUEST_TIMEOUTS = { detail: 500 };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname === '/api/anime/1') {
          return new Promise((resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
          });
        }
        if (url.pathname === '/api/anime/2') {
          return Promise.resolve(new Response(JSON.stringify(newer), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };
    }, { newer: detail(2, 'Newer Title') });

    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => {
      history.pushState({}, '', '?id=1');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForTimeout(25);
    await page.evaluate(() => {
      history.pushState({}, '', '?id=2');
      dispatchEvent(new PopStateEvent('popstate'));
    });

    await expect(page.locator('.detail-title')).toHaveText('Newer Title', { timeout: 2000 });
    await expect(page.locator('#detail-content')).not.toContainText('Failed to load anime details.');
  });
});
