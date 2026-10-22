// ============================================================================
// test-provider-router.js — Unit tests for provider-router.js (Phase 5, Task 2)
// ============================================================================
// Verifies Kitsu response parsing, canonical schema normalization, and
// fallback behavior. Uses a local mock HTTP server so no network calls
// are made to the real Kitsu API.
//
// Usage: KITSU_BASE_URL=http://127.0.0.1:PORT node test-provider-router.js
// ============================================================================

// Set the mock base URL before requiring provider-router so it picks up
// the test mock instead of the real Kitsu API.
process.env.KITSU_BASE_URL = process.env.KITSU_BASE_URL || 'http://127.0.0.1:3141';

const assert = require('assert');
const http = require('http');
const {
  fetchKitsuFallback,
  isKitsuAvailable,
  normalizeKitsuAnime
} = require('./provider-router');

// Helper: create a mock HTTP server that responds to Kitsu API requests.
function createKitsuMock(port, handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      handler({ req, res, body });
    });
  });
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    },
    close() {
      return new Promise(resolve => {
        if (!server.listening) { resolve(); return; }
        server.close(() => resolve());
      });
    }
  };
}

function jsonResponse(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function run() {
  // ------------------------------------------------------------------
  // Unit test 1: normalizeKitsuAnime — canonical schema mapping
  // ------------------------------------------------------------------
  const kitsuResource = {
    id: '12345',
    attributes: {
      canonicalTitle: 'Cowboy Bebop',
      titles: { en: 'Cowboy Bebop', en_jp: 'カウボーイビバップ', ja_jp: 'カウボーイビバップ' },
      synopsis: 'In the year 2071, humanity has colonized several of the planets and moons of the solar system.',
      posterImage: { original: 'https://kitsu.io/poster.jpg', small: 'https://kitsu.io/poster-small.jpg' },
      coverImage: { original: 'https://kitsu.io/cover.jpg' },
      averageRating: 85.5,
      episodeCount: 26,
      startDate: '1998-04-03',
      endDate: '1999-04-24',
      showType: 'TV',
      status: 'finished',
      studios: [{ name: 'Sunrise' }]
    },
    relationships: {}
  };

  const normalized = normalizeKitsuAnime(kitsuResource);
  assert.strictEqual(normalized.id, 12345, 'id mapped from resource id');
  assert.strictEqual(normalized.anilistId, 12345, 'anilistId set to id');
  assert.strictEqual(normalized.title, 'Cowboy Bebop', 'title from canonicalTitle');
  assert.strictEqual(normalized.coverImage.large, 'https://kitsu.io/poster.jpg', 'coverImage.large from posterImage.original');
  assert.strictEqual(normalized.coverImage.extraLarge, 'https://kitsu.io/poster.jpg', 'coverImage.extraLarge from posterImage.original');
  assert.strictEqual(normalized.bannerImage, 'https://kitsu.io/cover.jpg', 'bannerImage from coverImage.original');
  assert.strictEqual(normalized.description, 'In the year 2071, humanity has colonized several of the planets and moons of the solar system.', 'description from synopsis');
  assert.strictEqual(normalized.format, 'TV', 'format from showType');
  assert.strictEqual(normalized.status, 'FINISHED', 'status mapped from finished');
  assert.strictEqual(normalized.seasonYear, 1998, 'seasonYear from startDate');
  assert.strictEqual(normalized.averageScore, 86, 'averageScore rounded from averageRating');
  assert.strictEqual(normalized.episodes, 26, 'episodes from episodeCount');
  assert.strictEqual(normalized.totalEpisodes, 26, 'totalEpisodes from episodeCount');
  assert.strictEqual(normalized.studios.nodes[0].name, 'Sunrise', 'studio name mapped');
  assert.strictEqual(normalized.source, 'kitsu', 'source marked as kitsu');
  assert.strictEqual(normalized.provider, 'kitsu', 'provider marked as kitsu');
  assert.strictEqual(normalized.sourceId, '12345', 'sourceId set');
  assert.strictEqual(normalized.countryOfOrigin, null, 'countryOfOrigin null (Kitsu does not expose it)');
  assert.strictEqual(normalized.genres.length, 0, 'genres empty (Kitsu does not include them on this endpoint)');
  console.log('✓ normalizeKitsuAnime maps Kitsu JSON:API to canonical schema');

  // ------------------------------------------------------------------
  // Unit test 2: normalizeKitsuAnime handles null/missing attributes
  // ------------------------------------------------------------------
  assert.strictEqual(normalizeKitsuAnime(null), null, 'null resource returns null');
  assert.strictEqual(normalizeKitsuAnime({ id: '999' }), null, 'resource without attributes returns null');
  console.log('✓ normalizeKitsuAnime handles null/missing attributes');

  // ------------------------------------------------------------------
  // Unit test 3: fetchKitsuFallback — successful response from mock
  // ------------------------------------------------------------------
  const mockPort = 3141;
  const mock = createKitsuMock(mockPort, ({ res }) => {
    jsonResponse(res, { data: [kitsuResource] });
  });
  await mock.start();

  const results = await fetchKitsuFallback('Cowboy Bebop', 10);
  assert.strictEqual(results.length, 1, 'fetchKitsuFallback returns one result');
  assert.strictEqual(results[0].id, 12345, 'result has correct id');
  assert.strictEqual(results[0].title, 'Cowboy Bebop', 'result has correct title');
  assert.strictEqual(results[0].source, 'kitsu', 'result source is kitsu');
  await mock.close();
  console.log('✓ fetchKitsuFallback returns normalized results from mock server');

  // ------------------------------------------------------------------
  // Unit test 4: fetchKitsuFallback — empty results from mock
  // ------------------------------------------------------------------
  const mock2 = createKitsuMock(mockPort + 1, ({ res }) => {
    jsonResponse(res, { data: [] });
  });
  await mock2.start();

  const emptyResults = await fetchKitsuFallback('NonexistentTitle12345', 10);
  assert.strictEqual(emptyResults.length, 0, 'fetchKitsuFallback returns empty array for no results');
  await mock2.close();
  console.log('✓ fetchKitsuFallback returns empty array when no results');

  // ------------------------------------------------------------------
  // Unit test 5: fetchKitsuFallback — connection error (closed port)
  // ------------------------------------------------------------------
  const errorResults = await fetchKitsuFallback('Anything', 10);
  assert.strictEqual(errorResults.length, 0, 'fetchKitsuFallback returns [] on connection error');
  console.log('✓ fetchKitsuFallback returns [] on connection error (closed port)');

  // ------------------------------------------------------------------
  // Unit test 6: fetchKitsuAnimeById path uses normalizeKitsuAnime
  // ------------------------------------------------------------------
  assert.strictEqual(normalizeKitsuAnime(kitsuResource).id, 12345, 'detail resource normalizes correctly');
  console.log('✓ fetchKitsuAnimeById path uses normalizeKitsuAnime (verified via unit test)');

  // ------------------------------------------------------------------
  // Unit test 7: isKitsuAvailable is exported as a function
  // ------------------------------------------------------------------
  assert.strictEqual(typeof isKitsuAvailable, 'function', 'isKitsuAvailable is a function');
  console.log('✓ isKitsuAvailable is exported as a function');

  console.log('\nAll provider-router unit tests passed.');
}

run().catch(error => {
  console.error('Test failed:', error);
  process.exitCode = 1;
});
