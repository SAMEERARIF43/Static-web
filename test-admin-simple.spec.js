const { test, expect } = require('@playwright/test');

test.describe('Admin Panel - Simple', () => {
  test('admin page loads directly', async ({ page }) => {
    await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await expect(page.locator('#page-admin')).toHaveClass(/active/);
  });

  test('admin page is locked by default', async ({ page }) => {
    await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await expect(page.locator('#admin-locked')).not.toBeHidden();
    await expect(page.locator('#admin-unlocked')).toBeHidden();
  });

  test('admin key unlocks panel', async ({ page }) => {
    await page.goto('/?page=admin', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const keyInput = page.locator('#admin-key-input');
    await keyInput.fill('anime-hub-admin-dev');
    await page.click('#admin-key-submit');
    await expect(page.locator('#admin-unlocked')).not.toBeHidden();
    await expect(page.locator('#admin-locked')).toBeHidden();
  });
});
