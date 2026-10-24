const { test, expect } = require('@playwright/test');

test.describe('Admin Page Minimal', () => {
  test('page loads and shows locked state', async ({ page }) => {
    await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.locator('#page-admin')).toHaveClass(/active/);
    await expect(page.locator('#admin-locked')).not.toBeHidden();
    await expect(page.locator('#admin-unlocked')).toBeHidden();
  });
});
