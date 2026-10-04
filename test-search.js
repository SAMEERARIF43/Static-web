const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { mapLocalAnimeToAniList, searchAnimeLocal } = require('./search-utils');
const { mapAniListMediaToCatalogItem, mergeAniListCatalog } = require('./catalog-utils');

const PORT = process.env.PORT || 3000;
const baseURL = `http://localhost:${PORT}`;

function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${baseURL}${pathname}`, { headers }, (res) => {
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
    }).on('error', reject);
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
  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'inherit']
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

    const localWatchlistScript = await request('/script.js');
    assert(localWatchlistScript.body.includes("localStorage.getItem('anime_hub_watchlist')"), 'Watchlist should remain browser-local');
    assert(!localWatchlistScript.body.includes("localStorage.removeItem('anime_hub_continue_watching')"), 'Existing continue-watching data should not be cleared');
    assert(localWatchlistScript.body.includes("searchFilterForm?.addEventListener('change', applySearchFilters)"), 'Search filters and sorting should update results when changed');
    assert(localWatchlistScript.body.includes("searchFilterForm?.addEventListener('reset'"), 'Search filters should reapply after reset');

    const forbiddenOrigin = await request('/api/site-config', { Origin: 'https://not-allowed.example' });
    assert.strictEqual(forbiddenOrigin.statusCode, 403, 'Unconfigured cross-origin requests should be rejected');

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
      localTitle.title,
      'Curated local metadata should override its matching AniList entry'
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
  }
}

run().catch(error => {
  console.error('Search tests failed:', error.message);
  process.exitCode = 1;
});