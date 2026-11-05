const { defineConfig, devices } = require('@playwright/test');

/**
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: '.',
  // Temporary diagnostic probe from a concurrent run; it is retained for
  // audit traceability but is not part of the release regression suite.
  testIgnore: ['**/test-auth-debug.spec.js', '**/frontend/**', '**/tests/**'],
  // A fresh external output path preserves earlier local QA artifacts.
  outputDir: process.env.ANIME_HUB_TEST_OUTPUT_DIR || 'test-results',
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI; run sequentially locally to avoid server overload */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['line'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }]
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://127.0.0.1:3100',

    /* Keep the stable default; retries still retain a diagnostic trace. */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers with desktop viewports */
  projects: [
    // Desktop viewports for primary testing
    {
      name: 'chromium-1920x1080',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'chromium-1440x900',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium-1366x768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    // Mobile viewport for regression check (Chromium-based)
    {
      name: 'chromium-mobile-375x667',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
    },
    // Reduced motion test
    {
      name: 'chromium-reduced-motion',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        reducedMotion: 'reduce'
      },
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3100/api/health',
    // Reuse a healthy local server when another test process already owns 3100.
    reuseExistingServer: true,
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // Required for resolving `node` while keeping application configuration
      // out of the child environment.
      PATH: process.env.PATH || '',
      NODE_ENV: 'test',
      PORT: '3100',
      SITE_URL: 'http://127.0.0.1:3100',
      CORS_ORIGINS: 'http://127.0.0.1:3100',
      ANILIST_GRAPHQL_URL: 'http://127.0.0.1:9',
      ANIME_HUB_TEST_MODE: '1',
      JUSTWATCH_REGION: 'us',

      // Disposable test-only admin key. Never a production value.
      ADMIN_KEY: 'playwright-test-only-admin-key',

      // Prevent inheriting ANIME_HUB_ENV_FILE from the parent Windows
      // environment, which points to an external secrets file
      // (L:\anime-hub-secrets\.env). The test server must use only the
      // explicitly configured test values below.
      ANIME_HUB_ENV_FILE: '',

      // Keep dotenv from filling these from the project .env in the test child.
      TRUST_PROXY: '',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      CONTACT_EMAIL: '',
      DMCA_EMAIL: ''
    },
  },

  /* Timeout for each test */
  timeout: 120000,
});
