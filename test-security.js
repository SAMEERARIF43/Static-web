/**
 * Phase 2 security and resilience tests.
 *
 * These exercise the failure paths that the catalog suite cannot reach while
 * AniList is healthy: security headers on error responses, the Content-Security
 * -Policy surface, per-scope rate limits, an AniList outage falling back to the
 * curated catalog, and every DELETE /api/account failure mode.
 *
 * Each scenario spawns its own server on its own port so an exhausted rate
 * limit window can never leak into the next scenario. AniList and Supabase are
 * pointed at a closed local port, which fails immediately instead of waiting
 * for a real network timeout.
 */
const http = require('http');
const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const { createAniListMock } = require('./test-fixtures/anilist-mock');
const { requestHeaders, sanitizeForwardHeaders } = require('./stream-proxy');

// Jujutsu Kaisen: a curated entry, so it has a local fallback while AniList is down.
const CURATED_ANILIST_ID = 113415;
// A syntactically valid AniList ID that exists neither live nor in curation.
const UNKNOWN_ANILIST_ID = 987654321;
const verifiedUserId = '01234567-89ab-cdef-0123-456789abcdef';
const ANON_KEY = 'test-public-anon-key';
const SERVICE_ROLE_KEY = 'test-server-only-service-role-key';
const STREAM_PROXY_TEST_SECRET = 'stage04-stream-proxy-test-secret';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const authRequests = [];
let authMode = 'ok';

