const { test, expect } = require('@playwright/test');

const ADMIN_KEY = 'anime-hub-admin-dev';

async function setupAdminRoutes(page) {
  await page.route('**/api/admin/*', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/admin/reports' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          reports: [
            {
              id: 'r-1',
              title: 'One Piece',
              reason: 'Contains spoilers without warning tags.',
              reporter: 'viewer_42',
              reportedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
              status: 'pending',
              adultOnly: false
            },
            {
              id: 'r-2',
              type: 'review',
              targetId: '900050',
              targetTitle: 'Ne Zha',
              reason: 'Off-topic promotional link.',
              reporter: 'viewer_17',
              reportedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
              status: 'pending',
              adminNotes: null
            },
            {
              id: 'r-3',
              type: 'review',
              targetId: '900051',
              targetTitle: 'The Kings Avatar',
              reason: 'Duplicate of an existing review.',
              reporter: 'viewer_88',
              reportedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
              status: 'resolved',
              adminNotes: 'Removed duplicate; kept original review.'
            }
          ],
          count: 3
        })
      });
      return;
    }

    if (path.startsWith('/api/admin/reports/') && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ report: { id: url.pathname.split('/').pop(), status: 'resolved' } })
      });
      return;
    }

    if (path === '/api/admin/dmca' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          requests: [
            {
              id: 'dmca-1',
              artworkId: 'gallery-001',
              artworkTitle: 'Jujutsu Kaisen — Key Visual',
              claimantName: 'MAPPA Legal',
              claimantEmail: 'legal@mappa.co.jp',
              claimUrl: 'https://example.com/dmca/1',
              reason: 'Unauthorized use of key visual artwork.',
              submittedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
              status: 'pending',
              adminNotes: null
            },
            {
              id: 'dmca-2',
              artworkId: 'gallery-003',
              artworkTitle: 'Demon Slayer — Kimetsu no Yaiba Official Poster',
              claimantName: 'ufotable Inc.',
              claimantEmail: 'rights@ufotable.com',
              claimUrl: 'https://example.com/dmca/2',
              reason: 'Copyright infringement: poster used without license.',
              submittedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
              status: 'approved',
              adminNotes: 'Image removed; replacement sourced from official press kit.'
            },
            {
              id: 'dmca-3',
              artworkId: 'gallery-008',
              artworkTitle: 'Fan Art — Gojo Satoru Interpretation',
              claimantName: 'Community Moderator',
              claimantEmail: 'mods@animehub.example',
              claimUrl: 'https://example.com/dmca/3',
              reason: 'Misclassified as official art; relabeled as fan art.',
              submittedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
              status: 'dismissed',
              adminNotes: 'Reclassified to Fan Art category; no takedown needed.'
            }
          ],
          count: 3
        })
      });
      return;
    }

    if (path.startsWith('/api/admin/dmca/') && method === 'POST') {
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
        body: JSON.stringify({ request: { id: url.pathname.split('/').pop(), status: newStatus } })
      });
      return;
    }

    if (path === '/api/admin/stats' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          providerStatus: { anilist: 'healthy', kitsu: 'healthy' },
          caches: { browse: 0, genre: 0, search: 0, detail: 0, recommendation: 0, manga: 0, total: 0 },
          memory: { rssMB: '50.00', heapUsedMB: '25.00', heapTotalMB: '100.00', externalMB: '5.00' },
          moderation: {
            totalReports: 3, pendingReports: 2, resolvedReports: 1, dismissedReports: 0,
            totalDmcaRequests: 3, pendingDmcaRequests: 1, approvedDmca: 1, dismissedDmca: 1
          },
          uptimeSeconds: 3600,
          nodeVersion: 'v24.0.0'
        })
      });
      return;
    }

    route.continue();
  });

  await page.route('**/*', route => {
    const { hostname } = new URL(route.request().url());
    if (hostname === 'localhost' || hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
}

async function unlockAdminPanel(page) {
  const keyInput = page.locator('#admin-key-input');
  await keyInput.fill(ADMIN_KEY);
  await page.click('#admin-key-submit');
  await expect(page.locator('#admin-unlocked')).not.toBeHidden();
  await expect(page.locator('#admin-locked')).toBeHidden();
}

test.describe('Admin Panel (Item 42)', () => {
  test('admin page loads and shows locked state', async ({ page }) => {
    await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#page-admin')).toHaveClass(/active/);
    await expect(page.locator('#admin-locked')).not.toBeHidden();
    await expect(page.locator('#admin-unlocked')).toBeHidden();
  });

  test('admin key unlocks the admin panel', async ({ page }) => {
    await setupAdminRoutes(page);
    await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await unlockAdminPanel(page);
  });

  test.describe('Admin tabs (unlocked)', () => {
    test.beforeEach(async ({ page }) => {
      await setupAdminRoutes(page);
      await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await unlockAdminPanel(page);
    });

    test('DMCA tab shows pending requests', async ({ page }) => {
      await page.click('#admin-tab-dmca');
      await expect(page.locator('#admin-tab-dmca-panel')).not.toBeHidden();
      await expect(page.locator('#admin-dmca-tbody tr')).toHaveCount(3);
    });

    test('Review tab shows pending reports', async ({ page }) => {
      await page.click('#admin-tab-reviews');
      await expect(page.locator('#admin-tab-reviews-panel')).not.toBeHidden();
      await expect(page.locator('#admin-reviews-tbody tr')).toHaveCount(3);
    });

    test('Stats tab shows system metrics', async ({ page }) => {
      await page.click('#admin-tab-stats');
      await expect(page.locator('#admin-tab-stats-panel')).not.toBeHidden();
      await expect(page.locator('#admin-stat-uptime')).not.toHaveText('--');
      await expect(page.locator('#admin-stat-nodever')).not.toHaveText('--');
    });

    test('can switch between tabs', async ({ page }) => {
      await page.click('#admin-tab-dmca');
      await expect(page.locator('#admin-tab-dmca-panel')).not.toBeHidden();

      await page.click('#admin-tab-reviews');
      await expect(page.locator('#admin-tab-reviews-panel')).not.toBeHidden();

      await page.click('#admin-tab-stats');
      await expect(page.locator('#admin-tab-stats-panel')).not.toBeHidden();
    });
  });

  test.describe('DMCA moderation', () => {
    test.beforeEach(async ({ page }) => {
      await setupAdminRoutes(page);
      await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await unlockAdminPanel(page);
      await page.click('#admin-tab-dmca');
    });

    test('approving a DMCA request updates status badge', async ({ page }) => {
      const firstRow = page.locator('#admin-dmca-tbody tr').first();
      await expect(firstRow.locator('.status-badge')).toHaveText('pending');

      await firstRow.locator('.btn-admin.approve').click();

      await expect(page.locator('#admin-dmca-tbody tr').first().locator('.status-badge')).toHaveText('approved');
    });

    test('dismissing a DMCA request updates status badge', async ({ page }) => {
      const firstRow = page.locator('#admin-dmca-tbody tr').first();
      await expect(firstRow.locator('.status-badge')).toHaveText('pending');

      await firstRow.locator('.btn-admin.dismiss').click();

      await expect(page.locator('#admin-dmca-tbody tr').first().locator('.status-badge')).toHaveText('dismissed');
    });
  });

  test.describe('Review moderation', () => {
    test.beforeEach(async ({ page }) => {
      await setupAdminRoutes(page);
      await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await unlockAdminPanel(page);
      await page.click('#admin-tab-reviews');
    });

    test('resolving a review report updates status badge', async ({ page }) => {
      const firstRow = page.locator('#admin-reviews-tbody tr').first();
      await expect(firstRow.locator('.status-badge')).toHaveText('pending');

      await firstRow.locator('.btn-admin.approve').click();

      await expect(page.locator('#admin-reviews-tbody tr').first().locator('.status-badge')).toHaveText('resolved');
    });

    test('dismissing a review report updates status badge', async ({ page }) => {
      const firstRow = page.locator('#admin-reviews-tbody tr').first();
      await expect(firstRow.locator('.status-badge')).toHaveText('pending');

      await firstRow.locator('.btn-admin.dismiss').click();

      await expect(page.locator('#admin-reviews-tbody tr').first().locator('.status-badge')).toHaveText('dismissed');
    });
  });

  test('footer admin link navigates to admin page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.click('#nav-admin');
    await expect(page.locator('#page-admin')).toHaveClass(/active/);
    await expect(page.locator('#admin-locked')).not.toBeHidden();
  });
});