const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { createAniListMock } = require('./test-fixtures/anilist-mock');
const { normalizeBrowsePageMeta } = require('./catalog-filters');

const ROOT = __dirname;
const CACHE_PREFIX = 'anime-hub';
const STATIC_CACHE = `${CACHE_PREFIX}-static-v1`;
const API_CACHE = `${CACHE_PREFIX}-api-v1`;

function request(baseURL, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseURL}${pathname}`, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let parsed = body;
        try { parsed = JSON.parse(body); } catch { /* plain text is still inspectable */ }
        resolve({ statusCode: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    req.once('error', reject);
    req.end();
  });
}

function startApp(port, anilistURL) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ANIME_HUB_TEST_MODE: '1',
      PORT: String(port),
      SITE_URL: 'https://animehub.example',
      CORS_ORIGINS: `http://127.0.0.1:${port}`,
      ADMIN_KEY: 'test-admin-key-' + Date.now(),
      ANILIST_GRAPHQL_URL: anilistURL,
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: ''
    }
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { output.stderr += chunk.toString(); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output.stdout}`)), 10000);
    const check = () => {
      if (output.stdout.includes('Anime Hub API listening on https://animehub.example')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error(`server exited before startup: ${code}\n${output.stdout}\n${output.stderr}`));
      }
    });
  });
  return { child, ready, output };
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

function fixtureMedia() {
  return {
    id: 900001,
    title: { romaji: 'Fixture One', english: 'Fixture One', native: 'Fixture One' },
    coverImage: { large: 'https://example.test/fixture.jpg' },
    bannerImage: null,
    description: 'A deterministic fixture.',
    episodes: 12,
    status: 'FINISHED',
    averageScore: 80,
    genres: ['Action'],
    season: 'WINTER',
    seasonYear: 2024,
    format: 'TV',
    countryOfOrigin: 'JP',
    studios: { nodes: [] }
  };
}

async function assertAH01() {
  let providerCalls = 0;
  const mock = createAniListMock({
    port: 18990,
    handleRequest: ({ res, payload, jsonResponse }) => {
      providerCalls += 1;
      const query = String(payload.query || '');
      if (query.includes('GenreCollection')) {
        return jsonResponse(res, { data: { GenreCollection: ['Action'] } });
      }
      return jsonResponse(res, {
        data: {
          Page: {
            pageInfo: { total: 1, perPage: 30, currentPage: 1, lastPage: 1, hasNextPage: false },
            media: [fixtureMedia()]
          }
        }
      });
    }
  });
  await mock.start();
  const app = startApp(3131, mock.url);
  await app.ready;
  try {
    for (const pathname of ['/api/browse?page=51', '/api/browse?perPage=31', '/api/browse?genre=%3Cscript%3E']) {
      const response = await request('http://127.0.0.1:3131', pathname);
      assert.strictEqual(response.statusCode, 400, `${pathname} must be rejected before AniList`);
      assert.strictEqual(providerCalls, 0, `${pathname} must not call AniList`);
      assert.strictEqual(typeof response.body.message, 'string', `${pathname} needs a deterministic message`);
    }
    const valid = await request('http://127.0.0.1:3131', '/api/browse?page=1');
    assert.strictEqual(valid.statusCode, 200, 'A structurally valid browse request should reach AniList');
    assert(providerCalls > 0, 'A valid browse request should call AniList');
  } finally {
    await stopApp(app.child);
    await mock.close();
  }
}

async function assertAH02() {
  const normalized = normalizeBrowsePageMeta(
    { total: 500, perPage: 1, currentPage: 50, lastPage: 500, hasNextPage: true },
    { page: 50, perPage: 1, itemCount: 1, maxPage: 50 }
  );
  assert.strictEqual(normalized.totalPages, 50, 'Untrusted provider totals must be capped at page 50');
  assert.strictEqual(normalized.hasNext, false, 'Page 50 must never advertise a next page');

  const mock = createAniListMock({
    port: 18991,
    handleRequest: ({ res, payload, jsonResponse }) => {
      const variables = payload.variables || {};
      return jsonResponse(res, {
        data: {
          Page: {
            pageInfo: {
              total: 500,
              perPage: Number(variables.perPage || 30),
              currentPage: Number(variables.page || 1),
              lastPage: 500,
              hasNextPage: true
            },
            media: [fixtureMedia()]
          }
        }
      });
    }
  });
  await mock.start();
  const app = startApp(3132, mock.url);
  await app.ready;
  try {
    const last = await request('http://127.0.0.1:3132', '/api/browse?page=50&perPage=1');
    assert.strictEqual(last.statusCode, 200, 'The highest supported browse page should answer');
    assert.strictEqual(last.headers['x-catalog-total-pages'], '50');
    assert.strictEqual(last.headers['x-catalog-has-next'], 'false');
    const beyond = await request('http://127.0.0.1:3132', '/api/browse?page=51&perPage=1');
    assert.strictEqual(beyond.statusCode, 400, 'Page 51 must remain outside the API contract');
  } finally {
    await stopApp(app.child);
    await mock.close();
  }
}

async function assertCountryFiltering() {
  const mediaByCountry = {
    JP: { id: 101, title: { romaji: 'JP Anime', english: 'JP Anime' }, format: 'TV', countryOfOrigin: 'JP', genres: ['Action'], averageScore: 80, coverImage: { large: '' }, studios: { nodes: [] } },
    CN: { id: 102, title: { romaji: 'CN Donghua', english: 'CN Donghua' }, format: 'TV', countryOfOrigin: 'CN', genres: ['Action'], averageScore: 85, coverImage: { large: '' }, studios: { nodes: [] } },
    KR: { id: 103, title: { romaji: 'KR Animation', english: 'KR Animation' }, format: 'MOVIE', countryOfOrigin: 'KR', genres: ['Drama'], averageScore: 78, coverImage: { large: '' }, studios: { nodes: [] } },
    US: { id: 104, title: { romaji: 'US Animation', english: 'US Animation' }, format: 'MOVIE', countryOfOrigin: 'US', genres: ['Action'], averageScore: 82, coverImage: { large: '' }, studios: { nodes: [] } }
  };
  const mock = createAniListMock({
    port: 18992,
    handleRequest: ({ res, payload, jsonResponse }) => {
      const variables = payload.variables || {};
      const country = variables.countryOfOrigin;
      let media;
      if (country === 'CN') {
        media = [mediaByCountry.CN];
      } else if (country === 'KR') {
        media = [mediaByCountry.KR];
      } else if (country === 'US') {
        media = [mediaByCountry.US];
      } else {
        media = [mediaByCountry.JP];
      }
      return jsonResponse(res, {
        data: {
          Page: {
            pageInfo: { total: media.length, perPage: media.length, currentPage: 1, lastPage: 1, hasNextPage: false },
            media
          }
        }
      });
    }
  });
  await mock.start();
  const app = startApp(3135, mock.url);
  await app.ready;
  try {
    const cnResult = await request('http://127.0.0.1:3135', '/api/browse?countryOfOrigin=CN');
    assert.strictEqual(cnResult.statusCode, 200, 'CN country filter should return 200');
    assert(cnResult.body.every(item => item.countryOfOrigin === 'CN'), 'All results should be from China');
    assert(cnResult.body.some(item => item.anilistId === 102), 'CN Donghua should be present');

    const krResult = await request('http://127.0.0.1:3135', '/api/browse?countryOfOrigin=KR');
    assert.strictEqual(krResult.statusCode, 200, 'KR country filter should return 200');
    assert(krResult.body.every(item => item.countryOfOrigin === 'KR'), 'All results should be from Korea');

    const usResult = await request('http://127.0.0.1:3135', '/api/browse?countryOfOrigin=US');
    assert.strictEqual(usResult.statusCode, 200, 'US country filter should return 200');
    assert(usResult.body.every(item => item.countryOfOrigin === 'US'), 'All results should be from US');

    const jpResult = await request('http://127.0.0.1:3135', '/api/browse?countryOfOrigin=JP');
    assert.strictEqual(jpResult.statusCode, 200, 'JP country filter should return 200');
    assert(jpResult.body.every(item => item.countryOfOrigin === 'JP'), 'All results should be from Japan');

    const invalidResult = await request('http://127.0.0.1:3135', '/api/browse?countryOfOrigin=XX');
    assert.strictEqual(invalidResult.statusCode, 400, 'Invalid country code should return 400');

    const noFilterResult = await request('http://127.0.0.1:3135', '/api/browse');
    assert.strictEqual(noFilterResult.statusCode, 200, 'No country filter should return 200');
  } finally {
    await stopApp(app.child);
    await mock.close();
  }
}

async function assertAH04() {
  const mock = createAniListMock({
    port: 18992,
    handleRequest: ({ res, payload, jsonResponse }) => {
      const query = String(payload.query || '');
      if (query.includes('GenreCollection')) {
        return jsonResponse(res, { data: { GenreCollection: ['Action'] } });
      }
      if (query.includes('Page') && query.includes('media')) {
        return jsonResponse(res, { data: { Page: { media: { malformed: true } } } });
      }
      return jsonResponse(res, { data: { Page: { media: [] } } });
    }
  });
  await mock.start();
  const app = startApp(3133, mock.url);
  await app.ready;
  try {
    const malformedSearch = await request('http://127.0.0.1:3133', '/api/search?q=One%20Piece');
    assert.strictEqual(malformedSearch.statusCode, 200, 'Malformed provider data should use the safe search fallback');
    assert.strictEqual(malformedSearch.headers['x-catalog-source'], 'local', 'Malformed provider data must not be labelled AniList');
    assert(malformedSearch.body.some(item => String(item.title?.english || '').toLowerCase().includes('one piece')));

    const curatedGenre = await request('http://127.0.0.1:3133', '/api/genre/Shounen');
    assert.strictEqual(curatedGenre.statusCode, 200);
    assert.strictEqual(curatedGenre.headers['x-catalog-source'], 'curated');

    const repeatedType = await request('http://127.0.0.1:3133', '/api/genre/Action?type=series&type=movies');
    assert.strictEqual(repeatedType.statusCode, 400, 'Repeated genre type parameters must be rejected');
    assert.strictEqual(repeatedType.body.message, 'Genre type must be provided once.');
  } finally {
    await stopApp(app.child);
    await mock.close();
  }
}

async function assertLegacyCatalogSources() {
  const mock = createAniListMock({
    port: 18993,
    handleRequest: ({ res, jsonResponse }) => jsonResponse(res, {
      data: {
        Page: {
          media: [fixtureMedia()]
        }
      }
    })
  });
  await mock.start();
  const app = startApp(3134, mock.url);
  await app.ready;
  try {
    const routes = ['/api/trending', '/api/popular', '/api/movies', '/api/series'];
    const allowedSources = new Set(['anilist', 'curated', 'local']);
    for (const route of routes) {
      const response = await request('http://127.0.0.1:3134', route);
      assert.strictEqual(response.statusCode, 200, `${route} should return HTTP 200`);
      assert(Array.isArray(response.body), `${route} should return a catalog array`);
      const source = response.headers['x-catalog-source'];
      assert(allowedSources.has(source), `${route} should expose a recognized catalog source`);
      assert.strictEqual(source, 'anilist', `${route} should identify the live AniList response`);
    }
  } finally {
    await stopApp(app.child);
    await mock.close();
  }
}

// PWA / Service Worker offlinefallback assertions (Task P5.3).
async function assertPWAOffline() {
  // Verify the service worker file exists and references versioned cache names.
  // In Node test environment we validate the SW file content and cache config.
  const fs = require('fs');
  const swPath = path.join(ROOT, 'public', 'sw.js');
  const swContent = fs.readFileSync(swPath, 'utf8');

  // Check SW references versioned cache names.
  assert(swContent.includes(CACHE_PREFIX), `SW should reference cache prefix '${CACHE_PREFIX}'`);
  assert(swContent.includes(STATIC_CACHE), `SW should reference static cache '${STATIC_CACHE}'`);
  assert(swContent.includes(API_CACHE), `SW should reference API cache '${API_CACHE}'`);

  // Verify versioned cache invalidation logic in SW activate.
  assert(swContent.includes('CACHE_PREFIX'), 'SW should have CACHE_PREFIX for cache invalidation');
  assert(swContent.includes('caches.keys'), 'SW should have cache cleanup on activate');
  assert(swContent.includes('self.clients.claim'), 'SW should claim clients on activate');

  // Verify static asset precaching list is present and non-empty.
  assert(swContent.includes('STATIC_ASSETS'), 'SW should have STATIC_ASSETS precache list');
  assert(swContent.includes('/'), 'SW should precache root path');
  assert(swContent.includes('/index.html'), 'SW should precache index.html');
  assert(swContent.includes('/style.css'), 'SW should precache style.css');
  assert(swContent.includes('/script.js'), 'SW should precache script.js');

  console.log('PWA Service Worker configuration validated.');
}

async function run() {
  await assertAH01();
  await assertAH02();
  await assertCountryFiltering();
  await assertAH04();
  await assertLegacyCatalogSources();
  await assertPWAOffline();
  console.log('AH-01, AH-02, and AH-04 API regression tests passed.');
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
