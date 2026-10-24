const { defineConfig } = require('@playwright/test');
const base = require('./playwright.config.js');

/**
 * Test-only configuration for audit runs.
 *
 * The shared playwright.config.js hard-codes baseURL http://127.0.0.1:3100
 * and a webServer block that boots `node server.js` on port 3100. Audit runs
 * must not start, stop or replace any shared server, so this config reuses the
 * existing isolated server (default http://127.0.0.1:3147) and disables the
 * webServer block entirely. The shared config file itself is left untouched.
 */
const baseURL = process.env.AUDIT_BASE_URL || 'http://127.0.0.1:3147';

module.exports = defineConfig({
  ...base,
  use: {
    ...base.use,
    baseURL,
  },
  webServer: undefined,
});
