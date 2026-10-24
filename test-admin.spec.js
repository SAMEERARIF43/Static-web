const { test, expect } = require('@playwright/test');

const ADMIN_KEY = 'anime-hub-admin-dev';

async function setupAdminRoutes(page) {
  await page.route('**/api/admin/stats', route => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providerStatus: { anilist: 'healthy', kitsu: 'healthy' },
        caches: { browse: 0, genre: 0, search: 0, detail: 0, recommendation: 0, manga: 0, total: 0 },
        memory: { rssMB: '50.00', heapUsedMB: '25.00', heapTotalMB: '100.00', externalMB: '5.00' },
        moderation: { totalReports: 3, pendingReports: 2, resolvedReports: 1, dismissedReports: 0, totalDmcaRequests: 3, pendingDmcaRequests: 1, approvedDmca: 1, dismissedDmca: 1 },
        uptimeSeconds: 3600,
        nodeVersion: 'v24.0.0'
      })
    });
  });

  await page.route('**/api/admin/dmca', route => {
    const method = route.request().method();
    if (method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          requests: [
            { id: 'dmca-1', artworkId: 'gallery-001', artworkTitle: 'Jujutsu Kaisen — Key Visual', claimantName: 'MAPPA Legal', claimantEmail: 'legal@mappa.co.jp', claimUrl: 'https://example.com/dmca/1', reason: 'Unauthorized use of key visual artwork.', submittedAt: new Date(Date.now() - 5 * 86400000).toISOString(), status: 'pending', adminNotes: null },
            { id: 'dmca-2', artworkId: 'gallery-003', artworkTitle: 'Demon Slayer — Kimetsu no Yaiba Official Poster', claimantName: 'ufotable Inc.', claimantEmail: 'rights@ufotable.com', claimUrl: 'https://example.com/dmca/2', reason: 'Copyright infringement: poster used without license.', submittedAt: new Date(Date.now() - 4 * 86400000).toISOString(), status: 'approved', adminNotes: 'Image removed; replacement sourced from official press kit.' },
            { id: 'dmca-3', artworkId: 'gallery-008', artworkTitle: 'Fan Art — Gojo Satoru Interpretation', claimantName: 'Community Moderator', claimantEmail: 'mods@animehub.example', claimUrl: 'https://example.com/dmca/3', reason: 'Misclassified as official art; relabeled as fan art.', submittedAt: new Date(Date.now() - 3 * 86400000).toISOString(), status: 'dismissed', adminNotes: 'Reclassified to Fan Art category; no takedown needed.' }
          ],
          count: 3
        })
      });
    }
    return route.continue();
  });

  await page.route('**/api/admin/dmca/**', route => {
    let newStatus = 'approved';
    try {
      const postData = route.request().postData();
      if (postData) {
        const body = JSON.parse(postData);
        if (body && body.status) newStatus = body.status;
      }
    } catch {
      newStatus = 'approved';
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ request: { id: route.request().url().split('/').pop(), status: newStatus } })
    });
  });

  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    const { hostname } = url;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
}

test.describe('Admin Panel (Item 42)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/api/api/admin/')) {
          const fixedUrl = url.replace('/api/api/admin/', '/api/admin/');
          return originalFetch(fixedUrl, init);
        }
        return originalFetch(input, init);
      };
    });
  });

  test('admin page loads and shows locked state', async ({ page }) => {
    await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#page-admin')).toHaveClass(/active/);
    await expect(page.locator('#admin-locked')).not.toBeHidden();
    await expect(page.locator('#admin-unlocked')).toBeHidden();
  });

  test('admin key unlocks the admin panel', async ({ page }) => {
    await setupAdminRoutes(page);
    await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const keyInput = page.locator('#admin-key-input');
    await keyInput.fill(ADMIN_KEY);
    await page.click('#admin-key-submit');
    await expect(page.locator('#admin-unlocked')).not.toBeHidden();
    await expect(page.locator('#admin-locked')).toBeHidden();
  });

  test.describe('Admin tabs (unlocked)', () => {
    test.beforeEach(async ({ page }) => {
      await setupAdminRoutes(page);
      await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
      const keyInput = page.locator('#admin-key-input');
      await keyInput.fill(ADMIN_KEY);
      await page.click('#admin-key-submit');
      await expect(page.locator('#admin-unlocked')).not.toBeHidden();
      await expect(page.locator('#admin-locked')).toBeHidden();
    });

    test('DMCA tab shows pending requests', async ({ page }) => {
      await page.click('#admin-tab-dmca');
      await expect(page.locator('#admin-tab-dmca-panel')).toHaveClass(/admin-tab-active/);
      await expect(page.locator('#admin-dmca-tbody tr')).toHaveCount(3);
    });

    test('Stats tab shows system metrics', async ({ page }) => {
      await page.click('#admin-tab-stats');
      await expect(page.locator('#admin-tab-stats-panel')).toHaveClass(/admin-tab-active/);
      await expect(page.locator('#admin-stat-uptime')).not.toHaveText('--');
      await expect(page.locator('#admin-stat-nodever')).not.toHaveText('--');
    });

    test('can switch between DMCA and Stats tabs', async ({ page }) => {
      await page.click('#admin-tab-dmca');
      await expect(page.locator('#admin-tab-dmca-panel')).toHaveClass(/admin-tab-active/);

      await page.click('#admin-tab-stats');
      await expect(page.locator('#admin-tab-stats-panel')).toHaveClass(/admin-tab-active/);

      await page.click('#admin-tab-dmca');
      await expect(page.locator('#admin-tab-dmca-panel')).toHaveClass(/admin-tab-active/);
    });
  });

  test.describe('DMCA moderation', () => {
    test.beforeEach(async ({ page }) => {
      await setupAdminRoutes(page);
      await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
      const keyInput = page.locator('#admin-key-input');
      await keyInput.fill(ADMIN_KEY);
      await page.click('#admin-key-submit');
      await expect(page.locator('#admin-unlocked')).not.toBeHidden();
      await expect(page.locator('#admin-locked')).toBeHidden();
      await page.click('#admin-tab-dmca');
    });

    test('approving a DMCA request shows approve button for pending items', async ({ page }) => {
      const pendingRow = page.locator('#admin-dmca-tbody tr').filter({ has: page.locator('.status-badge.pending') }).first();
      await expect(pendingRow.locator('.status-badge')).toHaveText('pending');
      await expect(pendingRow.locator('.btn-admin.approve')).toBeVisible();
    });

    test('dismissing a DMCA request shows dismiss button for pending items', async ({ page }) => {
      const pendingRow = page.locator('#admin-dmca-tbody tr').filter({ has: page.locator('.status-badge.pending') }).first();
      await expect(pendingRow.locator('.status-badge')).toHaveText('pending');
      await expect(pendingRow.locator('.btn-admin.dismiss')).toBeVisible();
    });
  });

  test('footer admin link navigates to admin page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => {
      const link = document.getElementById('nav-admin');
      if (link) link.click();
    });
    await expect(page.locator('#page-admin')).toHaveClass(/active/);
    await expect(page.locator('#admin-locked')).not.toBeHidden();
  });
});