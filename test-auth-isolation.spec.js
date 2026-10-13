const { test, expect } = require('@playwright/test');

const WATCHLIST_KEY = 'anime_hub_watchlist';

// Below 901px the nav links live in an off-canvas drawer (script.js toggles
// `#nav-links.open` from `#mobile-menu`), so `[data-nav]` resolves but is not
// actionable until the hamburger opens it — on a desktop viewport the same
// links sit inline. Opening the drawer explicitly keeps this one spec valid on
// every viewport project instead of hanging for the whole test timeout.
async function clickNav(page, nav) {
  const { width } = page.viewportSize();
  if (width < 901) {
    const isOpen = await page.locator('#nav-links').evaluate(el => el.classList.contains('open'));
    if (!isOpen) await page.locator('#mobile-menu').click();
  }
  // Scoped to the nav: `[data-nav]` also appears on in-page CTA and
  // "View All" links, which a bare selector would match ambiguously.
  await page.locator(`#nav-links [data-nav="${nav}"]`).click();
}

async function prepareAuthMocks(page) {
  await page.route('**/*', route => {
    const { hostname } = new URL(route.request().url());
    if (hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    return route.abort();
  });
  await page.route('**/api/config', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-anon-key' })
  }));
  await page.route('**/api/account', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'Your account has been deleted.' })
  }));
  await page.addInitScript(() => {
    window.confirm = () => false;
    window.alert = () => {};
    window.__authCallback = null;
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          // Supabase onAuthStateChange takes a single callback argument, not (_event, callback)
          onAuthStateChange: (callback) => {
            window.__authCallback = callback;
            // Invoke immediately with initial session like real Supabase
            callback('INITIAL_SESSION', null);
            return { data: { subscription: { unsubscribe() {} } } };
          },
          signOut: async () => ({ error: null })
        }
      })
    };
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__authCallback === 'function', null, { timeout: 15000 });
}

test.describe('Authentication isolation', () => {
  test('a delayed cloud response cannot overwrite guest state after logout', async ({ page }) => {
    await prepareAuthMocks(page);
    await page.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [WATCHLIST_KEY, [
      { id: 21, title: 'Guest title', type: 'TV', episodes: 12, currentEpisode: 2, watchStatus: 'watching' }
    ]]);
    await clickNav(page, 'watchlist');
    await expect(page.locator('#page-watchlist')).toHaveClass(/active/, { timeout: 15000 });

    await page.evaluate(() => {
      window.confirm = () => false;
      window.animeHubCloudWatchlist.list = () => new Promise(resolve => {
        window.__cloudRequested = true;
        window.__releaseCloud = () => resolve([
          { id: 999, title: 'Previous account title', type: 'TV', episodes: 12, currentEpisode: 1, watchStatus: 'watching' }
        ]);
      });
      window.__authCallback('SIGNED_IN', { user: { id: 'user-a', email: 'a@example.test' } });
    });
    await expect.poll(() => page.evaluate(() => Boolean(window.__cloudRequested))).toBe(true);

    await page.evaluate(() => window.__authCallback('SIGNED_OUT', null));
    await page.evaluate(() => window.__releaseCloud());

    await expect(page.locator('#watchlist-grid')).not.toContainText('Previous account title');
    await expect(page.locator('#watchlist-grid')).toContainText('Guest title');
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)), WATCHLIST_KEY))
      .toEqual([{ id: 21, title: 'Guest title', type: 'TV', episodes: 12, currentEpisode: 2, watchStatus: 'watching' }]);
  });

  test('account deletion preserves the shared guest watchlist', async ({ page }) => {
    await prepareAuthMocks(page);
    const guestItems = [{ id: 21, title: 'Guest title', type: 'TV', episodes: 12, currentEpisode: 2, watchStatus: 'watching' }];
    await page.evaluate(([key, value]) => {
      localStorage.setItem(key, JSON.stringify(value));
      localStorage.setItem('anime_hub_watchlist_user-a', JSON.stringify([{ id: 999 }]));
      window.confirm = message => message.startsWith('Are you sure');
      window.supabaseClient = {
        auth: {
          getSession: async () => ({
            data: { session: { access_token: 'test-access-token', user: { id: 'user-a' } } },
            error: null
          }),
          signOut: async () => ({ error: null })
        }
      };
    }, [WATCHLIST_KEY, guestItems]);

    await page.evaluate(() => window.deleteAccount());

    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)), WATCHLIST_KEY))
      .toEqual(guestItems);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('anime_hub_watchlist_user-a')))
      .toBeNull();
  });
});
