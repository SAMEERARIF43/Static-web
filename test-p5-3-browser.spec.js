const { test, expect } = require('@playwright/test');

const MOCK_CARD = {
  id: 900101,
  anilistId: 900101,
  title: 'Browser Retry Fixture',
  poster: 'https://placehold.co/300x450',
  rating: 8,
  status: 'Finished',
  type: 'TV',
  episodes: 12
};

const WATCHLIST_ITEM = {
  id: 900201,
  title: 'Cloud Watchlist Fixture',
  poster: 'https://placehold.co/300x450',
  image: 'https://placehold.co/300x450',
  type: 'TV',
  episodes: 12,
  totalEpisodes: 12,
  currentEpisode: 3,
  watchStatus: 'watching'
};

async function blockExternalTraffic(page) {
  await page.route('**/*', route => {
    const { hostname } = new URL(route.request().url());
    if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
}

async function clickNav(page, nav) {
  const { width } = page.viewportSize();
  if (width < 901) {
    const links = page.locator('#nav-links');
    if (!(await links.evaluate(el => el.classList.contains('open')))) {
      await page.locator('#mobile-menu').click();
    }
  }
  await page.locator(`#nav-links [data-nav="${nav}"]`).click();
}

async function mockHomeAndPopular(page) {
  await page.route('**/api/trending', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([MOCK_CARD])
  }));
  await page.route('**/api/popular', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([MOCK_CARD])
  }));
  await page.route('**/api/movies', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([MOCK_CARD])
  }));
  await page.route('**/api/browse*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'X-Catalog-Has-Next': 'false', 'X-Catalog-Total': '1' },
    body: JSON.stringify([MOCK_CARD])
  }));
}

async function prepareSignedInPage(page) {
  await blockExternalTraffic(page);
  await page.route('**/api/config', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-anon-key' })
  }));
  await page.addInitScript(() => {
    const session = { user: { id: 'browser-test-user', email: 'browser@example.test' } };
    window.__browserAuthCallback = null;
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session }, error: null }),
          onAuthStateChange: callback => {
            window.__browserAuthCallback = callback;
            return { data: { subscription: { unsubscribe() {} } } };
          },
          signOut: async () => ({ error: null })
        }
      })
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.getAnimeHubAuthState?.().ready === true, null, { timeout: 15000 });
  await page.waitForFunction(() => window.getAnimeHubAuthState?.().session?.user?.id === 'browser-test-user', null, { timeout: 15000 });
}

