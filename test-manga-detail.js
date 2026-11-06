/**
 * Manga detail endpoint regression tests.
 *
 * Verifies /api/manga/:id, /api/manhwa/:id, /api/manhua/:id endpoints:
 *   - Valid Japanese manga, Korean manhwa, Chinese/Taiwanese manhua details
 *   - Invalid and missing IDs
 *   - Provider failures and fallback behavior
 *   - Response consistency and correct content classification
 *   - No anime-only filtering for manga requests
 *
 * Uses a mock AniList GraphQL server; no production database or external
 * service is contacted.
 */

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const { createAniListMock } = require('./test-fixtures/anilist-mock');

const appPort = 3131;
const mockPort = 3132;
const baseUrl = `http://127.0.0.1:${appPort}`;

// Fixture media: Japanese manga, Korean manhwa, Chinese/Taiwanese manhua
const mediaByCountry = {
  JP: { id: 101, type: 'MANGA', countryOfOrigin: 'JP', title: { romaji: 'JP Manga', english: 'JP Manga' }, format: 'MANGA', chapters: 12, volumes: 2, genres: ['Action'], averageScore: 80, status: 'FINISHED', coverImage: { large: 'https://placehold.co/jp' }, authors: { edges: [] } },
  KR: { id: 102, type: 'MANGA', countryOfOrigin: 'KR', title: { romaji: 'KR Manhwa', english: 'KR Manhwa' }, format: 'MANGA', chapters: 20, volumes: 3, genres: ['Drama'], averageScore: 81, status: 'RELEASING', coverImage: { large: 'https://placehold.co/kr' }, authors: { edges: [] } },
  CN: { id: 103, type: 'MANGA', countryOfOrigin: 'CN', title: { romaji: 'CN Manhua', english: 'CN Manhua' }, format: 'MANGA', chapters: null, volumes: null, genres: ['Fantasy'], averageScore: 82, status: 'FINISHED', coverImage: { large: 'https://placehold.co/cn' }, authors: { edges: [] } },
  TW: { id: 104, type: 'MANGA', countryOfOrigin: 'TW', title: { romaji: 'TW Manhua', english: 'TW Manhua' }, format: 'MANGA', chapters: 9, volumes: 1, genres: ['Drama'], averageScore: 79, status: 'FINISHED', coverImage: { large: 'https://placehold.co/tw' }, authors: { edges: [] } },
};

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${pathname}`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        let parsed = body;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    req.on('error', reject);
  });
}

function waitForApp(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      console.error('DEBUG: timeout fired, output was:', JSON.stringify(output));
      reject(new Error(`AnimeHub did not start: ${output}`));
    }, 10000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      console.log('DEBUG: stdout data:', JSON.stringify(chunk.toString()));
      console.log('DEBUG: output.includes check:', output.includes('Anime Hub API listening on http://127.0.0.1:3131'));
      if (output.includes('Anime Hub API listening on http://127.0.0.1:3131')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', chunk => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`AnimeHub exited before startup: ${code}; output: ${output}`));
    });
  });
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise(resolve => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function run() {
  const mock = createAniListMock({
    port: mockPort,
    handleRequest: ({ req, res, payload, jsonResponse }) => {
      const variables = payload.variables || {};
      const countries = variables.countries || [];
      const requested = countries[0] === 'KR' ? mediaByCountry.KR : countries.includes('TW') ? mediaByCountry.CN : mediaByCountry.JP;
      const isDetail = /Media\(id:/.test(payload.query || '');
      const detailId = Number(variables.id);
      console.error('DEBUG: variables.id =', variables.id, 'detailId =', detailId, 'isDetail =', isDetail);

      let media;
      if (isDetail) {
        media = Object.values(mediaByCountry).find(item => item.id === Number(variables.id)) || null;
        console.error('DEBUG: media found for id', variables.id, ':', media ? media.id : null);
      } else {
        media = [requested];
      }

      if (payload.variables.search === 'graphql-error') {
        jsonResponse(res, { errors: [{ message: 'fixture failure' }] });
        return;
      }
      if (isDetail && detailId === 105) {
        jsonResponse(res, { errors: [{ message: 'fixture detail failure' }] });
        return;
      }
      if (isDetail && detailId === 106) {
        req.socket.destroy();
        return;
      }
      console.error('DEBUG: RPC returning data for id', variables.id, ':', JSON.stringify(media));
      jsonResponse(res, { data: { Media: media } });
    }
  });

  await mock.start();
  const app = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(appPort),
      SITE_URL: baseUrl,
      CORS_ORIGINS: baseUrl,
      ADMIN_KEY: 'test-admin-key-' + Date.now(),
      ANILIST_GRAPHQL_URL: mock.url,
      ANIME_HUB_TEST_MODE: '1',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForApp(app);

    // ---- Test 1: Valid Japanese manga detail via /api/manga/:id ----
    const jpDetail = await request('/api/manga/101');
    console.error('DEBUG: jpDetail.status:', jpDetail.status);
    console.error('DEBUG: jpDetail.body:', JSON.stringify(jpDetail.body));
    assert.strictEqual(jpDetail.status, 200, 'Japanese manga detail should return 200');
    assert.strictEqual(jpDetail.body.id, 101, 'Japanese manga detail should preserve ID');
    assert.strictEqual(jpDetail.body.anilistId, 101, 'Japanese manga detail should expose canonical AniList ID');
    assert.strictEqual(jpDetail.body.contentType, 'manga', 'Japanese manga detail should classify as manga');
    assert.strictEqual(jpDetail.body.countryOfOrigin, 'JP', 'Japanese manga detail should report countryOfOrigin JP');

    // ---- Test 2: Valid Korean manhwa detail via /api/manhwa/:id ----
    const krDetail = await request('/api/manhwa/102');
    assert.strictEqual(krDetail.status, 200, 'Korean manhwa detail should return 200');
    assert.strictEqual(krDetail.body.id, 102, 'Korean manhwa detail should preserve ID');
    assert.strictEqual(krDetail.body.anilistId, 102, 'Korean manhwa detail should expose canonical AniList ID');
    assert.strictEqual(krDetail.body.contentType, 'manhwa', 'Korean manhwa detail should classify as manhwa');
    assert.strictEqual(krDetail.body.countryOfOrigin, 'KR', 'Korean manhwa detail should report countryOfOrigin KR');

    // ---- Test 3: Valid Chinese manhua detail via /api/manhua/:id ----
    const cnDetail = await request('/api/manhua/103');
    assert.strictEqual(cnDetail.status, 200, 'Chinese manhua detail should return 200');
    assert.strictEqual(cnDetail.body.id, 103, 'Chinese manhua detail should preserve ID');
    assert.strictEqual(cnDetail.body.anilistId, 103, 'Chinese manhua detail should expose canonical AniList ID');
    assert.strictEqual(cnDetail.body.contentType, 'manhua', 'Chinese manhua detail should classify as manhua');
    assert.strictEqual(cnDetail.body.countryOfOrigin, 'CN', 'Chinese manhua detail should report countryOfOrigin CN');

    // ---- Test 4: Invalid ID ----
    const invalidId = await request('/api/manga/not-an-id');
    assert.strictEqual(invalidId.status, 400, 'Invalid manga ID should return 400');

    // ---- Test 5: Missing/nonexistent ID ----
    const missingDetail = await request('/api/manga/999999');
    assert.strictEqual(missingDetail.status, 404, 'Missing manga ID should return 404');
    assert.strictEqual(missingDetail.body.message, 'Manga not found.', 'Missing manga ID should return "Manga not found."');

    // ---- Test 6: Provider failure → 502 ----
    const providerFailure = await request('/api/manga/105');
    assert.strictEqual(providerFailure.status, 502, 'Provider failure should return 502');
    assert.strictEqual(providerFailure.body.message, 'Manga details are temporarily unavailable.', 'Provider failure should return documented message');

    // ---- Test 7: Network error → 502 ----
    const networkError = await request('/api/manga/106');
    assert.strictEqual(networkError.status, 502, 'Network error should return 502');
    assert.strictEqual(networkError.body.message, 'Manga details are temporarily unavailable.', 'Network error should return documented message');

    // ---- Test 8: Anime-only filtering - manga routes should not return anime ----
    const animeDetail = await request('/api/manga/101'); // 101 is JP manga, not anime
    assert.strictEqual(animeDetail.status, 200, 'Manga detail for manga ID should succeed');
    assert.strictEqual(animeDetail.body.contentType, 'manga', 'Manga detail should not be classified as anime');

    console.log('All manga detail endpoint tests passed.');
  } finally {
    await stopApp(app);
    await mock.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