function request(baseURL, pathname, headers = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (body !== null) requestHeaders['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(`${baseURL}${pathname}`, { headers: requestHeaders, method }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = data;
        if ((res.headers['content-type'] || '').includes('application/json')) {
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
        }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function getTitle(anime) {
  if (typeof anime.title === 'string') return anime.title;
  return anime.title?.english || anime.title?.romaji || anime.title?.native || '';
}

function cspDirectives(response) {
  const header = response.headers['content-security-policy'] || '';
  return new Map(
    header
      .split('; ')
      .filter(Boolean)
      .map(part => {
        const [name, ...values] = part.split(' ');
        return [name, values.join(' ')];
      })
  );
}

function createTestStreamToken(url) {
  const payload = Buffer.from(JSON.stringify({
    url,
    exp: Date.now() + 60 * 1000
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', STREAM_PROXY_TEST_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Reset only the current test client's in-memory buckets before a scenario
 * whose first assertion is intentionally unauthenticated. This keeps the
 * security assertion focused on authentication rather than request history.
 */
async function resetRateLimitState(baseURL) {
  const response = await request(
    baseURL,
    '/__test/reset-rate-limits',
    { 'X-Test-Rate-Limit-Reset': '1' },
    'POST'
  );
  assert.strictEqual(response.statusCode, 204, 'Test rate-limit reset must be available in NODE_ENV=test');
}

/** Every response must carry the hardened header set, including errors. */
function assertSecurityHeaders(response, label) {
  assert.strictEqual(response.headers['x-content-type-options'], 'nosniff', `${label}: nosniff header`);
  assert.strictEqual(response.headers['x-frame-options'], 'DENY', `${label}: X-Frame-Options`);
  assert.strictEqual(response.headers['referrer-policy'], 'strict-origin-when-cross-origin', `${label}: Referrer-Policy`);
  assert(
    (response.headers['permissions-policy'] || '').includes('camera=()'),
    `${label}: Permissions-Policy should restrict powerful features`
  );
  assert(
    (response.headers['content-security-policy'] || '').includes("default-src 'self'"),
    `${label}: Content-Security-Policy should be present`
  );
  assert(
    UUID_PATTERN.test(response.headers['x-request-id'] || ''),
    `${label}: X-Request-ID should be a UUID for log correlation`
  );
}

/** Reserve a port, then release it so connections to it are refused at once. */
function findClosedPort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(port, env) {
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // Keep rate-limit assertions enabled even if the parent shell exported
      // ANIME_HUB_TEST_MODE for another local test process.
      ANIME_HUB_TEST_MODE: '0',
      PORT: String(port),
      SITE_URL: 'https://animehub.example',
      CORS_ORIGINS: `http://localhost:${port}`,
      ...env
    }
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Server did not start within 10 seconds.')), 10000);
    server.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes(`AnimeHub server listening on port ${port}.`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before becoming ready (code ${code}).`));
    });
  });
  return server;
}

function stopServer(server) {
  return new Promise(resolve => {
    if (server.exitCode !== null) {
      resolve();
      return;
    }
    server.once('exit', resolve);
    server.kill();
  });
}

/** Supabase mock whose behaviour is switched through `authMode`. */
function createAuthServer() {
  return http.createServer((req, res) => {
    authRequests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/auth/v1/user') {
      if (authMode === 'hangVerify') {
        // Deliberately never answer: the server must apply its own timeout.
        return;
      }
      if (authMode === 'status401') {
        res.statusCode = 401;
        res.end(JSON.stringify({ message: 'invalid token' }));
        return;
      }
      if (authMode === 'status500') {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: 'internal error' }));
        return;
      }
      if (authMode === 'invalidUser') {
        res.end(JSON.stringify({ id: 'not-a-uuid' }));
        return;
      }
      res.end(JSON.stringify({ id: verifiedUserId }));
      return;
    }
    if (req.method === 'DELETE' && req.url === `/auth/v1/admin/users/${verifiedUserId}`) {
      if (authMode === 'deleteFail') {
        res.statusCode = 500;
        res.end(JSON.stringify({ message: 'delete failed' }));
        return;
      }
      if (authMode === 'hangAdmin') {
        // Deliberately never answer: the server must apply its Admin API timeout.
        return;
      }
      res.end(JSON.stringify({ id: verifiedUserId }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not found' }));
  });
}

/** Headers, CSP, outage fallback, dotfile exposure and rate limiting. */
async function runOutageAndHeaderScenario(deadPort, port) {
  const baseURL = `http://localhost:${port}`;
  const server = await startServer(port, {
    ANILIST_GRAPHQL_URL: `http://127.0.0.1:${deadPort}/graphql`,
    SUPABASE_URL: `https://127.0.0.1:${deadPort}`,
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    ANIME_HUB_TEST_ERROR_ROUTE: '1'
  });

  try {
    await resetRateLimitState(baseURL);

    // ---- security headers and CSP on a normal response ----
    const home = await request(baseURL, '/');
    assert.strictEqual(home.statusCode, 200, 'Home page should render');
    assertSecurityHeaders(home, '200 response');
    assert.strictEqual(
      home.headers['strict-transport-security'],
      undefined,
      'HSTS must not be advertised outside production'
    );

    const directives = cspDirectives(home);
    assert.strictEqual(directives.get('default-src'), "'self'", 'default-src should stay same-origin');
    assert.strictEqual(
      directives.get('script-src'),
      "'self' https://cdn.jsdelivr.net",
      'script-src should allow only self plus the pinned Supabase CDN'
    );
    assert(
      !directives.get('script-src').includes('unsafe-inline'),
      'script-src must not allow inline script execution'
    );
    assert(
      directives.get('style-src').includes("'unsafe-inline'"),
      'Existing inline style attributes need style-src unsafe-inline'
    );
    assert(
      directives.get('style-src').includes('https://fonts.googleapis.com'),
      'Google Fonts stylesheet must stay allowed'
    );
    assert(
      directives.get('font-src').includes('https://fonts.gstatic.com'),
      'Google Fonts files must stay allowed'
    );
    assert(
      directives.get('img-src').includes('https://s4.anilist.co'),
      'AniList cover art must stay allowed'
    );
    assert(
      directives.get('connect-src').includes(`https://127.0.0.1:${deadPort}`),
      'The configured Supabase origin must stay connectable for browser auth'
    );
    assert.strictEqual(directives.get('object-src'), "'none'", 'Plugins should be blocked');
    assert.strictEqual(directives.get('frame-ancestors'), "'none'", 'Framing should be blocked');
    assert.strictEqual(directives.get('base-uri'), "'self'", 'base-uri should be pinned');

    const second = await request(baseURL, '/');
    assert.notStrictEqual(
      second.headers['x-request-id'],
      home.headers['x-request-id'],
      'Every request should get its own request id'
    );
    console.log('Security headers and CSP verified on a normal page response.');

    // ---- security headers survive error responses ----
    const missing = await request(baseURL, '/api/does-not-exist');
    assert.strictEqual(missing.statusCode, 404, 'Unknown API routes should return 404');
    assert.strictEqual(typeof missing.body, 'object', 'API 404 should return JSON');
    assert.strictEqual(missing.body.message, 'Not found.', 'API 404 should return standard JSON message');
    assertSecurityHeaders(missing, '404 response');

    const missingPage = await request(baseURL, '/unknown-browser-page');
    assert.strictEqual(missingPage.statusCode, 404, 'Unknown non-API browser paths should return 404');
    assertSecurityHeaders(missingPage, '404 HTML response');
    assert(
      typeof missingPage.body === 'string' && missingPage.body.includes('Page Not Found'),
      'Unknown non-API browser paths should serve public/404.html'
    );

    const internalFailure = await request(baseURL, '/api/test/error-middleware');
    assert.strictEqual(internalFailure.statusCode, 500, 'Generic errors should return HTTP 500');
    assert.strictEqual(typeof internalFailure.body, 'object', 'Generic errors should return JSON');
    assert.deepStrictEqual(
      Object.keys(internalFailure.body).sort(),
      ['message'],
      'Generic errors should expose only the documented message field'
    );
    assert.strictEqual(
      internalFailure.body.message,
      'An internal server error occurred.',
      'Generic errors should use the neutral documented message'
    );
    const internalFailureText = JSON.stringify(internalFailure.body);
    assert(
      !/P6\.5|stack|at |server\.js|127\.0\.0\.1|token|secret|fixture internal detail/i.test(internalFailureText),
      'Generic errors must not expose internal exception details'
    );
    assertSecurityHeaders(internalFailure, 'generic 500 response');
    console.log('Generic 500 error middleware contract verified.');

    const forbiddenOrigin = await request(baseURL, '/api/site-config', {
      Origin: 'https://not-allowed.example'
    });
    assert.strictEqual(forbiddenOrigin.statusCode, 403, 'Foreign origins should be rejected with 403');
    assertSecurityHeaders(forbiddenOrigin, 'CORS 403 response');
    assert.strictEqual(
      forbiddenOrigin.headers['access-control-allow-origin'],
      undefined,
      'A rejected origin must not receive an allow-origin header'
    );
    console.log('Security headers verified on 404 and CORS 403 responses.');

    // ---- repository contents are not served ----
    const projectRoot = await request(baseURL, '/server.js');
    assert.strictEqual(projectRoot.statusCode, 404, 'Only public/ should be served');
    for (const pathname of ['/.freebuff/project-id', '/.env', '/%2e%2e/server.js', '/../server.js']) {
      const attempt = await request(baseURL, pathname);
      assert.notStrictEqual(attempt.statusCode, 200, `${pathname} must not be served`);
      assert(
        !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(String(attempt.body)),
        `${pathname} must not expose repository contents`
      );
    }
    console.log('Dotfiles and path traversal attempts are not served.');

    // ---- AniList outage: curated IDs survive, unknown IDs keep the contract ----
    const curatedDetail = await request(baseURL, `/api/anime/${CURATED_ANILIST_ID}`);
    assert.strictEqual(curatedDetail.statusCode, 200, 'A curated title should still render during an outage');
    assert.strictEqual(
      curatedDetail.headers['x-catalog-source'],
      'curated',
      'A fallback detail response must be labelled as curated'
    );
    assert.strictEqual(curatedDetail.body.id, CURATED_ANILIST_ID, 'The fallback must keep the AniList ID canonical');
    assert(
      getTitle(curatedDetail.body).toLowerCase().includes('jujutsu'),
      'The curated fallback should return the curated title'
    );

    const unknownDetail = await request(baseURL, `/api/anime/${UNKNOWN_ANILIST_ID}`);
    assert.strictEqual(
      unknownDetail.statusCode,
      500,
      'An unknown ID during an outage must fail rather than fabricate an entry'
    );
    assert.strictEqual(
      unknownDetail.headers['x-catalog-source'],
      undefined,
      'A failed detail request must not claim a catalog source'
    );
    assert(
      !/ECONNREFUSED|127\.0\.0\.1/.test(JSON.stringify(unknownDetail.body)),
      'Error responses must not leak upstream connection details'
    );

    assert.strictEqual(
      (await request(baseURL, '/api/anime/abc')).statusCode,
      400,
      'A non-numeric ID should be rejected'
    );
    assert.strictEqual(
      (await request(baseURL, '/api/anime/0')).statusCode,
      400,
      'An out-of-range ID should be rejected'
    );
    assert.strictEqual(
      (await request(baseURL, '/api/anime/2147483648')).statusCode,
      400,
      'An ID beyond the AniList range should be rejected'
    );

    // ---- catalog lists and search degrade to the curated catalog ----
    const trending = await request(baseURL, '/api/trending');
    assert.strictEqual(trending.statusCode, 200, 'Catalog lists should survive an AniList outage');
    assert(Array.isArray(trending.body) && trending.body.length > 0, 'The curated catalog should answer instead');
    assert(
      trending.body.every(anime => anime.id === anime.anilistId),
      'Fallback catalog entries must still expose the AniList ID as their only id'
    );

    const searchFallback = await request(baseURL, '/api/search?q=jujutsu');
    assert.strictEqual(searchFallback.statusCode, 200, 'Search should survive an AniList outage');
    assert(
      searchFallback.body.some(anime => getTitle(anime).toLowerCase().includes('jujutsu')),
      'Search should fall back to the curated catalog'
    );
    assert.strictEqual(
      (await request(baseURL, '/api/search?q=Re%3AZero')).statusCode,
      200,
      'Legitimate title punctuation must not be rejected'
    );
    assert.strictEqual(
      (await request(baseURL, '/api/search?q=abc%00def')).statusCode,
      400,
      'Control characters in a search query should be rejected'
    );
    assert.strictEqual(
      (await request(baseURL, '/api/search?q=')).statusCode,
      400,
      'An empty search query should be rejected'
    );

    // ---- /api/popular degrades to the curated catalog during an outage ----
    const popularFallback = await request(baseURL, '/api/popular');
    assert.strictEqual(popularFallback.statusCode, 200, 'Popular should survive an AniList outage');
    assert(
      Array.isArray(popularFallback.body) && popularFallback.body.length > 0,
      'The curated catalog should answer the popular request instead'
    );
    assert(
      popularFallback.body.every(anime => anime.id === anime.anilistId),
      'Popular fallback entries must keep the AniList ID as their only id'
    );
    console.log('AniList outage falls back to curated data with honest status codes.');

    // ---- suggestions: AniList down and nothing matches locally => documented 502 ----
    const suggestionsOutage = await request(baseURL, '/api/search/suggestions?q=anime%20that%20does%20not%20exist%20anywhere');
    assert.strictEqual(
      suggestionsOutage.statusCode,
      502,
      'Suggestions should fail with 502 when AniList is down and no local match exists'
    );
    assert.strictEqual(
      suggestionsOutage.body.message,
      'Suggestions are temporarily unavailable.',
      'The suggestions failure must use the documented neutral message'
    );
    assert(
      !/ECONNREFUSED|127\.0\.0\.1/.test(JSON.stringify(suggestionsOutage.body)),
      'Suggestions failures must not leak upstream connection details'
    );
    assertSecurityHeaders(suggestionsOutage, '502 suggestions response');

    // ---- error middleware contract: a body over the 16 kb JSON limit => 413 ----
    const oversizedBody = JSON.stringify({ padding: 'x'.repeat(32 * 1024) });
    const tooLarge = await request(
      baseURL,
      '/api/does-not-exist',
      { 'Content-Type': 'application/json' },
      'POST',
      oversizedBody
    );
    assert.strictEqual(tooLarge.statusCode, 413, 'A body over the 16 kb limit should be rejected with 413');
    assert.strictEqual(
      tooLarge.body.message,
      'Request body is too large.',
      'The 413 payload must match the documented contract'
    );
    assertSecurityHeaders(tooLarge, '413 response');
    console.log('Suggestion outages and oversized bodies keep their documented contracts.');

    // Score on the 0-100 scale, used by the browse assertions below.
    const scoreOf = item => (Number.isFinite(item.averageScore) && item.averageScore > 0
      ? item.averageScore
      : Number(item.rating || 0) * 10);

    // ---- /api/browse: strict validation and honest curated fallback ----
    const browseFallback = await request(baseURL, '/api/browse');
    assert.strictEqual(browseFallback.statusCode, 200, 'The browse endpoint should answer during an outage');
    assert.strictEqual(
      browseFallback.headers['x-catalog-source'],
      'curated',
      'A browse fallback response must be labelled as curated'
    );
    assert.strictEqual(
      browseFallback.headers['ratelimit-policy'],
      '60;w=60',
      'The browse endpoint should carry the AniList-proxy limit'
    );
    assert(Array.isArray(browseFallback.body) && browseFallback.body.length > 0, 'The curated catalog should answer browse');
    assert(
      browseFallback.body.every(anime => anime.id === anime.anilistId),
      'Browse fallback entries must keep the AniList ID as their only id'
    );
    assert.strictEqual(browseFallback.headers['x-catalog-page'], '1', 'The browse page number must be reported');
    assert.strictEqual(browseFallback.headers['x-catalog-per-page'], '30', 'The browse page size must be reported');
    assert.strictEqual(browseFallback.headers['x-catalog-total-pages'], '1', 'The curated catalog fits one browse page');
    assert.strictEqual(browseFallback.headers['x-catalog-has-next'], 'false', 'The curated catalog has no next browse page');

    // Load more stops honestly on the curated fallback.
    const browseSecondPage = await request(baseURL, '/api/browse?page=2');
    assert.strictEqual(browseSecondPage.statusCode, 200, 'A second browse page must still answer');
    assert.deepStrictEqual(browseSecondPage.body, [], 'The curated catalog has no second browse page');
    assert.strictEqual(browseSecondPage.headers['x-catalog-has-next'], 'false', 'There is no next browse page');

    // Filters, sort and composition on the fallback.
    const browseCombined = await request(baseURL, '/api/browse?genre=Action&sort=SCORE_DESC&minScore=80');
    assert.strictEqual(browseCombined.statusCode, 200, 'Browse filters should compose');
    assert(browseCombined.body.length > 0, 'The combined browse filter should match curated titles');
    assert(
      browseCombined.body.every(anime =>
        (anime.genre || []).map(g => g.toLowerCase()).includes('action') && scoreOf(anime) >= 80),
      'Combined browse filters must all be enforced'
    );
    for (let index = 1; index < browseCombined.body.length; index += 1) {
      assert(
        scoreOf(browseCombined.body[index - 1]) >= scoreOf(browseCombined.body[index]),
        'Browse SCORE_DESC sort must be descending'
      );
    }

    const browseStatus = await request(baseURL, '/api/browse?status=RELEASING');
    assert.strictEqual(browseStatus.statusCode, 200, 'A browse status filter should be accepted');
    assert(browseStatus.body.length > 0, 'The airing filter should match curated titles');
    assert(
      browseStatus.body.every(anime => ['Airing', 'RELEASING'].includes(String(anime.status))),
      'Browse status must be enforced on the fallback results'
    );

    // The curated catalog now contains Ne Zha (MOVIE, CN) added in Phase 4 to
    // support Chinese animated movie compatibility. Verify the format filter
    // correctly passes through and that every result is a film.
    const browseMovies = await request(baseURL, '/api/browse?format=MOVIE');
    assert.strictEqual(browseMovies.statusCode, 200, 'A browse format filter should be accepted');
    assert(
      Array.isArray(browseMovies.body) &&
        browseMovies.body.every(anime => (anime.type || anime.format) === 'MOVIE'),
      'Every item returned by browse?format=MOVIE must be a film (MOVIE format)'
    );

    // ---- invalid browse parameters are rejected during the outage too ----
    const invalidBrowseQueries = [
      'genre=NotARealGenre',
      'genre=%3Cscript%3E',
      'season=MONSOON',
      'format=HOLOGRAM',
      'format=TV_SHORT',
      'status=HIATUS',
      'minScore=101',
      'minScore=-5',
      'year=1959',
      'sort=DROP_TABLE',
      'sort=score', // /api/browse only accepts the four enum spellings
      'page=popular',
      'page=51',
      'perPage=31',
      'year=2020&year=2021'
    ];
    for (const query of invalidBrowseQueries) {
      const invalid = await request(baseURL, `/api/browse?${query}`);
      assert.strictEqual(invalid.statusCode, 400, `Invalid browse filter "${query}" must be rejected`);
      assert.strictEqual(typeof invalid.body.message, 'string', `Invalid "${query}" must explain the error`);
      assert(
        !/ECONNREFUSED|127\.0\.0\.1|stack/i.test(JSON.stringify(invalid.body)),
        `Invalid "${query}" must not leak upstream details`
      );
      assertSecurityHeaders(invalid, `browse 400 for ${query}`);
    }

    console.log('Browse validates strictly, falls back to the curated catalog and paginates honestly.');

    // ---- rate limits advertise their scope and do not throttle config ----
    const health = await request(baseURL, '/api/health');
    assert.strictEqual(health.statusCode, 200, 'The health endpoint should answer');
    assert.strictEqual(health.headers['ratelimit-policy'], '120;w=60', 'The global /api limit should be 120 per minute');
    assert.strictEqual(
      (await request(baseURL, '/api/search?q=one')).headers['ratelimit-policy'],
      '60;w=60',
      'Search should carry the stricter AniList-proxy limit'
    );
    const siteConfig = await request(baseURL, '/api/site-config');
    assert.strictEqual(siteConfig.statusCode, 200, 'Public config should always answer');
    assert.strictEqual(
      siteConfig.headers['ratelimit-policy'],
      undefined,
      'Public config endpoints must not be rate limited'
    );

    // ---- Supabase unreachable: deletion reports a server-side failure ----
    const unreachable = await request(
      baseURL,
      '/api/account',
      { Authorization: 'Bearer test-access-token' },
      'DELETE'
    );
    assert.strictEqual(
      unreachable.statusCode,
      502,
      'An unreachable Supabase must be a bad gateway, not a client error'
    );
    assert(
      !/ECONNREFUSED|127\.0\.0\.1|service-role/.test(JSON.stringify(unreachable.body)),
      'Deletion errors must not leak upstream details'
    );
    assertSecurityHeaders(unreachable, '502 response');

    // ---- exceeding the global limit returns 429 with headers ----
    let limited = null;
    let attempts = 0;
    for (; attempts < 200 && !limited; attempts += 1) {
      const response = await request(baseURL, '/api/health');
      if (response.statusCode === 429) {
        limited = response;
        break;
      }
      assert.strictEqual(response.statusCode, 200, 'Requests under the limit should succeed');
    }
    assert(limited, 'Exceeding 120 requests per minute should eventually return 429');
    assertSecurityHeaders(limited, '429 response');
    assert.strictEqual(limited.headers['ratelimit-policy'], '120;w=60', 'The 429 should document the limit');
    assert(
      String(limited.body.message || '').includes('Too many requests'),
      'The 429 body should explain the limit without leaking internals'
    );
    assert.strictEqual(
      (await request(baseURL, '/api/trending')).statusCode,
      429,
      'A throttled client should stay limited for the rest of the window'
    );
    console.log(`Global rate limit enforced after ${attempts} requests over the allowance.`);
  } finally {
    await stopServer(server);
  }
}

/** Verification failures for DELETE /api/account (401/502, no leakage). */
async function runAccountVerificationScenario(mockAuthUrl, port) {
  const baseURL = `http://localhost:${port}`;
  const server = await startServer(port, {
    SUPABASE_URL: mockAuthUrl,
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY
  });

  try {
    await resetRateLimitState(baseURL);

    // A cleartext Supabase origin must never be trusted for credentials.
    assert.strictEqual(
      cspDirectives(await request(baseURL, '/')).get('connect-src'),
      "'self'",
      'An HTTP Supabase origin must not be allowed in connect-src'
    );

    const withoutToken = await request(baseURL, '/api/account', {}, 'DELETE');
    assert.strictEqual(withoutToken.statusCode, 401, 'Deletion without a session must be rejected');
    assert.strictEqual(authRequests.length, 0, 'An unauthenticated request must never reach Supabase');

    const malformed = await request(baseURL, '/api/account', { Authorization: 'Bearer' }, 'DELETE');
    assert.strictEqual(malformed.statusCode, 401, 'A malformed bearer header must be rejected');
    assert.strictEqual(authRequests.length, 0, 'A malformed bearer header must never reach Supabase');

    authMode = 'status401';
    const expired = await request(baseURL, '/api/account', { Authorization: 'Bearer test-access-token' }, 'DELETE');
    assert.strictEqual(expired.statusCode, 401, 'An expired session must surface as 401');
    assert.strictEqual(authRequests.length, 1, 'The access token must be verified server-side');
    assert.strictEqual(authRequests[0].url, '/auth/v1/user', 'Verification must use the Supabase Auth user endpoint');
    assert.strictEqual(authRequests[0].headers.apikey, ANON_KEY, 'Verification must use the public anon key');

    authMode = 'status500';
    const upstreamFailure = await request(baseURL, '/api/account', { Authorization: 'Bearer test-access-token' }, 'DELETE');
    assert.strictEqual(upstreamFailure.statusCode, 502, 'A Supabase failure must be reported as a bad gateway');
    assert.strictEqual(
      upstreamFailure.body.message,
      'Could not verify the account session.',
      'A verification failure should use a neutral message'
    );

    authMode = 'invalidUser';
    const invalidUser = await request(baseURL, '/api/account', { Authorization: 'Bearer test-access-token' }, 'DELETE');
    assert.strictEqual(invalidUser.statusCode, 502, 'An unexpected user payload must not be trusted');
    assert.strictEqual(
      authRequests.filter(entry => entry.method === 'DELETE').length,
      0,
      'No Admin API call may happen before the user identity is validated'
    );
    assert(
      !JSON.stringify(invalidUser.body).includes(SERVICE_ROLE_KEY),
      'Responses must never echo server credentials'
    );
    console.log('Account deletion verification failures return 401/502 without leaking details.');
  } finally {
    await stopServer(server);
  }
}

/** Deletion failures plus the account-specific rate limit. */
async function runAccountDeletionScenario(mockAuthUrl, port) {
  const baseURL = `http://localhost:${port}`;
  const server = await startServer(port, {
    SUPABASE_URL: mockAuthUrl,
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY
  });

  try {
    await resetRateLimitState(baseURL);

    authMode = 'deleteFail';
    const deleteFailure = await request(baseURL, '/api/account', { Authorization: 'Bearer test-access-token' }, 'DELETE');
    assert.strictEqual(
      deleteFailure.statusCode,
      502,
      'An Admin API failure must be a bad gateway, not a user error'
    );
    assert.strictEqual(
      authRequests[authRequests.length - 1].headers.apikey,
      SERVICE_ROLE_KEY,
      'Only the Admin API call may use the service-role key'
    );

    authMode = 'ok';
    const callsBeforeDelete = authRequests.length;
    const deleted = await request(baseURL, '/api/account', { Authorization: 'Bearer test-access-token' }, 'DELETE');
    assert.strictEqual(deleted.statusCode, 200, 'A verified session should delete the account');
    assert.strictEqual(
      authRequests.length - callsBeforeDelete,
      2,
      'Deletion should verify the token and then delete exactly one user'
    );
    assert.strictEqual(authRequests[authRequests.length - 2].url, '/auth/v1/user', 'The token is verified first');
    assert.strictEqual(
      authRequests[authRequests.length - 1].url,
      `/auth/v1/admin/users/${verifiedUserId}`,
      'The Admin API target must come from the verified session, not from the request'
    );
    assert(
      !JSON.stringify(deleted.body).includes(SERVICE_ROLE_KEY),
      'The service-role key must never appear in a response'
    );

    // ---- a hanging upstream exercises the verification timeout ----
    authMode = 'hangVerify';
    const timedOut = await request(baseURL, '/api/account', { Authorization: 'Bearer test-access-token' }, 'DELETE');
    assert.strictEqual(timedOut.statusCode, 504, 'A Supabase verification timeout should surface as 504');
    assert(
      !/ECONNABORTED|127.0.0.1/.test(JSON.stringify(timedOut.body)),
      'A timeout response must not disclose upstream connection details'
    );
    assertSecurityHeaders(timedOut, '504 response');
    authMode = 'ok';

    // ---- a hanging Admin API exercises the 15-second Admin API timeout ----
    authMode = 'hangAdmin';
    const adminTimedOut = await request(baseURL, '/api/account', { Authorization: 'Bearer test-access-token' }, 'DELETE');
    assert.strictEqual(adminTimedOut.statusCode, 504, 'A Supabase Admin API timeout should surface as 504');
    assert(
      !/ECONNABORTED|127.0.0.1/.test(JSON.stringify(adminTimedOut.body)),
      'An Admin API timeout response must not disclose upstream connection details'
    );
    assertSecurityHeaders(adminTimedOut, '504 response');
    authMode = 'ok';

    // Four of the five allowed attempts are already spent (delete failure,
    // success, verification timeout, Admin API timeout): one more must still
    // answer, the sixth must throttle.
    for (let attempt = 0; attempt < 1; attempt += 1) {
      const unauthorized = await request(baseURL, '/api/account', {}, 'DELETE');
      assert.strictEqual(unauthorized.statusCode, 401, 'Unauthenticated deletion should stay 401 under the limit');
    }
    const limited = await request(baseURL, '/api/account', {}, 'DELETE');
    assert.strictEqual(limited.statusCode, 429, 'Account deletion should be limited to 5 attempts per window');
    assert.strictEqual(limited.headers['ratelimit-policy'], '5;w=900', 'The account limit should advertise its window');
    assertSecurityHeaders(limited, 'account 429 response');
    assert(
      !JSON.stringify(limited.body).includes(SERVICE_ROLE_KEY),
      'The throttle response must not leak configuration'
    );
    console.log('Account deletion failure paths and its rate limit behave as documented.');
  } finally {
    await stopServer(server);
  }
}

/** 503 paths: account deletion unavailable, and never contacting an upstream. */
async function runUnconfiguredScenario(port) {
  const baseURL = `http://localhost:${port}`;
  const requestsBefore = authRequests.length;
  const server = await startServer(port, {
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: ''
  });

  try {
    await resetRateLimitState(baseURL);

    const unconfigured = await request(
      baseURL,
      '/api/account',
      { Authorization: 'Bearer test-access-token' },
      'DELETE'
    );
    assert.strictEqual(
      unconfigured.statusCode,
      503,
      'A server without Supabase credentials must refuse deletion with 503'
    );
    assert.strictEqual(
      unconfigured.body.message,
      'Account deletion is not configured on this server.',
      'The 503 must use a neutral message'
    );
    assertSecurityHeaders(unconfigured, '503 response');
    assert.strictEqual(
      authRequests.length,
      requestsBefore,
      'An unconfigured server must never contact an upstream'
    );
    console.log('Account deletion returns 503 when it is not configured.');
    await stopServer(server);
  } catch (error) {
    await stopServer(server);
    throw error;
  }
}

/** Stream proxy SSRF rejection and inbound-header sanitization. */
async function runStreamProxySecurityScenario(port) {
  const baseURL = `http://localhost:${port}`;
  const server = await startServer(port, {
    STREAM_PROXY_SECRET: STREAM_PROXY_TEST_SECRET,
    STREAM_PROXY_ALLOWED_HOSTS: 'media.example.com',
    STREAM_PROVIDER_URL: 'https://provider.example/authorized-stream'
  });

  try {
    const blockedTargets = [
      'http://127.0.0.1/private.m3u8',
      'http://10.0.0.8/private.m3u8',
      'http://172.16.0.9/private.m3u8',
      'http://192.168.1.7/private.m3u8',
      'http://169.254.169.254/latest/meta-data/',
      'https://unlisted.example/private.m3u8'
    ];
    for (const target of blockedTargets) {
      const token = createTestStreamToken(target);
      const response = await request(baseURL, `/api/stream/proxy?token=${encodeURIComponent(token)}`);
      assert.strictEqual(response.statusCode, 403, `${target} must be rejected before an upstream connection`);
      assert.strictEqual(response.body.message, 'The stream host is not allowed.');
    }

    const inbound = sanitizeForwardHeaders({
      Accept: 'video/*',
      Range: 'bytes=0-',
      Authorization: 'Bearer should-not-forward',
      Cookie: 'session=should-not-forward',
      'X-Admin-Token': 'should-not-forward'
    });
    assert.deepStrictEqual(inbound, { Accept: 'video/*', Range: 'bytes=0-' });

    const forwarded = requestHeaders(new URL('https://media.example.com/video.m3u8'), inbound);
    assert.strictEqual(forwarded.Accept, 'video/*', 'Allowed media headers should be preserved');
    assert.strictEqual(forwarded.Range, 'bytes=0-', 'Range should remain available for media seeking');
    for (const sensitive of ['authorization', 'cookie', 'x-admin-token']) {
      assert(!Object.keys(forwarded).some(name => name.toLowerCase() === sensitive), `${sensitive} must not reach upstream`);
    }
    console.log('Stream proxy SSRF targets are rejected and sensitive headers are stripped.');
  } finally {
    await stopServer(server);
  }
}

/**
 * Stale-cache fallback: a catalog list answers from the previous successful
 * load when a later AniList refresh fails. This needs a controllable upstream
 * (unlike the dead-port scenarios) and a short cache TTL so the entry expires
 * on demand — CATALOG_CACHE_TTL_MS is overridden only for this server.
 *
 * LIMITATION: The cache is fully encapsulated in the createCatalogLoader closure
 * (server.js). There is no test-only hook to advance time or force expiry. The
 * test uses a 200 ms TTL and a fixed 500 ms wait (2.5x) which passes reliably
 * but is timing-dependent. A deterministic alternative would require production
 * test hooks or refactoring the loader, which is not justified for this one test.
 */
async function runStaleCacheScenario(port) {
  const baseURL = `http://localhost:${port}`;
  const mockPort = await findClosedPort();
  let anilistUp = true;

  // Unique id/title: absent from the curated catalog, so its presence in a
  // response proves the live load (or its stale copy) is being served.
  const fixtureMedia = {
    id: 999001,
    title: { romaji: 'Stale Cache Fixture', english: 'Stale Cache Fixture', native: 'Stale Cache Fixture' },
    coverImage: { large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx999001.jpg' },
    description: 'Fixture title used to prove the stale-cache fallback path.',
    episodes: 12,
    status: 'FINISHED',
    averageScore: 88,
    genres: ['Action'],
    season: 'WINTER',
    seasonYear: 2024,
    format: 'TV',
    countryOfOrigin: 'JP',
    studios: { nodes: [{ name: 'Fixture Studio' }] }
  };

  const mock = createAniListMock({
    port: mockPort,
    handleRequest: ({ res, jsonResponse }) => {
      if (!anilistUp) {
        jsonResponse(res, { error: 'AniList unavailable for this scenario' }, 500);
        return;
      }
      jsonResponse(res, { data: { Page: { media: [fixtureMedia] } } });
    }
  });
  await mock.start();

  const server = await startServer(port, {
    ANILIST_GRAPHQL_URL: mock.url,
    CATALOG_CACHE_TTL_MS: '200'
  });

  try {
    const first = await request(baseURL, '/api/popular');
    assert.strictEqual(first.statusCode, 200, 'The initial load should succeed while AniList is up');
    assert(Array.isArray(first.body) && first.body.length > 0, 'The initial load should return a catalog');
    assert(
      first.body.some(anime => anime.id === 999001 && anime.anilistId === 999001),
      'The live fixture must be part of the first answer'
    );

    // Fail the upstream, then let the 200 ms cache entry expire (wait 500 ms).
    anilistUp = false;
    await new Promise(resolve => setTimeout(resolve, 500));

    const second = await request(baseURL, '/api/popular');
    assert.strictEqual(
      second.statusCode,
      200,
      'A failed refresh must not break the endpoint after a successful load'
    );
    assert.deepStrictEqual(
      second.body,
      first.body,
      'AniList failing after a successful load must serve the stale cached catalog, not an error or a silently different curated-only body'
    );
    assert(
      second.body.some(anime => anime.id === 999001),
      'The stale answer must still carry the previously loaded fixture'
    );
    console.log('Stale catalog cache is served when a later AniList refresh fails.');
  } finally {
    await stopServer(server);
    await mock.close();
  }
}

// Task P5.2: /api/search and /api/anime/:id carry the same cache conventions
// as the catalog lists. Proves, against a controllable mock that counts its
// own upstream requests: repeat requests are answered from cache (one upstream
// call per distinct key), a failing upstream after TTL expiry serves the stale
// copy (fixture entries the curated catalog lacks must survive), keys are
// isolated during an outage, and a fallback answer is never cached.
async function runSearchDetailCacheScenario(port) {
  const baseURL = `http://localhost:${port}`;
  const mockPort = await findClosedPort();
  let anilistUp = true;
  let searchCalls = 0;
  let detailCalls = 0;

  // Unique ids/titles: absent from the curated catalog, so their presence in
  // a response proves the live answer (or its stale copy) is being served.
  const fixtureFields = {
    coverImage: { large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx999010.jpg' },
    description: 'Fixture title proving the search and detail caches work.',
    episodes: 12,
    status: 'FINISHED',
    averageScore: 88,
    genres: ['Action'],
    season: 'WINTER',
    seasonYear: 2024,
    format: 'TV',
    countryOfOrigin: 'JP',
    studios: { nodes: [{ name: 'Fixture Studio' }] }
  };
  const searchFixture = {
    id: 999010,
    title: { romaji: 'Cache Probe Fixture', english: 'Cache Probe Fixture', native: 'Cache Probe Fixture' },
    ...fixtureFields
  };
  const detailFixture = {
    id: 999011,
    title: { romaji: 'Detail Cache Fixture', english: 'Detail Cache Fixture', native: 'Detail Cache Fixture' },
    ...fixtureFields
  };

  const mock = createAniListMock({
    port: mockPort,
    handleRequest: ({ res, payload, jsonResponse }) => {
      if (!anilistUp) {
        jsonResponse(res, { error: 'AniList unavailable for this scenario' }, 500);
        return;
      }
      const query = String(payload.query || '');
      if (query.includes('Media(id:')) {
        detailCalls += 1;
        jsonResponse(res, { data: { Media: detailFixture } });
        return;
      }
      searchCalls += 1;
      jsonResponse(res, { data: { Page: { media: [searchFixture] } } });
    }
  });
  await mock.start();

  const server = await startServer(port, {
    ANILIST_GRAPHQL_URL: mock.url,
    // A 500 ms TTL leaves a comfortable window for the cache-hit assertions
    // below (localhost roundtrips take single-digit ms) while keeping the
    // expiry wait short.
    CATALOG_CACHE_TTL_MS: '500'
  });

  try {
    // 1. Repeat queries share one cache entry (case-insensitive key): the
    //    second request must be answered without a second upstream call.
    const first = await request(baseURL, '/api/search?q=Cache%20Probe');
    assert.strictEqual(first.statusCode, 200, 'The initial search should succeed while AniList is up');
    assert(first.body.some(anime => anime.id === 999010), 'The live fixture must be part of the first search answer');
    assert.strictEqual(
      first.headers['x-catalog-source'],
      'anilist',
      'A live search answer must be labelled as AniList data'
    );

    const repeat = await request(baseURL, '/api/search?q=cache%20probe');
    assert.strictEqual(repeat.statusCode, 200, 'A repeated query should still succeed');
    assert.deepStrictEqual(
      repeat.body,
      first.body,
      'A repeated search must be answered from cache with the identical body'
    );
    assert.strictEqual(searchCalls, 1, 'A repeated search must not trigger a second AniList call');

    const detailFirst = await request(baseURL, '/api/anime/999011');
    assert.strictEqual(detailFirst.statusCode, 200, 'The initial detail view should succeed');
    assert.strictEqual(
      detailFirst.headers['x-catalog-source'],
      'anilist',
      'A live detail answer must be labelled as AniList data'
    );

    const detailRepeat = await request(baseURL, '/api/anime/999011');
    assert.deepStrictEqual(
      detailRepeat.body,
      detailFirst.body,
      'A repeated detail view must be answered from cache with the identical body'
    );
    assert.strictEqual(detailCalls, 1, 'A repeated detail view must not trigger a second AniList call');

    // 2. Fail the upstream, then let the 500 ms cache entries expire (1.2 s).
    //    Both endpoints must now serve their stale copies.
    anilistUp = false;
    await new Promise(resolve => setTimeout(resolve, 1200));

    const staleSearch = await request(baseURL, '/api/search?q=Cache%20Probe');
    assert.strictEqual(staleSearch.statusCode, 200, 'A failed refresh must not break search after a successful load');
    assert.deepStrictEqual(
      staleSearch.body,
      first.body,
      'AniList failing after a successful search must serve the stale cached results, not an error or a curated-only body'
    );
    assert(staleSearch.body.some(anime => anime.id === 999010), 'The stale search answer must still carry the previously loaded fixture');
    assert.strictEqual(
      staleSearch.headers['x-catalog-source'],
      'anilist',
      'A stale search answer is still AniList data and must say so'
    );

    const staleDetail = await request(baseURL, '/api/anime/999011');
    assert.strictEqual(staleDetail.statusCode, 200, 'A failed refresh must not break the detail view after a successful load');
    assert.deepStrictEqual(
      staleDetail.body,
      detailFirst.body,
      'AniList failing after a successful detail load must serve the stale cached detail, not an error or a curated-only body'
    );
    assert.strictEqual(
      staleDetail.headers['x-catalog-source'],
      'anilist',
      'A stale detail answer is still AniList data and must say so'
    );

    // 3. Key isolation during the outage: an uncached query falls back to
    //    curated data — never to another key's stale body.
    const fallback = await request(baseURL, '/api/search?q=Uncached%20Probe');
    assert.strictEqual(fallback.statusCode, 200, 'An uncached query should still answer during an outage');
    assert(
      !fallback.body.some(anime => anime.id === 999010),
      "A failure must never serve another query's stale results"
    );
    assert.strictEqual(
      fallback.headers['x-catalog-source'],
      'local',
      'An uncached search fallback during an outage must be labelled as local data'
    );

    // 4. Fallbacks are never cached: upstream recovers, the same query goes
    //    live again instead of replaying the fallback answer.
    anilistUp = true;
    const recovered = await request(baseURL, '/api/search?q=Uncached%20Probe');
    assert(
      recovered.body.some(anime => anime.id === 999010),
      'A curated fallback must never be cached; the next request must retry AniList'
    );
    assert.strictEqual(
      recovered.headers['x-catalog-source'],
      'anilist',
      'A recovered search answer must be labelled as AniList data'
    );
    console.log('Search and detail caches serve repeats, stale copies on failure, and never cache fallbacks.');
  } finally {
    await stopServer(server);
    await mock.close();
  }
}

async function run() {
  const deadPort = await findClosedPort();
  const authServer = createAuthServer();
  await new Promise((resolve, reject) => {
    authServer.once('error', reject);
    authServer.listen(0, '127.0.0.1', resolve);
  });
  const mockAuthUrl = `http://127.0.0.1:${authServer.address().port}`;

  try {
    await runOutageAndHeaderScenario(deadPort, 3011);
    await runAccountVerificationScenario(mockAuthUrl, 3012);
    await runAccountDeletionScenario(mockAuthUrl, 3013);
    await runUnconfiguredScenario(3014);
    await runStreamProxySecurityScenario(3017);
    await runStaleCacheScenario(3015);
    await runSearchDetailCacheScenario(3016);
    console.log('All Phase 2 security and resilience tests passed.');
  } finally {
    if (typeof authServer.closeAllConnections === 'function') authServer.closeAllConnections();
    await new Promise(resolve => authServer.close(resolve));
  }
}

run().catch(error => {
  console.error('Security tests failed:', error.message);
  process.exitCode = 1;
});
