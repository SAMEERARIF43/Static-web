const { test, expect } = require('@playwright/test');

/**
 * Regression test for search overlay Escape key behavior.
 * Ensures pressing Escape in the search overlay closes the overlay,
 * clears suggestions, and doesn't leave stale suggestions on reopen.
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

function searchResults(query) {
  const q = query.toLowerCase();
  if (q.includes('one piece')) return [ONE_PIECE_FIXTURE];
  return [];
}

test.describe('Search Overlay Escape Behavior', () => {
  test.beforeEach(async ({ page }) => {
    // Hermetic run first so the specific API handlers below get a chance to
    // intercept local requests before the catch-all continues them.
    await page.route('**/*', route => {
      const { hostname } = new URL(route.request().url());
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === 's4.anilist.co' || hostname.endsWith('.supabase.co')) return route.continue();
      return route.abort();
    });

    // Mock /api/search/suggestions for autocomplete.
    await page.route('**/api/search/suggestions**', route => {
      const url = new URL(route.request().url());
      const query = url.searchParams.get('q') || '';
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchResults(query))
      });
    });

    // Mock /api/search to return deterministic fixtures instantly
    await page.route('**/api/search?*', route => {
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

  test('Escape closes search overlay and clears suggestions', async ({ page }) => {
    // Open the search overlay
    await expect(page.locator('#nav-search-trigger')).toBeVisible({ timeout: 10000 });
    await page.click('#nav-search-trigger');
    await expect(page.locator('#search-overlay')).toHaveClass(/open/, { timeout: 5000 });

    // Manually show suggestions panel with fake data (bypassing autocomplete fetch)
    await page.evaluate(() => {
      const panel = document.getElementById('nav-search-suggestions');
      const options = document.getElementById('nav-search-options');
      panel.hidden = false;
      options.innerHTML = `
        <li id="test-option-0" role="option" aria-selected="false" data-index="0">
          <span>ONE PIECE</span>
          <small>TV · 2024 · ★ 8.5</small>
        </li>
      `;
      const input = document.getElementById('search-overlay-input');
      input.setAttribute('aria-expanded', 'true');
    });

    // Verify suggestions are visible
    await expect(page.locator('#nav-search-suggestions')).not.toBeHidden({ timeout: 5000 });
    await expect(page.locator('#nav-search-options li[role="option"]')).toHaveCount(1, { timeout: 5000 });

    // Press Escape via evaluate to ensure event reaches the input's handler
    await page.evaluate(() => {
      const input = document.getElementById('search-overlay-input');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // Verify overlay is closed
    await expect(page.locator('#search-overlay')).not.toHaveClass(/open/, { timeout: 5000 });

    // Verify suggestions panel is hidden
    await expect(page.locator('#nav-search-suggestions')).toBeHidden({ timeout: 5000 });

    // Verify suggestions are cleared (no options)
    await expect(page.locator('#nav-search-options li[role="option"]')).toHaveCount(0, { timeout: 5000 });

    // Reopen the overlay
    await page.click('#nav-search-trigger');
    await expect(page.locator('#search-overlay')).toHaveClass(/open/, { timeout: 5000 });

    // Verify no stale suggestions appear on reopen (suggestions panel should be hidden until user types)
    await expect(page.locator('#nav-search-suggestions')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('#nav-search-options li[role="option"]')).toHaveCount(0, { timeout: 5000 });

    // Type a query again and verify fresh suggestions appear
    await page.fill('#search-overlay-input', 'One Piece');
    await expect(page.locator('#nav-search-suggestions')).not.toBeHidden({ timeout: 10000 });
    await expect(page.locator('#nav-search-options li[role="option"]')).toHaveCount(1, { timeout: 5000 });
  });

  test('closed overlay is not tabbable and restores focus when opened and closed', async ({ page }) => {
    const trigger = page.locator('#nav-search-trigger');
    const overlay = page.locator('#search-overlay');

    await expect(overlay).toBeHidden();
    await trigger.focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#search-overlay :focus')).toHaveCount(0);

    await trigger.click();
    await expect(overlay).toHaveClass(/open/);
    await expect(page.locator('#search-overlay-input')).toBeFocused();

    await page.locator('#search-close-btn').click();
    await expect(overlay).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

async function run() {
  console.log('Search overlay Escape behavior test defined.');
}

run().catch(error => {
  console.error('Test definition failed:', error.message);
  process.exitCode = 1;
});

module.exports = { test };
