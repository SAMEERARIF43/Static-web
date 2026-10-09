const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const {
  mapLocalAnimeToAniList,
  rankAnimeSuggestions,
  searchAnimeLocal,
  searchAnimeLocalFuzzy
} = require('./search-utils');
const { mapAniListMediaToCatalogItem, mergeAniListCatalog, withCanonicalId } = require('./catalog-utils');
const {
  boundedCacheSet,
  browseCacheKey,
  buildCatalogGraphQL,
  filterCatalogLocally,
  normalizeStatus,
  parseBrowseFilters
} = require('./catalog-filters');

const TEST_PORT = process.env.TEST_PORT || 3001;
const baseURL = `http://localhost:${TEST_PORT}`;
const verifiedUserId = '01234567-89ab-cdef-0123-456789abcdef';
// The AniList IDs of the curated catalog, used to prove the catalog endpoints
// are served from live AniList data rather than from that curated list.
const CURATED_ANILIST_IDS = new Set([113415, 151807, 21, 101922, 16498, 20, 1535, 5114, 269, 101348, 9253, 11061]);
const authRequests = [];

function request(pathname, headers = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (body !== null) requestHeaders['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(`${baseURL}${pathname}`, { headers: requestHeaders, method }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const body = (res.headers['content-type'] || '').includes('application/json')
            ? JSON.parse(data)
            : data;
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        } catch {
          reject(new Error(`Request returned invalid JSON: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function search(query) {
  return request(`/api/search?q=${encodeURIComponent(query)}`);
}

function getTitle(anime) {
  if (typeof anime.title === 'string') return anime.title;
  return anime.title?.english || anime.title?.romaji || anime.title?.native || '';
}

function waitForServer(server) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Server did not start within 10 seconds.')), 10000);

    server.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes(`AnimeHub server listening on port ${TEST_PORT}.`)) {
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
}

/**
 * Unit checks for the pieces `/api/browse` shares with the catalog pipeline:
 * the query builder (GraphQL variables, pageInfo, unset-argument rules),
 * status normalization and the curated fallback filter.
 * Pure functions only — no server and no network.
 */
function assertSharedCatalogHelpers() {
  const genres = ['Action', 'Adventure', 'Sci-Fi', 'Drama', 'Comedy'];
  const options = { knownGenres: genres };

  const valid = parseBrowseFilters(
    {
      genre: 'Action,Adventure',
      year: '2026',
      season: 'summer',
      format: 'tv',
      status: 'releasing',
      minScore: '80',
      sort: 'score_desc',
      page: '3',
      perPage: '20'
    },
    options
  );
  assert.deepStrictEqual(valid.errors, [], 'A valid filter set should parse without errors');

  // Deduplication is case-insensitive and keeps the canonical AniList spelling.
  const dedupe = parseBrowseFilters({ genre: 'sci-fi,SCI-FI, Action' }, options);
  assert.deepStrictEqual(dedupe.filters.genres, ['Sci-Fi', 'Action'], 'Genres should dedupe and keep canonical casing');

  // The document binds values as variables; no user value is interpolated.
  const { query, variables } = buildCatalogGraphQL(valid.filters, { perPage: valid.perPage });
  assert(query.includes('$genre_in'), 'The genre filter must be a GraphQL variable');
  assert(query.includes('sort: $sort'), 'The sort must be a GraphQL variable');
  assert(!query.includes('Action'), 'No user-supplied genre may be interpolated into the document');
  assert(!query.includes('SCORE_DESC'), 'No user-supplied sort may be interpolated into the document');
  assert(query.includes('pageInfo'), 'The query must request pageInfo so pagination totals are real');
  assert(query.includes('hasNextPage'), 'The query must request hasNextPage');
  assert.deepStrictEqual(variables.sort, ['SCORE_DESC'], 'Sort should map to a whitelisted AniList enum list');
  assert.deepStrictEqual(variables.genre_in, ['Action', 'Adventure'], 'Genres should be bound as a variable');
  assert.strictEqual(variables.seasonYear, 2026, 'The year should be bound as a variable');
  assert.strictEqual(variables.minScore, 80, 'The minimum score should be bound as a variable');
  assert.strictEqual(variables.page, 3, 'The page should be bound as a variable');

  // Unset filters must be omitted: AniList rejects some null arguments
  // ("Illegal operator and value combination") and treats others as a filter.
  const bare = buildCatalogGraphQL(parseBrowseFilters({}, options).filters);
  assert(!bare.query.includes('averageScore_greater'), 'An unset minimum score must not be sent');
  assert(!bare.query.includes('genre_in'), 'An unset genre filter must not be sent');
  assert(!bare.query.includes('season: $season'), 'An unset season must not be sent');
  assert(!bare.query.includes('seasonYear: $seasonYear'), 'An unset year must not be sent');
  assert(!bare.query.includes('status: $status'), 'An unset status must not be sent');
  assert(!bare.query.includes('format: $format'), 'An unset format must not be sent');
  assert(!Object.hasOwn(bare.variables, 'minScore'), 'Unset variables must be omitted from the payload');
  assert(!Object.hasOwn(bare.variables, 'season'), 'Unset season variables must be omitted');
  assert.deepStrictEqual(bare.variables.sort, ['POPULARITY_DESC'], 'The default sort should be popularity');

  // Status normalization understands both AniList enums and curated labels.
  assert.strictEqual(normalizeStatus('RELEASING'), 'RELEASING');
  assert.strictEqual(normalizeStatus('Airing'), 'RELEASING');
  assert.strictEqual(normalizeStatus('Completed'), 'FINISHED');
  assert.strictEqual(normalizeStatus('not yet released'), 'NOT_YET_RELEASED');
  assert.strictEqual(normalizeStatus('bogus'), '');

  // Local fallback filtering mirrors the AniList query semantics.
  const items = [
    { id: 1, title: 'Alpha', genre: ['Action'], rating: 9.1, type: 'TV', year: 2024, status: 'Completed', season: 'SUMMER' },
    { id: 2, title: 'Beta', genre: ['Drama'], rating: 7.2, type: 'TV', year: 2019, status: 'Airing', season: 'FALL' },
    { id: 3, title: 'Gamma', genre: ['Action', 'Drama'], rating: 8.5, type: 'MOVIE', year: 2015, status: 'Upcoming', season: 'SUMMER' }
  ];
  const ids = (filters) => filterCatalogLocally(items, filters).map(item => item.id);
  assert.deepStrictEqual(ids({ genres: ['Action'] }), [1, 3], 'Genre filter should match any selected genre');
  assert.deepStrictEqual(ids({ genres: ['Drama'], format: 'MOVIE' }), [3], 'Format should narrow the genre match');
  assert.deepStrictEqual(ids({ status: 'RELEASING' }), [2], 'Status should match via the curated label');
  assert.deepStrictEqual(ids({ minScore: 85 }), [1, 3], 'Minimum score should use the 0-100 scale');
  assert.deepStrictEqual(ids({ season: 'SUMMER' }), [1, 3], 'Season should filter case-insensitively');
  assert.deepStrictEqual(ids({ year: 2024 }), [1], 'Year should filter exactly');
  assert.deepStrictEqual(ids({ sort: 'score' }), [1, 3, 2], 'Score sort should be descending');
  assert.deepStrictEqual(ids({ sort: 'newest' }), [1, 2, 3], 'Newest sort should be year descending');
  assert.deepStrictEqual(ids({ sort: 'title' }), [1, 2, 3], 'Title sort should be alphabetical');
  assert.deepStrictEqual(ids({ genres: ['Action'], sort: 'score' }), [1, 3], 'Filter and sort should compose');
  assert.deepStrictEqual(filterCatalogLocally(null, { genres: ['Action'] }), [], 'A missing list should filter to empty');
  console.log('Shared query builder, status normalization and local fallback verified.');
}

/**
 * Unit checks for the stricter `/api/browse` parser and its cache key.
 * Pure functions only — no server and no network.
 */
function assertBrowseFilterParsing() {
  const genres = ['Action', 'Adventure', 'Sci-Fi', 'Drama', 'Comedy'];
  const options = { knownGenres: genres };

  // ---- a complete, valid filter set ----
  const valid = parseBrowseFilters(
    {
      genre: 'Action,Adventure',
      year: '2026',
      season: 'spring',
      format: 'tv',
      status: 'releasing',
      minScore: '80',
      sort: 'score_desc',
      page: '3',
      perPage: '20'
    },
    options
  );
  assert.deepStrictEqual(valid.errors, [], 'A valid browse filter set should parse without errors');
  assert.deepStrictEqual(valid.filters.genres, ['Action', 'Adventure'], 'Multiple browse genres should be accepted');
  assert.strictEqual(valid.filters.year, 2026, 'A valid browse year should be accepted');
  assert.strictEqual(valid.filters.season, 'SPRING', 'Browse seasons should normalize to the AniList enum');
  assert.strictEqual(valid.filters.format, 'TV', 'Browse formats should normalize to the AniList enum');
  assert.strictEqual(valid.filters.status, 'RELEASING', 'Browse status should normalize to the AniList enum');
  assert.strictEqual(valid.filters.minScore, 80, 'A valid browse minimum score should be accepted');
  assert.strictEqual(valid.filters.sort, 'score', 'Browse sorts should map to the shared sort keys');
  assert.strictEqual(valid.filters.page, 3, 'A valid browse page should be accepted');
  assert.strictEqual(valid.perPage, 20, 'perPage should be parsed alongside the filters');

  // ---- defaults ----
  const empty = parseBrowseFilters({}, options);
  assert.deepStrictEqual(empty.errors, [], 'An empty browse query should be valid');
  assert.strictEqual(empty.filters.page, 1, 'The default browse page should be 1');
  assert.strictEqual(empty.perPage, 30, 'The default browse page size should be 30');
  assert.strictEqual(empty.filters.sort, 'popularity', 'The default browse sort should be POPULARITY_DESC');

  // ---- every allowlist or range violation is rejected with an explanation ----
  const rejected = [
    [{ genre: 'NotAGenre' }, /Unknown genre/],
    [{ genre: 'Hentai' }, /Unknown genre/], // adult genres are not in the allowlist
    [{ genre: 'Action,Hentai' }, /Unknown genre/],
    [{ season: 'MONSOON' }, /Season must be/],
    [{ format: 'HOLOGRAM' }, /Format must be/],
    [{ format: 'TV_SHORT' }, /Format must be/], // not in the browse allowlist
    [{ status: 'HIATUS' }, /Status must be/],
    [{ minScore: '101' }, /Minimum score/],
    [{ minScore: '-1' }, /Minimum score/],
    [{ minScore: 'high' }, /Minimum score/],
    [{ year: '1959' }, /Year must be/], // 1960 is the floor
    [{ year: 'soon' }, /Year must be/],
    [{ year: '99999999999999999999' }, /whole number/], // oversized numbers are not safe integers
    [{ sort: 'DROP_TABLE' }, /Sort must be/],
    [{ sort: 'score' }, /Sort must be/], // only the four enum spellings
    [{ page: '0' }, /Page must be/],
    [{ page: '51' }, /Page must be/],
    [{ page: 'abc' }, /Page must be/],
    [{ page: 'popular' }, /Page must be/], // the SPA route marker is not a page
    [{ perPage: '31' }, /perPage must be/],
    [{ perPage: '0' }, /perPage must be/],
    [{ perPage: 'lots' }, /perPage must be/],
    [{ genre: 'Action,<script>' }, /not allowed/],
    [{ genre: `Action,${'x'.repeat(51)}` }, /characters or fewer/],
    [{ genre: 'A,B,C,D,E,F,G,H,I,J,K' }, /at most/]
  ];
  for (const [query, expected] of rejected) {
    const result = parseBrowseFilters(query, options);
    assert(result.errors.length > 0, `Invalid browse input ${JSON.stringify(query)} should be rejected`);
    assert(
      expected.test(result.errors[0]),
      `Invalid browse input ${JSON.stringify(query)} should explain why, got: ${result.errors[0]}`
    );
  }

  // ---- repeated (array-valued) parameters are rejected, never truncated ----
  const repeated = [
    { year: ['2020', '2021'] },
    { page: ['1', '2'] },
    { sort: ['SCORE_DESC', 'TITLE_ROMAJI'] },
    { perPage: ['10', '20'] }
  ];
  for (const query of repeated) {
    const result = parseBrowseFilters(query, options);
    assert(result.errors.length > 0, `Repeated browse param ${JSON.stringify(query)} should be rejected`);
    assert(
      /must not be provided more than once/.test(result.errors[0]),
      `Repeated browse param ${JSON.stringify(query)} should say so, got: ${result.errors[0]}`
    );
  }
  // URLSearchParams exposes repeats through getAll().
  const repeatedUrl = parseBrowseFilters(new URLSearchParams('genre=Action&genre=Comedy'), options);
  assert(
    /must not be provided more than once/.test(repeatedUrl.errors[0] || ''),
    'Repeated URL parameters must be rejected'
  );

  // Unrelated parameter names stay ignored (the SPA query string shares the URL).
  const unrelated = parseBrowseFilters({ foo: 'bar', q: 'naruto' }, options);
  assert.deepStrictEqual(unrelated.errors, [], 'Unrelated browse parameters must be ignored');

  // ---- cache-key normalization ----
  const orderA = parseBrowseFilters({ genre: 'Comedy,Action', sort: 'POPULARITY_DESC', page: '2' }, options);
  const orderB = parseBrowseFilters({ genre: 'action,comedy', sort: 'popularity_desc', page: '2' }, options);
  assert.strictEqual(
    browseCacheKey(orderA.filters, orderA.perPage),
    browseCacheKey(orderB.filters, orderB.perPage),
    'Genre order and case must normalize to one cache entry'
  );
  const otherPage = parseBrowseFilters({ genre: 'comedy,action', page: '3' }, options);
  assert.notStrictEqual(
    browseCacheKey(orderB.filters, orderB.perPage),
    browseCacheKey(otherPage.filters, otherPage.perPage),
    'Different pages must not share a cache entry'
  );
  const otherSize = parseBrowseFilters({ genre: 'comedy,action', page: '2', perPage: '10' }, options);
  assert.notStrictEqual(
    browseCacheKey(orderB.filters, orderB.perPage),
    browseCacheKey(otherSize.filters, otherSize.perPage),
    'Different page sizes must not share a cache entry'
  );
  const extraFilter = parseBrowseFilters({ genre: 'comedy,action', page: '2', minScore: '80' }, options);
  assert.notStrictEqual(
    browseCacheKey(orderB.filters, orderB.perPage),
    browseCacheKey(extraFilter.filters, extraFilter.perPage),
    'An extra filter must not reuse the unfiltered cache entry'
  );

  // ---- cache limit: bounded insertion evicts the oldest entry (FIFO) ----
  // This is the exact helper `cacheBrowseQuery` delegates to in server.js,
  // so the browse cache's "max 100 entries, no unbounded growth" guarantee is
  // covered without booting the server.
  const bounded = new Map();
  for (let index = 0; index < 99; index += 1) {
    boundedCacheSet(bounded, `key-${index}`, index, 100);
    assert.strictEqual(bounded.size, index + 1, 'Inserts below the limit must not evict');
  }
  boundedCacheSet(bounded, 'key-99', 99, 100);
  assert.strictEqual(bounded.size, 100, 'The browse cache must hold exactly 100 entries at capacity');
  boundedCacheSet(bounded, 'key-100', 100, 100);
  assert.strictEqual(bounded.size, 100, 'Inserting past the limit must evict, not grow');
  assert(!bounded.has('key-0'), 'The oldest entry must be evicted first (FIFO)');
  assert(bounded.has('key-100'), 'The newest entry must be kept');

  // ---- the shared query builder still binds every value as a variable ----
  const { query, variables } = buildCatalogGraphQL(valid.filters, { perPage: valid.perPage });
  assert(query.includes('isAdult: false'), 'The browse query must exclude adult content');
  assert(query.includes('$genre_in'), 'The browse genre filter must be a GraphQL variable');
  assert(!query.includes('Action'), 'No user-supplied genre may be interpolated into the browse document');
  assert.deepStrictEqual(variables.sort, ['SCORE_DESC'], 'The browse sort should reach AniList as an enum variable');
  assert.strictEqual(variables.perPage, 20, 'The requested page size should be bound as a variable');
  assert.strictEqual(variables.page, 3, 'The requested page should be bound as a variable');

  console.log('Browse filter parsing, ranges, repeated params and cache-key normalization verified.');
}

async function run() {
  assertSharedCatalogHelpers();
  assertBrowseFilterParsing();

  const authServer = http.createServer((req, res) => {
    authRequests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/auth/v1/user') {
      res.end(JSON.stringify({ id: verifiedUserId }));
      return;
    }
    if (req.method === 'DELETE' && req.url === `/auth/v1/admin/users/${verifiedUserId}`) {
      res.end(JSON.stringify({ id: verifiedUserId }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'Not found' }));
  });
  await new Promise((resolve, reject) => {
    authServer.once('error', reject);
    authServer.listen(0, '127.0.0.1', resolve);
  });
  const authUrl = `http://127.0.0.1:${authServer.address().port}`;
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(TEST_PORT),
      SITE_URL: 'https://animehub.example',
      CORS_ORIGINS: `http://localhost:${TEST_PORT}`,
      SUPABASE_URL: authUrl,
      SUPABASE_ANON_KEY: 'test-public-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-server-only-service-role-key'
    }
  });

  try {
    await waitForServer(server);

    const onePiece = await search('One Piece');
    assert.strictEqual(onePiece.statusCode, 200, 'One Piece search should return HTTP 200');
    assert(Array.isArray(onePiece.body), 'One Piece search response should be an array');
    assert(onePiece.body.length > 0, 'One Piece search should return at least one result');
    assert(
      onePiece.body.some(anime => getTitle(anime).toLowerCase().includes('one piece')),
      'One Piece results should include a matching title'
    );

    const naruto = await search('Naruto');
    assert.strictEqual(naruto.statusCode, 200, 'Naruto search should return HTTP 200');
    assert(Array.isArray(naruto.body), 'Naruto search response should be an array');
    assert(naruto.body.length > 0, 'Naruto search should return at least one result');
    assert(
      naruto.body.some(anime => getTitle(anime).toLowerCase().includes('naruto')),
      'Naruto results should include Naruto'
    );

    const suggestions = await request('/api/search/suggestions?q=one');
    assert.strictEqual(suggestions.statusCode, 200, 'Autocomplete suggestions should return HTTP 200');
    assert(Array.isArray(suggestions.body), 'Autocomplete suggestions should return an array');
    assert(
      suggestions.body.some(anime => getTitle(anime).toLowerCase().includes('one piece')),
      'Autocomplete suggestions should include One Piece'
    );
    const firstPrefixMatch = suggestions.body.findIndex(anime => getTitle(anime).toLowerCase().startsWith('one'));
    const firstPartialMatch = suggestions.body.findIndex(anime => {
      const title = getTitle(anime).toLowerCase();
      return title.includes('one') && !title.startsWith('one');
    });
    const onePieceIndex = suggestions.body.findIndex(anime => getTitle(anime).toLowerCase().startsWith('one piece'));
    const otherPrefixIndex = suggestions.body.findIndex(anime => {
      const title = getTitle(anime).toLowerCase();
      return title.startsWith('one ') && !title.startsWith('one piece');
    });
    assert(firstPrefixMatch >= 0, 'Suggestions should include a title-prefix match');
    assert(onePieceIndex >= 0, 'Short queries should include the curated One Piece match');
    assert(
      firstPartialMatch < 0 || firstPrefixMatch < firstPartialMatch,
      'Title-prefix matches should precede partial title matches'
    );
    assert(
      otherPrefixIndex < 0 || onePieceIndex < otherPrefixIndex,
      'Curated title-prefix matches should appear ahead of unrelated AniList prefixes'
    );
    assert(
      !suggestions.body.some(anime => 'description' in anime || 'genres' in anime || 'studios' in anime),
      'Autocomplete suggestions should omit fields not needed by the dropdown'
    );

    const typoSuggestions = await request('/api/search/suggestions?q=one%20peice');
    assert.strictEqual(typoSuggestions.statusCode, 200, 'Typo-tolerant suggestions should return HTTP 200');
    assert(
      typoSuggestions.body.some(anime => getTitle(anime).toLowerCase().includes('one piece')),
      'A small title typo should still suggest One Piece'
    );
    const missingSuggestions = await request('/api/search/suggestions?q=anime%20that%20does%20not%20exist%20anywhere');
    assert.strictEqual(missingSuggestions.statusCode, 200, 'No matches should not be an API error');
    assert.deepStrictEqual(missingSuggestions.body, [], 'No matches should return an empty suggestions list');
    assert.strictEqual(
      (await request('/api/search/suggestions?q=a')).statusCode,
      400,
      'Autocomplete should reject queries shorter than two characters'
    );
    assert.strictEqual(
      (await request(`/api/search/suggestions?q=${'x'.repeat(101)}`)).statusCode,
      400,
      'Autocomplete should reject oversized queries'
    );

    const empty = await search('');
    assert.strictEqual(empty.statusCode, 400, 'Empty search should return HTTP 400');
    assert.strictEqual(empty.body.message, 'Enter an anime name of 1 to 100 characters.', 'Empty search should explain the validation error');

    const oversized = await search('x'.repeat(101));
    assert.strictEqual(oversized.statusCode, 400, 'Oversized search should return HTTP 400');

    const retiredPostSearch = await request('/api/anime/search', {}, 'POST', JSON.stringify({ query: 'Naruto' }));
    assert.strictEqual(retiredPostSearch.statusCode, 404, 'The unused POST search route should not be exposed');

    const robots = await request('/robots.txt');
    assert.strictEqual(robots.statusCode, 200, 'robots.txt should be available');
    assert(robots.body.includes('/sitemap.xml'), 'robots.txt should point to the sitemap');

    const sitemap = await request('/sitemap.xml');
    assert.strictEqual(sitemap.statusCode, 200, 'sitemap.xml should be available');
    assert(sitemap.body.includes('/privacy.html'), 'Sitemap should include the privacy page');
    assert(sitemap.body.includes('/dmca.html'), 'Sitemap should include the copyright page');
    for (const page of ['privacy.html', 'terms.html', 'contact.html', 'dmca.html']) {
      const legalPage = await request(`/${page}`);
      assert.strictEqual(legalPage.statusCode, 200, `${page} should be available`);
      assert(legalPage.body.includes('<title>'), `${page} should include a page title`);
      assert(legalPage.body.includes('name="description"'), `${page} should include a meta description`);
      assert(legalPage.body.includes('property="og:title"'), `${page} should include Open Graph title`);
      assert(legalPage.body.includes('name="twitter:card"'), `${page} should include Twitter card`);
      assert(legalPage.body.includes('application/ld+json'), `${page} should include Schema.org JSON-LD`);
      assert(
        legalPage.body.includes('does not host') || legalPage.body.includes('discovery catalog'),
        `${page} should state that AnimeHub is a discovery catalog / does not host videos`
      );
    }

    const homePage = await request('/');
    assert.strictEqual(homePage.statusCode, 200, 'Home page should load with 200');
    assert(homePage.body.includes('<title>AnimeHub'), 'Home page should have AnimeHub title');
    assert(homePage.body.includes('property="og:site_name"'), 'Home page should have og:site_name');
    assert(homePage.body.includes('<link rel="canonical" href="https://animehub.example/">'), 'Canonical URL should use the configured origin');
    assert(homePage.body.includes('<meta property="og:image" content="https://animehub.example/social-preview.jpg">'), 'Open Graph image URL should be absolute');
    assert(homePage.body.includes('<meta name="twitter:image" content="https://animehub.example/social-preview.jpg">'), 'Twitter image URL should be absolute');
    assert(!homePage.body.includes('__SITE_URL__'), 'Site URL template values should be rendered');
    assert(homePage.body.includes('application/ld+json'), 'Home page should have Schema.org WebSite JSON-LD');
    assert(!homePage.body.includes('4K Ultra HD'), 'Home page should not claim 4K streaming capability');
    assert(!homePage.body.includes('data-nav="account"'), 'Catalog should not include account navigation');
    assert(!homePage.body.includes('page-account'), 'Catalog should not include account or signup forms');

    // ---- strict browse endpoint: filters, sort and Load more paging ----
    const browseFirst = await request('/api/browse?sort=POPULARITY_DESC');
    assert.strictEqual(browseFirst.statusCode, 200, 'The browse endpoint should answer');
    assert(Array.isArray(browseFirst.body), 'The browse endpoint should return a list');
    assert(browseFirst.body.length > 0, 'The browse endpoint should return titles');
    assert(browseFirst.body.every(anime => anime.id === anime.anilistId), 'Browse entries must keep the canonical id');
    assert.strictEqual(
      new Set(browseFirst.body.map(anime => anime.id)).size,
      browseFirst.body.length,
      'A browse page must not repeat a title'
    );
    assert.strictEqual(browseFirst.headers['x-catalog-source'], 'anilist', 'Browse should report the live source');
    assert.strictEqual(browseFirst.headers['x-catalog-page'], '1', 'Browse should report pageInfo.currentPage');
    assert.strictEqual(browseFirst.headers['x-catalog-per-page'], '30', 'Browse should default to 30 per page');
    assert.strictEqual(browseFirst.headers['x-catalog-has-next'], 'true', 'A full browse page should have a next page');
    assert(
      Number.parseInt(browseFirst.headers['x-catalog-total'], 10) > browseFirst.body.length,
      'The browse total should exceed a single page'
    );
    assert.strictEqual(
      browseFirst.headers['ratelimit-policy'],
      '60;w=60',
      'Browse should carry the AniList-proxy rate limit like /api/search'
    );

    // Load more: page 2 continues page 1 without repeating titles.
    const browseSecond = await request('/api/browse?sort=POPULARITY_DESC&page=2');
    assert.strictEqual(browseSecond.statusCode, 200, 'A second browse page should answer');
    assert.strictEqual(browseSecond.headers['x-catalog-page'], '2', 'The second browse page number should be reported');
    assert(browseSecond.body.length > 0, 'The second browse page should return titles');
    const browseFirstIds = new Set(browseFirst.body.map(anime => anime.id));
    assert(
      browseSecond.body.every(anime => !browseFirstIds.has(anime.id)),
      'Browse page 2 must not repeat a title from page 1'
    );

    // perPage is honored up to its cap of 30.
    const smallPage = await request('/api/browse?perPage=10&sort=SCORE_DESC');
    assert.strictEqual(smallPage.statusCode, 200, 'A smaller page size should be accepted');
    assert(smallPage.body.length > 0 && smallPage.body.length <= 10, 'perPage=10 should return at most 10 titles');
    assert.strictEqual(smallPage.headers['x-catalog-per-page'], '10', 'The requested page size should be reported');

    // Valid filters are enforced by AniList.
    const browseMovies = await request('/api/browse?format=MOVIE&perPage=10');
    assert.strictEqual(browseMovies.statusCode, 200, 'A browse format filter should be accepted');
    assert(browseMovies.body.length > 0, 'The film filter should return titles');
    assert(
      browseMovies.body.every(anime => String(anime.type || anime.format || '').toUpperCase() === 'MOVIE'),
      'Browse must return only films for format=MOVIE'
    );

    const browseYear = await request('/api/browse?year=2024&perPage=10&sort=START_DATE_DESC');
    assert.strictEqual(browseYear.statusCode, 200, 'A browse year filter should be accepted');
    assert(browseYear.body.length > 0, 'The year filter should return titles');
    assert(
      browseYear.body.every(anime => anime.year === 2024),
      'Every browse title should carry the requested release year'
    );

    // ---- invalid browse parameters are rejected, never coerced ----
    const invalidBrowseQueries = [
      'genre=NotARealGenre',
      'genre=Hentai',
      'genre=%3Cscript%3E',
      'format=HOLOGRAM',
      'format=TV_SHORT',
      'status=HIATUS',
      'minScore=101',
      'year=1959',
      'sort=DROP_TABLE',
      'page=51',
      'page=popular',
      'perPage=31',
      'year=2020&year=2021'
    ];
    for (const query of invalidBrowseQueries) {
      const invalid = await request(`/api/browse?${query}`);
      assert.strictEqual(invalid.statusCode, 400, `Invalid browse filter "${query}" must be rejected`);
      assert.strictEqual(typeof invalid.body.message, 'string', `Invalid "${query}" must explain the error`);
      assert(
        !/ECONNREFUSED|127\.0\.0\.1|stack/i.test(JSON.stringify(invalid.body)),
        `Invalid "${query}" must not leak upstream details`
      );
    }

    // Cache normalization: differently spelled but equivalent requests are
    // served as the same entry — same bodies and same metadata.
    const normalizedA = await request('/api/browse?genre=Comedy,Action&sort=POPULARITY_DESC&perPage=10');
    const normalizedB = await request('/api/browse?genre=action,comedy&sort=popularity_desc&perPage=10');
    assert.strictEqual(normalizedA.statusCode, 200, 'The first normalized browse request should answer');
    assert.strictEqual(normalizedB.statusCode, 200, 'The second normalized browse request should answer');
    assert.deepStrictEqual(normalizedB.body, normalizedA.body, 'Equivalent browse requests must return the same page');
    assert.strictEqual(
      normalizedB.headers['x-catalog-total'],
      normalizedA.headers['x-catalog-total'],
      'Equivalent browse requests must report the same total'
    );

    // The top of the allowed page window answers honestly (200 + list).
    const browseFar = await request('/api/browse?page=50');
    assert.strictEqual(browseFar.statusCode, 200, 'Page 50 is within the allowed window');
    assert(Array.isArray(browseFar.body), 'An out-of-range-window browse page should still return a list');

    const health = await request('/api/health');
    assert.strictEqual(health.statusCode, 200, 'Health check should return HTTP 200');
    assert.deepStrictEqual(health.body, { status: 'ok' }, 'Health check should expose only its status');
    assert.strictEqual(health.headers['cache-control'], 'no-store', 'Health check responses should not be cached');

    for (const asset of ['/style.css', '/script.js', '/websites%20picture.webp']) {
      const response = await request(asset);
      assert.strictEqual(response.statusCode, 200, `${asset} should be served`);
    }

    const protectedPath = await request('/server.js');
    assert.strictEqual(protectedPath.statusCode, 404, 'Project source must not be served as a static asset');

    const securityHeaders = await request('/');
    assert.strictEqual(securityHeaders.statusCode, 200, 'Catalog home page should load');
    assert.strictEqual(securityHeaders.headers['x-content-type-options'], 'nosniff');
    assert(securityHeaders.headers['content-security-policy'], 'Content Security Policy should remain enabled');

    const siteConfig = await request('/api/site-config');
    assert.strictEqual(siteConfig.statusCode, 200, 'Public site configuration should load');
    assert.strictEqual(siteConfig.body.siteUrl, 'https://animehub.example', 'Public site configuration should expose the canonical origin');
    assert(!Object.hasOwn(siteConfig.body, 'supabaseUrl'), 'Site configuration should not expose Supabase settings');
    assert(!Object.hasOwn(siteConfig.body, 'supabaseAnonKey'), 'Site configuration should not expose Supabase keys');

    const authConfig = await request('/api/config');
    assert.strictEqual(authConfig.statusCode, 200, 'Public Supabase configuration should load');
    assert.deepStrictEqual(
      Object.keys(authConfig.body).sort(),
      ['SUPABASE_ANON_KEY', 'SUPABASE_URL'],
      '/api/config should expose only public Supabase configuration'
    );
    assert.strictEqual(authConfig.headers['cache-control'], 'no-store');

    const unauthenticatedDeletion = await request('/api/account', {}, 'DELETE');
    assert.strictEqual(unauthenticatedDeletion.statusCode, 401, 'Account deletion must require authentication');
    assert.strictEqual(authRequests.length, 0, 'Unauthenticated deletion must not contact Supabase');

    const authenticatedDeletion = await request(
      '/api/account',
      { Authorization: 'Bearer test-access-token', 'Content-Type': 'application/json' },
      'DELETE',
      JSON.stringify({ user_id: 'fedcba98-7654-3210-fedc-ba9876543210' })
    );
    assert.strictEqual(
      authenticatedDeletion.statusCode,
      200,
      `Authenticated account deletion should succeed: ${JSON.stringify(authenticatedDeletion.body)}; auth requests: ${authRequests.length}`
    );
    assert.strictEqual(authRequests.length, 2, 'Deletion must verify the token then call the Admin API');
    assert.strictEqual(authRequests[0].url, '/auth/v1/user', 'The access token should be verified through Supabase Auth');
    assert.strictEqual(authRequests[0].headers.authorization, 'Bearer test-access-token');
    assert.strictEqual(authRequests[0].headers.apikey, 'test-public-anon-key');
    assert.strictEqual(
      authRequests[1].url,
      `/auth/v1/admin/users/${verifiedUserId}`,
      'The Admin API target must come from the verified user, not the supplied user_id'
    );
    assert.strictEqual(authRequests[1].headers.apikey, 'test-server-only-service-role-key');
    assert.strictEqual(authRequests[1].headers.authorization, 'Bearer test-server-only-service-role-key');
    assert(!JSON.stringify(authenticatedDeletion.body).includes('service-role'));

    const localWatchlistScript = await request('/script.js');
    assert(localWatchlistScript.body.includes("localStorage.getItem('anime_hub_watchlist')"), 'Watchlist should remain browser-local');
    assert(!localWatchlistScript.body.includes("localStorage.removeItem('anime_hub_continue_watching')"), 'Existing continue-watching data should not be cleared');
    assert(localWatchlistScript.body.includes("searchFilterForm?.addEventListener('change', applySearchFilters)"), 'Search filters and sorting should update results when changed');
    assert(localWatchlistScript.body.includes("searchFilterForm?.addEventListener('reset'"), 'Search filters should reapply after reset');
    assert(localWatchlistScript.body.includes('if (requestId !== searchRequestId) return;'), 'Outdated search responses should not replace newer results');
    assert(localWatchlistScript.body.includes('/search/suggestions?q='), 'Autocomplete should use the lightweight suggestions endpoint');
    assert(localWatchlistScript.body.includes('}, 180);'), 'Autocomplete should debounce requests by 180 milliseconds');
    assert(localWatchlistScript.body.includes('new AbortController()'), 'Autocomplete should cancel obsolete requests');
    assert(localWatchlistScript.body.includes('requestId !== state.requestId'), 'Stale autocomplete responses should be ignored');
    assert(localWatchlistScript.body.includes("event.key === 'ArrowDown' || event.key === 'ArrowUp'"), 'Autocomplete should retain arrow-key navigation');
    assert(localWatchlistScript.body.includes("event.key === 'Escape' && !panel.hidden"), 'Autocomplete should retain Escape behavior');
    assert(localWatchlistScript.body.includes('No anime found.'), 'Empty autocomplete results should use a non-technical message');
    assert(localWatchlistScript.body.includes('banner: r.bannerImage || r.coverImage?.large'), 'Recommendation cards should preserve banner or poster fallback data');
    assert(localWatchlistScript.body.includes('safeImageUrl(bannerUrl || poster)'), 'Detail banners should fall back to the anime poster');
    assert(localWatchlistScript.body.includes("image.hidden = true"), 'Failed fallback images should not show broken-image icons');
    assert(localWatchlistScript.body.includes("link[rel=\"canonical\"]"), 'Dynamic SEO updates should update the canonical URL');
    assert(localWatchlistScript.body.includes("replace(/\"/g, '&quot;')"), 'Catalog text should escape double quotes in attributes');

    const forbiddenOrigin = await request('/api/site-config', { Origin: 'https://not-allowed.example' });
    assert.strictEqual(forbiddenOrigin.statusCode, 403, 'Unconfigured cross-origin requests should be rejected');
    console.log('Expected CORS rejection: unconfigured origin returned HTTP 403.');

    const allowedOrigin = await request('/api/site-config', { Origin: `http://localhost:${TEST_PORT}` });
    assert.strictEqual(allowedOrigin.statusCode, 200, 'Configured same-site cross-origin requests should succeed');
    assert.strictEqual(
      allowedOrigin.headers['access-control-allow-origin'],
      `http://localhost:${TEST_PORT}`,
      'Configured origins should receive the matching CORS allow-origin header'
    );
    console.log('Allowed CORS origin: configured origin returned HTTP 200.');

    // ---- Catalog identity: the AniList ID is the only anime ID exposed ----
    const trending = await request('/api/trending');
    assert.strictEqual(trending.statusCode, 200, 'Trending catalog should load');
    assert(Array.isArray(trending.body), 'Trending catalog should return an array');
    assert(trending.body.length >= 5, 'Trending catalog should return several titles');
    assert(
      trending.body.every(anime => anime.id === anime.anilistId),
      'Trending entries should expose the canonical AniList ID as their only ID'
    );
    assert.strictEqual(
      new Set(trending.body.map(anime => anime.anilistId)).size,
      trending.body.length,
      'Trending catalog should not contain duplicate AniList IDs'
    );
    assert(
      trending.body.some(anime => !CURATED_ANILIST_IDS.has(anime.anilistId)),
      'Trending must be computed from live AniList data, not from the curated slice'
    );

    const popular = await request('/api/popular');
    assert.strictEqual(popular.statusCode, 200, 'Expanded popular catalog should load');
    assert(Array.isArray(popular.body), 'Popular catalog should return an array');
    assert(popular.body.length >= 12, 'Popular catalog should retain the curated titles');
    assert(
      popular.body.every(anime => Number.isInteger(anime.anilistId) && anime.anilistId > 0),
      'Every popular catalog entry should have an AniList detail ID'
    );
    assert(
      popular.body.every(anime => anime.id === anime.anilistId),
      'Popular entries should expose the canonical AniList ID as their only ID'
    );
    assert.strictEqual(
      new Set(popular.body.map(anime => anime.anilistId)).size,
      popular.body.length,
      'Popular catalog should not contain duplicate AniList IDs'
    );
    const jujutsuKaisen = popular.body.find(anime => anime.anilistId === 113415);
    assert(jujutsuKaisen, 'Popular catalog should include the curated Jujutsu Kaisen entry');
    assert.strictEqual(jujutsuKaisen.studio, 'MAPPA', 'Catalog entries should include studio metadata');
    assert.strictEqual(jujutsuKaisen.language, 'Japanese', 'Catalog entries should include language metadata');

    // ---- Movies and TV series are separate live catalogs ----
    const movies = await request('/api/movies');
    assert.strictEqual(movies.statusCode, 200, 'Movies catalog should load');
    assert(movies.body.length > 0, 'Movies catalog should return films');
    assert(
      movies.body.every(anime => String(anime.type || anime.format).toUpperCase() === 'MOVIE'),
      'Movies catalog must contain only films'
    );
    assert(
      movies.body.every(anime => anime.id === anime.anilistId),
      'Movie entries should use the canonical AniList ID'
    );

    const series = await request('/api/series');
    assert.strictEqual(series.statusCode, 200, 'TV series catalog should load');
    assert(series.body.length > 0, 'TV series catalog should return titles');
    assert(
      series.body.every(anime => ['TV', 'TV_SHORT'].includes(String(anime.type || anime.format).toUpperCase())),
      'TV series catalog must not contain films'
    );

    // ---- Genre filtering is served from the live catalog ----
    const comedy = await request('/api/genre/Comedy');
    assert.strictEqual(comedy.statusCode, 200, 'Genre filtering should load');
    assert(comedy.body.length > 0, 'The Comedy genre must not be empty');
    assert(
      comedy.body.every(anime => (anime.genre || anime.genres || []).includes('Comedy')),
      'Every genre result should actually carry the requested genre'
    );
    assert(
      comedy.body.every(anime => anime.id === anime.anilistId),
      'Genre results should use the canonical AniList ID'
    );

    const comedySeries = await request('/api/genre/Comedy?type=series');
    assert.strictEqual(comedySeries.statusCode, 200, 'Genre filtering by format should load');
    assert(comedySeries.body.length > 0, 'Comedy TV series should not be empty');
    assert(
      comedySeries.body.every(anime => ['TV', 'TV_SHORT'].includes(String(anime.type || anime.format).toUpperCase())),
      'Genre filtering on the TV Series page must not return films'
    );

    const curatedGenre = await request('/api/genre/Shounen');
    assert.strictEqual(curatedGenre.statusCode, 200, 'Curated-only genres should still load');
    assert(curatedGenre.body.length > 0, 'The curated Shounen genre should still return titles');

    const unknownGenre = await request('/api/genre/DefinitelyNotAGenre');
    assert.strictEqual(unknownGenre.statusCode, 200, 'An unknown genre should not error');
    assert.deepStrictEqual(unknownGenre.body, [], 'An unknown genre should return no titles');

    const adultGenre = await request('/api/genre/Hentai');
    assert.deepStrictEqual(adultGenre.body, [], 'A non-adult catalog must not serve adult genres');

    const genres = await request('/api/genres');
    assert.strictEqual(genres.statusCode, 200, 'Genre list should load');
    assert(genres.body.length > 0, 'Genre list should return genres');
    assert(genres.body.includes('Comedy'), 'Genre list should include live AniList genres');
    assert(
      !genres.body.some(genre => String(genre).toLowerCase() === 'hentai'),
      'Genre list should not offer adult genres'
    );

    // ---- The retired local-id detail route redirects to AniList IDs ----
    const retiredLocalDetail = await request('/api/detail/1');
    assert.strictEqual(retiredLocalDetail.statusCode, 308, 'The retired local-id route should redirect permanently');
    assert.strictEqual(
      retiredLocalDetail.headers.location,
      '/api/anime/1',
      'The retired route should redirect to the canonical AniList route'
    );

    const canonicalDetail = await request('/api/anime/1');
    assert.strictEqual(canonicalDetail.statusCode, 200, 'AniList detail should load for ID 1');
    assert.strictEqual(canonicalDetail.body.id, 1, 'Detail responses should use the canonical AniList ID');
    assert(
      getTitle(canonicalDetail.body).toLowerCase().includes('cowboy bebop'),
      'AniList ID 1 must resolve to Cowboy Bebop, not the retired local ID 1 entry'
    );
    const recommendedMedia = canonicalDetail.body.recommendations?.edges
      ?.map(edge => edge.node?.mediaRecommendation)
      .find(Boolean);
    if (recommendedMedia) {
      assert(
        Object.prototype.hasOwnProperty.call(recommendedMedia, 'bannerImage'),
        'Recommendation responses should preserve the AniList banner field'
      );
    }

    const highCatalogDetail = await request('/api/anime/206949');
    assert.strictEqual(highCatalogDetail.statusCode, 200, 'A valid AniList ID above 100,000 should load');
    assert.strictEqual(highCatalogDetail.body.id, 206949, 'High AniList detail responses should preserve their canonical ID');

    const malformedAnimeId = await request('/api/anime/not-an-id');
    assert.strictEqual(malformedAnimeId.statusCode, 400, 'A malformed AniList ID should be rejected');

    const outOfRangeAnimeId = await request('/api/anime/2147483648');
    assert.strictEqual(outOfRangeAnimeId.statusCode, 400, 'An AniList ID outside the GraphQL Int range should be rejected');

    const malformedDetail = await request('/api/detail/not-an-id');
    assert.strictEqual(malformedDetail.statusCode, 404, 'A malformed detail id should still return 404');

    const localTitle = {
      id: 23,
      anilistId: 123,
      title: 'Sample Fantasy',
      genre: ['Fantasy'],
      poster: 'https://example.com/poster.jpg',
      banner: 'https://example.com/banner.jpg',
      rating: 8.4,
      year: 2024,
      studio: 'Sample Studio',
      language: 'Japanese',
      type: 'TV'
    };
    const mediaFixture = {
      id: 12345,
      title: { english: 'Sample Adventure', romaji: 'Sample Adventure', native: 'サンプル' },
      coverImage: { large: 'https://example.com/cover.jpg', extraLarge: 'https://example.com/cover-large.jpg' },
      bannerImage: 'https://example.com/banner.jpg',
      description: '<b>A new adventure.</b>',
      episodes: 12,
      status: 'RELEASING',
      averageScore: 84,
      genres: ['Adventure', 'Fantasy'],
      seasonYear: null,
      startDate: { year: 2024 },
      format: 'TV',
      countryOfOrigin: 'JP',
      studios: { nodes: [{ name: 'Sample Studio' }] }
    };
    const mappedMedia = mapAniListMediaToCatalogItem(mediaFixture);
    assert.strictEqual(mappedMedia.anilistId, mediaFixture.id, 'AniList entries should carry their detail ID');
    assert.strictEqual(mappedMedia.year, 2024, 'Catalog mapping should use the start year when no season year exists');
    assert.strictEqual(mappedMedia.rating, 8.4, 'Catalog scores should be normalized to the existing 10-point scale');
    assert.strictEqual(mappedMedia.status, 'Airing', 'AniList status should be made human-readable');
    assert.strictEqual(mappedMedia.studio, 'Sample Studio', 'Catalog mapping should include the main studio');
    assert.strictEqual(mappedMedia.language, 'Japanese', 'Catalog mapping should include the language');
    assert.strictEqual(mappedMedia.banner, mediaFixture.bannerImage, 'Catalog mapping should preserve the AniList banner');
    const mergedCatalog = mergeAniListCatalog([localTitle], [mediaFixture, {
      id: null,
      title: { english: 'Malformed entry' }
    }, {
      ...mediaFixture,
      id: localTitle.anilistId,
      title: { english: 'AniList version', romaji: 'AniList version' }
    }]);
    assert.strictEqual(mergedCatalog.length, 2, 'Merging should preserve unique AniList entries');
    assert.strictEqual(
      mergedCatalog[1].title,
      'AniList version',
      'Live AniList titles should win over the local copy'
    );
    assert.strictEqual(mergedCatalog.length, 2, 'Malformed AniList entries should be skipped without discarding valid entries');

    // ---- Merge policy: live AniList wins for volatile factual metadata ----
    const staleLocalTitle = {
      id: 77,
      anilistId: 4242,
      title: 'Stale Local Title',
      genre: ['Action'],
      year: 1999,
      rating: 5.5,
      episodes: 999,
      type: 'TV',
      studio: 'Stale Studio',
      language: 'Japanese',
      status: 'Hiatus',
      poster: 'https://example.com/local-poster.jpg',
      image: 'https://example.com/local-poster.jpg',
      banner: 'https://example.com/local-banner.jpg',
      description: 'Stale local description.',
      editorialBadge: 'Staff pick'
    };
    const liveMedia = {
      id: 4242,
      title: { english: 'Live Title', romaji: 'Live Title', native: null },
      coverImage: { large: 'https://example.com/live.jpg' },
      bannerImage: 'https://example.com/live-banner.jpg',
      description: 'Live description.',
      episodes: 12,
      status: 'RELEASING',
      averageScore: 88,
      genres: ['Action', 'Drama'],
      seasonYear: 2024,
      startDate: { year: 2024 },
      format: 'TV',
      countryOfOrigin: 'JP',
      studios: { nodes: [{ name: 'Live Studio' }] }
    };
    const liveEntry = mergeAniListCatalog([staleLocalTitle], [liveMedia])[0];
    assert.strictEqual(liveEntry.episodes, 12, 'AniList episode count should override the stale local value');
    assert.strictEqual(liveEntry.studio, 'Live Studio', 'AniList studio should override the stale local value');
    assert.strictEqual(liveEntry.status, 'Airing', 'AniList airing status should override the stale local value');
    assert.strictEqual(liveEntry.title, 'Live Title', 'AniList title should override the stale local title');
    assert.strictEqual(liveEntry.year, 2024, 'AniList season year should override the stale local year');
    assert.strictEqual(liveEntry.rating, 8.8, 'AniList score should override the stale local rating');
    assert.deepStrictEqual(liveEntry.genre, ['Action', 'Drama'], 'AniList genres should override local genres');
    assert.strictEqual(liveEntry.poster, 'https://example.com/live.jpg', 'AniList artwork should replace local artwork');
    assert.strictEqual(liveEntry.description, 'Live description.', 'AniList description should replace the local copy');
    assert.strictEqual(liveEntry.anilistId, 4242, 'The AniList detail ID must come from AniList');
    assert.strictEqual(liveEntry.id, 4242, 'The AniList ID must replace any local key on matched entries');
    assert.strictEqual(
      liveEntry.editorialBadge,
      'Staff pick',
      'Local-only curation fields must survive the merge untouched'
    );

    // ---- Merge policy: missing AniList fields fall back to local values ----
    const sparseMedia = {
      id: 4243,
      title: { english: null, romaji: 'Sparse AniList Title', native: null },
      coverImage: {},
      description: '',
      episodes: null,
      status: null,
      averageScore: null,
      genres: [],
      seasonYear: null,
      startDate: {},
      format: null,
      countryOfOrigin: 'ZZ',
      studios: { nodes: [] }
    };
    const localFallbackTitle = {
      id: 78,
      anilistId: 4243,
      title: 'Local Fallback Title',
      genre: ['Sci-Fi'],
      year: 2011,
      rating: 9.1,
      episodes: 24,
      type: 'TV',
      studio: 'Local Studio',
      language: 'Japanese',
      status: 'Completed',
      poster: 'https://example.com/fallback.jpg',
      description: 'Local fallback description.'
    };
    const fallbackEntry = mergeAniListCatalog([localFallbackTitle], [sparseMedia])[0];
    assert.strictEqual(fallbackEntry.title, 'Sparse AniList Title', 'A usable AniList title should still win');
    assert.strictEqual(fallbackEntry.episodes, 24, 'Local episodes should survive when AniList has none');
    assert.strictEqual(fallbackEntry.studio, 'Local Studio', 'Local studio should survive when AniList has none');
    assert.strictEqual(fallbackEntry.status, 'Completed', 'Local status should survive when AniList has none');
    assert.strictEqual(fallbackEntry.year, 2011, 'Local year should survive when AniList has none');
    assert.strictEqual(fallbackEntry.rating, 9.1, 'Local rating should survive when AniList has none');
    assert.strictEqual(fallbackEntry.type, 'TV', 'Local format should survive when AniList has none');
    assert.strictEqual(fallbackEntry.language, 'Japanese', 'Local language should survive unknown AniList origin');
    assert.strictEqual(fallbackEntry.poster, 'https://example.com/fallback.jpg', 'Local poster should survive empty AniList art');
    assert.strictEqual(
      fallbackEntry.description,
      'Local fallback description.',
      'Local description should survive an empty AniList description'
    );

    // ---- Merge policy: a wholly local catalog is returned unchanged ----
    const offlineCatalog = mergeAniListCatalog([localFallbackTitle], []);
    assert.deepStrictEqual(
      offlineCatalog,
      [{ ...localFallbackTitle, id: 4243, anilistId: 4243 }],
      'An unavailable AniList must leave curated content intact, keyed by AniList ID'
    );

    // ---- Single canonical ID ----
    assert.deepStrictEqual(
      withCanonicalId({ id: 7, anilistId: 42, title: 'Canonical' }),
      { id: 42, anilistId: 42, title: 'Canonical' },
      'A curated entry must expose its AniList ID as its own id'
    );
    assert.strictEqual(
      mergeAniListCatalog([staleLocalTitle], [])[0].id,
      4242,
      'An unmatched curated entry must still be keyed by its AniList ID'
    );

    assert.deepStrictEqual(
      searchAnimeLocal([localTitle], 'fantasy'),
      [localTitle],
      'Local fallback should search the local genre field'
    );

    const typoTitles = [
      { id: 1, title: 'One Piece' },
      { id: 2, title: 'Naruto' },
      { id: 3, title: 'Demon Slayer' },
      { id: 4, title: 'Jujutsu Kaisen' }
    ];
    for (const [query, expectedTitle] of [
      ['one peice', 'One Piece'],
      ['narutoo', 'Naruto'],
      ['demom slayer', 'Demon Slayer'],
      ['jujutsu kiasen', 'Jujutsu Kaisen']
    ]) {
      assert.strictEqual(
        searchAnimeLocalFuzzy(typoTitles, query)[0]?.title,
        expectedTitle,
        `${query} should find a title with one transposed or mistyped character`
      );
    }
    assert.deepStrictEqual(
      rankAnimeSuggestions([
        { title: { english: 'Someone Loves You' } },
        { title: { english: 'One Piece Film: Red' } },
        { title: { english: 'One Punch Man' } }
      ], 'one').map(getTitle),
      ['One Piece Film: Red', 'One Punch Man', 'Someone Loves You'],
      'Prefix matches should rank above partial title matches while preserving AniList order'
    );

    const mappedTitle = mapLocalAnimeToAniList(localTitle);
    assert.strictEqual(mappedTitle.id, localTitle.anilistId, 'Fallback results should open the matching AniList detail');
    assert.strictEqual(mappedTitle.title.english, localTitle.title, 'Local fallback should expose the AniList title shape');
    assert.strictEqual(mappedTitle.coverImage.large, localTitle.poster, 'Local fallback should expose the AniList cover shape');
    assert.strictEqual(mappedTitle.bannerImage, localTitle.banner, 'Local fallback should preserve its banner image');
    assert.deepStrictEqual(mappedTitle.genres, localTitle.genre, 'Local fallback should expose AniList genres');
    assert.strictEqual(mappedTitle.studios.nodes[0].name, localTitle.studio, 'Fallback results should include the local studio');
    assert.strictEqual(mappedTitle.countryOfOrigin, 'JP', 'Fallback results should expose the AniList country code');

    console.log('All search and catalog tests passed.');
  } finally {
    server.kill();
    await new Promise(resolve => authServer.close(resolve));
  }
}

run().catch(error => {
  console.error('Search tests failed:', error.message);
  process.exitCode = 1;
});