const { test, expect } = require('@playwright/test');

const items = {
  manga: [{ id: 'm-1', title: 'Witch Hat Atelier', image: 'https://placehold.co/300x450', type: 'Manga', rating: 9.1, status: 'Ongoing', chapters: 80, genres: ['Fantasy'] }],
  manhwa: [{ id: 'mw-1', title: 'Omniscient Reader', image: 'https://placehold.co/300x450', type: 'Manhwa', rating: 8.8, status: 'Ongoing', chapters: 220, genres: ['Action'] }],
  manhua: [{ id: 'mh-1', title: 'Heaven Official’s Blessing', image: 'https://placehold.co/300x450', type: 'Manhua', rating: 9.0, status: 'Completed', chapters: 100, genres: ['Drama'] }],
};

async function openNav(page, kind) {
  if ((page.viewportSize()?.width || 1280) < 901) await page.locator('#mobile-menu').click();
  await page.locator(`#nav-links [data-nav="${kind}"]`).click();
}

test.describe('Milestone 1 comic catalog surfaces', () => {
  let requestedSort;
  test.beforeEach(async ({ page }) => {
    requestedSort = null;
    await page.route('**/*', route => {
      const host = new URL(route.request().url()).hostname;
      return host === 'localhost' || host === '127.0.0.1' ? route.continue() : route.abort();
    });
    await page.route('**/api/site-config', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    for (const kind of Object.keys(items)) {
      await page.route(`**/api/${kind}**`, route => {
        const requestUrl = new URL(route.request().url());
        const q = requestUrl.searchParams.get('q');
        if (requestUrl.searchParams.get('sort') === 'trending') requestedSort = 'trending';
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(q && q.toLowerCase().includes('missing') ? [] : items[kind]) });
      });
      await page.route(`**/api/${kind}/**`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items[kind][0]) }));
    }
  });

  test('discovers each category, searches, and opens an isolated detail surface', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    for (const [kind, item] of Object.entries(items)) {
      await openNav(page, kind);
      await expect(page.locator(`#page-${kind}`)).toHaveClass(/active/);
      await expect(page.locator(`#${kind}-grid .anime-card`)).toHaveCount(1);
      await expect(page.locator(`#${kind}-grid .card-title`)).toHaveText(item[0].title);
      await page.locator(`#${kind}-sort`).selectOption('trending');
      await page.locator(`#${kind}-search`).fill(item[0].title);
      await page.locator(`#page-${kind} .comic-search-form`).evaluate(form => form.requestSubmit());
      await expect(page).toHaveURL(new RegExp(`page=${kind}.*comicSearch=`));
      await expect(page).toHaveURL(new RegExp('comicSort=trending'));
      expect(requestedSort).toBe('trending');
      await expect(page.locator(`#${kind}-grid .anime-card`)).toBeVisible();
      await page.locator(`#${kind}-grid .anime-card`).click();
      await expect(page.locator('#page-comic-detail')).toHaveClass(/active/);
      await expect(page.locator('.comic-detail-label')).toHaveText(kind === 'manga' ? 'Manga' : kind === 'manhwa' ? 'Manhwa' : 'Manhua');
      await expect(page.locator('.detail-title')).toHaveText(item[0].title);
    }
  });

  test('back from detail restores committed query, sort, URL, and request state', async ({ page }) => {
    const requests = [];
    await page.unroute('**/api/manga**');
    await page.route('**/api/manga**', route => {
      const url = new URL(route.request().url());
      requests.push({ page: url.searchParams.get('page'), query: url.searchParams.get('q') || '', sort: url.searchParams.get('sort') });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items.manga) });
    });
    await page.goto('/?page=manga', { waitUntil: 'domcontentloaded' });
    await page.locator('#manga-sort').selectOption('trending');
    await page.locator('#manga-search').fill('committed title');
    await page.locator('#manga-search').press('Enter');
    await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ page: 'manga', comicSearch: 'committed title', comicSort: 'trending' });
    await page.locator('#manga-grid .anime-card').click();
    await page.locator('#comic-detail-back').click();
    await expect.poll(() => Object.fromEntries(new URL(page.url()).searchParams)).toMatchObject({ page: 'manga', comicSearch: 'committed title', comicSort: 'trending' });
    await expect(page.locator('#manga-search')).toHaveValue('committed title');
    await expect(page.locator('#manga-sort')).toHaveValue('trending');
    await expect.poll(() => requests.at(-1)).toEqual({ page: '1', query: 'committed title', sort: 'trending' });
  });

  test('renders a truthful empty state for a no-result search', async ({ page }) => {
    await page.goto('/?page=manga', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#manga-grid .anime-card')).toBeVisible();
    await page.locator('#manga-search').fill('missing title');
    await page.locator('#manga-search').press('Enter');
    await expect(page.locator('#manga-empty')).toBeVisible();
    await expect(page.locator('#manga-result-status')).toContainText('No manga titles found');
  });

  test('shows an error and retries a failed catalog request', async ({ page }) => {
    let attempts = 0;
    await page.unroute('**/api/manhua**');
    await page.route('**/api/manhua**', route => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items.manhua) });
    });
    await page.goto('/?page=manhua', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#manhua-error')).toBeVisible();
    await page.locator('[data-comic-retry="manhua"]').click();
    await expect(page.locator('#manhua-grid .anime-card')).toBeVisible();
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test('load more removes duplicate card IDs', async ({ page }) => {
    let pageNumber = 0;
    const requestedPages = [];
    await page.unroute('**/api/manga**');
    await page.route('**/api/manga**', route => {
      pageNumber += 1;
      requestedPages.push(new URL(route.request().url()).searchParams.get('page'));
      const body = pageNumber === 1 ? items.manga : [...items.manga, { ...items.manga[0], title: 'Duplicate' }, { ...items.manga[0], title: 'Duplicate again' }];
      return route.fulfill({ status: 200, headers: { 'X-Content-Has-Next': pageNumber === 1 ? 'true' : 'false' }, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/?page=manga', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-comic-more="manga"]').click();
    await expect(page.locator('#manga-grid .anime-card')).toHaveCount(1);
    expect(requestedPages).toEqual(['1', '2']);
  });

  test('deduplicates duplicate IDs within the initial response', async ({ page }) => {
    await page.unroute('**/api/manga**');
    await page.route('**/api/manga**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([items.manga[0], { ...items.manga[0], title: 'Duplicate initial title' }])
    }));
    await page.goto('/?page=manga', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#manga-grid .anime-card')).toHaveCount(1);
  });

  test('repeated load-more clicks fetch only once and keep the submitted query', async ({ page }) => {
    let pageNumber = 0;
    const requestedQueries = [];
    const requestedPages = [];
    await page.unroute('**/api/manga**');
    await page.route('**/api/manga**', async route => {
      pageNumber += 1;
      const requestUrl = new URL(route.request().url());
      requestedQueries.push(requestUrl.searchParams.get('q') || '');
      requestedPages.push(requestUrl.searchParams.get('page'));
      if (pageNumber === 1) {
        return route.fulfill({ status: 200, headers: { 'X-Content-Has-Next': 'true' }, contentType: 'application/json', body: JSON.stringify(items.manga) });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      return route.fulfill({ status: 200, headers: { 'X-Content-Has-Next': 'false' }, contentType: 'application/json', body: JSON.stringify([]) });
    });

    await page.goto('/?page=manga', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-comic-more="manga"]')).toBeVisible();
    await page.locator('#manga-search').fill('submitted title');
    const more = page.locator('[data-comic-more="manga"]');
    await Promise.all([more.click(), more.click()]);
    await page.waitForTimeout(250);
    expect(pageNumber).toBe(2);
    expect(requestedQueries).toEqual(['', '']);
    expect(requestedPages).toEqual(['1', '2']);
  });

  test('failed load-more retries the same page before advancing', async ({ page }) => {
    const requestedPages = [];
    let pageTwoAttempts = 0;
    await page.unroute('**/api/manga**');
    await page.route('**/api/manga**', async route => {
      const url = new URL(route.request().url());
      const requestedPage = url.searchParams.get('page');
      requestedPages.push(requestedPage);
      if (requestedPage === '1') {
        return route.fulfill({ status: 200, headers: { 'X-Content-Has-Next': 'true' }, contentType: 'application/json', body: JSON.stringify(items.manga) });
      }
      if (requestedPage === '2' && pageTwoAttempts++ < 1) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      }
      if (requestedPage === '2') {
        return route.fulfill({ status: 200, headers: { 'X-Content-Has-Next': 'false' }, contentType: 'application/json', body: JSON.stringify([{ id: 'm-2', title: 'Page Two', image: 'https://placehold.co/300x450', type: 'Manga' }]) });
      }
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/?page=manga', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-comic-more="manga"]').click();
    await expect(page.locator('#manga-error')).toBeVisible();
    await page.locator('[data-comic-retry="manga"]').click();
    await expect(page.locator('#manga-grid .anime-card')).toHaveCount(2);
    expect(requestedPages).toEqual(['1', '2', '2']);
    expect(requestedPages).not.toContain('3');
  });

  test('ignores a delayed comic detail after navigating away', async ({ page }) => {
    let releaseDetail;
    const detailReleased = new Promise(resolve => { releaseDetail = resolve; });
    await page.route('**/api/manga/m-1', async route => {
      await detailReleased;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items.manga[0]) });
    });

    await page.goto('/?page=manga', { waitUntil: 'domcontentloaded' });
    await page.locator('#manga-grid .anime-card').click();
    await openNav(page, 'home');
    releaseDetail();
    await page.waitForTimeout(100);
    await expect(page.locator('#page-home')).toHaveClass(/active/);
    await expect(page.locator('.detail-title')).toHaveCount(0);
  });
});