test.describe('P5.3 dedicated browser coverage', () => {
  test('genre endpoint failure recovers on a real return to Popular', async ({ page }) => {
    await blockExternalTraffic(page);
    await mockHomeAndPopular(page);

    let genreRequests = 0;
    await page.route('**/api/genres', route => {
      genreRequests += 1;
      if (genreRequests === 1) return route.abort('failed');
      if (genreRequests === 2) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"fixture outage"}' });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(['Action', 'Mystery'])
      });
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clickNav(page, 'popular');

    const genreSelect = page.locator('#filter-genre');
    await expect(genreSelect.locator('option')).toHaveText('Genre list unavailable');
    await expect(genreSelect.locator('option')).toHaveAttribute('disabled', '');
    await expect(page.locator('#toast')).toContainText('Could not load the genre list. Genre chips still work.');
    await expect.poll(() => genreRequests).toBe(2);
    await expect(page.locator('#popular-genre-filter .genre-btn[data-genre="Action"]')).toBeVisible();

    await clickNav(page, 'home');
    await clickNav(page, 'popular');

    await expect.poll(() => genreRequests).toBe(3);
    await expect(genreSelect.locator('option')).toHaveCount(2);
    await expect(genreSelect.locator('option').nth(0)).toHaveText('Action');
    await expect(genreSelect.locator('option').nth(1)).toHaveText('Mystery');
    await expect(genreSelect.locator('option', { hasText: 'Genre list unavailable' })).toHaveCount(0);

    await page.selectOption('#filter-genre', 'Action');
    await expect(page).toHaveURL(/genre=Action/);
    await expect(page.locator('#popular-page-grid .anime-card').first()).toBeVisible({ timeout: 15000 });

    // A real reload exercises URL rehydration against the recovered options.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => genreRequests).toBe(4);
    await expect(page.locator('#filter-genre')).toHaveValues(['Action']);

    await clickNav(page, 'home');
    await clickNav(page, 'popular');
    await expect.poll(() => genreRequests).toBe(4);
    await expect(page.locator('#filter-genre option')).toHaveCount(2);
    await expect(page.locator('#filter-genre option', { hasText: 'Genre list unavailable' })).toHaveCount(0);
  });

  test('watchlist failure supports keyboard retry and successful recovery', async ({ page }) => {
    await prepareSignedInPage(page);

    await page.evaluate(() => {
      window.__watchlistFixtureCalls = 0;
      window.__watchlistFixtureRows = [];
      window.animeHubCloudWatchlist.list = async () => {
        window.__watchlistFixtureCalls += 1;
        if (window.__watchlistFixtureCalls === 1) throw new Error('fixture watchlist outage');
        await new Promise(resolve => { window.__releaseWatchlistFixture = resolve; });
        return window.__watchlistFixtureRows;
      };
    });

    await clickNav(page, 'watchlist');
    await expect(page.locator('#watchlist-grid .watch-progress-hint')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#watchlist-grid')).toContainText('Unable to load your watchlist. Please try again.');

    const retryButton = page.locator('#watchlist-grid').getByRole('button', { name: 'Try again' });
    await expect(retryButton).toBeVisible();
    await retryButton.focus();
    await expect(retryButton).toBeFocused();
    await expect(retryButton).toBeEnabled();

    await page.evaluate(item => { window.__WATCHLIST_ITEM_FIXTURE = item; }, WATCHLIST_ITEM);
    await page.evaluate(() => {
      window.__watchlistFixtureRows = [window.__WATCHLIST_ITEM_FIXTURE];
    });
    await retryButton.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__watchlistFixtureCalls)).toBe(2);
    // The existing load path replaces the error action with skeletons while
    // pending, which removes the control and prevents repeated activation.
    await expect(page.locator('#watchlist-grid').getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.locator('#watchlist-grid .skeleton-card').first()).toBeVisible();

    await page.evaluate(() => window.__releaseWatchlistFixture());
    await expect(page.locator('#watchlist-grid')).toContainText('Cloud Watchlist Fixture', { timeout: 15000 });
    await expect(page.locator('#watchlist-grid .watch-progress-hint')).toHaveCount(0);
    await expect(page.locator('#watchlist-grid .skeleton-card')).toHaveCount(0);
  });

  test('watchlist repeated failure keeps one retryable error state', async ({ page }) => {
    await prepareSignedInPage(page);

    await page.evaluate(() => {
      window.__watchlistFixtureCalls = 0;
      window.animeHubCloudWatchlist.list = async () => {
        window.__watchlistFixtureCalls += 1;
        throw new Error('fixture remains offline');
      };
    });

    await clickNav(page, 'watchlist');
    await expect(page.locator('#watchlist-grid .watch-progress-hint')).toBeVisible({ timeout: 15000 });
    const firstRetry = page.locator('#watchlist-grid').getByRole('button', { name: 'Try again' });
    await firstRetry.focus();
    await firstRetry.press('Enter');

    await expect.poll(() => page.evaluate(() => window.__watchlistFixtureCalls)).toBe(2);
    await expect(page.locator('#watchlist-grid .watch-progress-hint')).toHaveCount(1);
    await expect(page.locator('#watchlist-grid')).toContainText('Unable to load your watchlist. Please try again.');
    await expect(page.locator('#watchlist-grid').getByRole('button', { name: 'Try again' })).toBeEnabled();
    await expect(page.locator('#watchlist-grid .skeleton-card')).toHaveCount(0);

    await page.locator('#watchlist-grid').getByRole('button', { name: 'Try again' }).press('Enter');
    await expect.poll(() => page.evaluate(() => window.__watchlistFixtureCalls)).toBe(3);
    await expect(page.locator('#watchlist-grid .watch-progress-hint')).toHaveCount(1);
    await expect(page.locator('#watchlist-grid').getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  test('real sign-in flow reaches a failing cloud watchlist and recovers by keyboard retry', async ({ page }) => {
    await blockExternalTraffic(page);
    await page.route('**/api/config', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-anon-key' })
    }));

    const session = {
      access_token: 'browser-test-access-token',
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'browser@example.test',
        email_confirmed_at: '2026-01-01T00:00:00Z'
      }
    };
    await page.addInitScript(({ session, item }) => {
      window.__realAuthFixture = { listCalls: 0, signInCalls: 0 };
      window.__realAuthFixtureSession = session;
      window.__realAuthFixtureItem = item;
      window.__realAuthCallback = null;
      localStorage.setItem(`anime_hub_watchlist_${session.user.id}`, JSON.stringify([item]));

      const queryResult = () => ({
        data: [{
          anime_id: item.id,
          watch_status: item.watchStatus,
          current_episode: item.currentEpisode,
          total_episodes: item.totalEpisodes
        }],
        error: null
      });
      const queryBuilder = () => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          then: (resolve, reject) => {
            window.__realAuthFixture.listCalls += 1;
            const call = window.__realAuthFixture.listCalls;
            if (call <= 2) {
              return Promise.resolve({ data: null, error: new Error('fixture cloud outage') }).then(resolve, reject);
            }
            if (call === 3) {
              return new Promise(resolve => { window.__releaseRealCloudRetry = () => resolve(queryResult()); })
                .then(resolve, reject);
            }
            return Promise.resolve(queryResult()).then(resolve, reject);
          }
        };
        return builder;
      };

      window.supabase = {
        createClient: () => ({
          auth: {
            getSession: async () => ({ data: { session: null }, error: null }),
            onAuthStateChange: callback => {
              window.__realAuthCallback = callback;
              return { data: { subscription: { unsubscribe() {} } } };
            },
            signInWithPassword: async ({ email, password }) => {
              window.__realAuthFixture.signInCalls += 1;
              window.__realAuthFixture.credentials = { email, password };
              window.__realAuthCallback?.('SIGNED_IN', session);
              return { data: { session }, error: null };
            },
            signOut: async () => ({ error: null })
          },
          from: table => {
            if (table !== 'watchlist') throw new Error(`Unexpected table: ${table}`);
            return queryBuilder();
          }
        })
      };
    }, { session, item: WATCHLIST_ITEM });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.getAnimeHubAuthState?.().ready === true, null, { timeout: 15000 });
    if (page.viewportSize().width < 901) await page.locator('#mobile-menu').click();
    await page.locator('#nav-login').click();
    await expect(page.locator('#auth-modal')).toBeVisible();
    await expect(page.locator('#auth-title')).toHaveText('Log In');
    await page.locator('#auth-email').fill('browser@example.test');
    await page.locator('#auth-password').fill('correct-password');
    await page.locator('#auth-submit-btn').click();

    await expect.poll(() => page.evaluate(() => window.__realAuthFixture.signInCalls)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__realAuthFixture.credentials)).toEqual({
      email: 'browser@example.test',
      password: 'correct-password'
    });
    await expect(page.locator('#auth-modal')).toBeHidden();
    await expect(page.locator('#nav-login')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.getAnimeHubAuthState?.().session?.user?.id))
      .toBe(session.user.id);

    await clickNav(page, 'watchlist');
    await expect(page.locator('#page-watchlist')).toHaveClass(/active/);
    await expect.poll(() => page.evaluate(() => window.__realAuthFixture.listCalls)).toBe(2);
    await expect(page.locator('#watchlist-grid .watch-progress-hint')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#watchlist-grid')).toContainText('Unable to load your watchlist. Please try again.');
    await expect(page.locator('#watchlist-grid .watch-progress-hint')).toHaveCount(1);

    const retryButton = page.locator('#watchlist-grid').getByRole('button', { name: 'Try again' });
    await retryButton.focus();
    await expect(retryButton).toBeFocused();
    await retryButton.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__realAuthFixture.listCalls)).toBe(3);
    await expect(page.locator('#watchlist-grid').getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.locator('#watchlist-grid .skeleton-card').first()).toBeVisible();

    await page.evaluate(() => window.__releaseRealCloudRetry());
    await expect(page.locator('#watchlist-grid')).toContainText('Cloud Watchlist Fixture', { timeout: 15000 });
    await expect(page.locator('#watchlist-grid .watch-progress-hint')).toHaveCount(0);
    await expect(page.locator('#watchlist-grid .skeleton-card')).toHaveCount(0);
  });
});
