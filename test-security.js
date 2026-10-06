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
const { spawn } = require('child_process');
const path = require('path');

// Jujutsu Kaisen: a curated entry, so it has a local fallback while AniList is down.
const CURATED_ANILIST_ID = 113415;
// A syntactically valid AniList ID that exists neither live nor in curation.
const UNKNOWN_ANILIST_ID = 987654321;
const verifiedUserId = '01234567-89ab-cdef-0123-456789abcdef';
const ANON_KEY = 'test-public-anon-key';
const SERVICE_ROLE_KEY = 'test-server-only-service-role-key';
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
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY
  });

  try {
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
    assertSecurityHeaders(missing, '404 response');

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
    console.log('AniList outage falls back to curated data with honest status codes.');

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

    // Five attempts are allowed per window; the sixth must be throttled.
    for (let attempt = 0; attempt < 3; attempt += 1) {
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
    console.log('All Phase 2 security and resilience tests passed.');
  } finally {
    await new Promise(resolve => authServer.close(resolve));
  }
}

run().catch(error => {
  console.error('Security tests failed:', error.message);
  process.exitCode = 1;
});
