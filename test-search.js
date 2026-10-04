const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { mapLocalAnimeToAniList, searchAnimeLocal } = require('./search-utils');
const { mapAniListMediaToCatalogItem, mergeAniListCatalog } = require('./catalog-utils');

const TEST_PORT = process.env.TEST_PORT || 3001;
const baseURL = `http://localhost:${TEST_PORT}`;
const verifiedUserId = '01234567-89ab-cdef-0123-456789abcdef';
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
      if (output.includes(`Server: ${baseURL}`)) {
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

async function run() {
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
      PORT: String(TEST_PORT),
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
    assert(homePage.body.includes('application/ld+json'), 'Home page should have Schema.org WebSite JSON-LD');
    assert(!homePage.body.includes('4K Ultra HD'), 'Home page should not claim 4K streaming capability');
    assert(!homePage.body.includes('data-nav="account"'), 'Catalog should not include account navigation');
    assert(!homePage.body.includes('page-account'), 'Catalog should not include account or signup forms');

    const protectedPath = await request('/server.js');
    assert.strictEqual(protectedPath.statusCode, 404, 'Project source must not be served as a static asset');

    const securityHeaders = await request('/');
    assert.strictEqual(securityHeaders.statusCode, 200, 'Catalog home page should load');
    assert.strictEqual(securityHeaders.headers['x-content-type-options'], 'nosniff');

    const siteConfig = await request('/api/site-config');
    assert.strictEqual(siteConfig.statusCode, 200, 'Public site configuration should load');
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

    const trending = await request('/api/trending');
    assert.strictEqual(trending.statusCode, 200, 'Trending catalog should load');
    const jujutsuKaisen = trending.body.find(anime => anime.title === 'Jujutsu Kaisen');
    assert.strictEqual(jujutsuKaisen?.anilistId, 113415, 'Local catalog entries should carry their AniList detail ID');
    assert.strictEqual(jujutsuKaisen?.studio, 'MAPPA', 'Catalog entries should include studio metadata');
    assert.strictEqual(jujutsuKaisen?.language, 'Japanese', 'Catalog entries should include language metadata');

    const popular = await request('/api/popular');
    assert.strictEqual(popular.statusCode, 200, 'Expanded popular catalog should load');
    assert(Array.isArray(popular.body), 'Popular catalog should return an array');
    assert(popular.body.length >= 12, 'Popular catalog should retain the local fallback titles');
    assert(
      popular.body.every(anime => Number.isInteger(anime.anilistId) && anime.anilistId > 0),
      'Every popular catalog entry should have an AniList detail ID'
    );
    assert.strictEqual(
      new Set(popular.body.map(anime => anime.anilistId)).size,
      popular.body.length,
      'Popular catalog should not contain duplicate AniList IDs'
    );

    const localTitle = {
      id: 23,
      anilistId: 123,
      title: 'Sample Fantasy',
      genre: ['Fantasy'],
      poster: 'https://example.com/poster.jpg',
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
    const mergedCatalog = mergeAniListCatalog([localTitle], [mediaFixture, {
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
    assert.strictEqual(liveEntry.id, 77, 'The local catalog key should stay stable for matched entries');
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
      [{ ...localFallbackTitle, anilistId: 4243 }],
      'An unavailable AniList must leave the local catalog untouched'
    );

    assert.deepStrictEqual(
      searchAnimeLocal([localTitle], 'fantasy'),
      [localTitle],
      'Local fallback should search the local genre field'
    );

    const mappedTitle = mapLocalAnimeToAniList(localTitle);
    assert.strictEqual(mappedTitle.id, localTitle.anilistId, 'Fallback results should open the matching AniList detail');
    assert.strictEqual(mappedTitle.title.english, localTitle.title, 'Local fallback should expose the AniList title shape');
    assert.strictEqual(mappedTitle.coverImage.large, localTitle.poster, 'Local fallback should expose the AniList cover shape');
    assert.deepStrictEqual(mappedTitle.genres, localTitle.genre, 'Local fallback should expose AniList genres');
    assert.strictEqual(mappedTitle.studios.nodes[0].name, localTitle.studio, 'Fallback results should include the local studio');
    assert.strictEqual(mappedTitle.countryOfOrigin, 'JP', 'Fallback results should expose the AniList country code');

    console.log('All search tests passed.');
  } finally {
    server.kill();
    await new Promise(resolve => authServer.close(resolve));
  }
}

run().catch(error => {
  console.error('Search tests failed:', error.message);
  process.exitCode = 1;
});