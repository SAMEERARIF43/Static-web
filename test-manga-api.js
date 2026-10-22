const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const { createAniListMock } = require('./test-fixtures/anilist-mock');

const appPort = 3127;
const mockPort = 3128;
const baseUrl = `http://127.0.0.1:${appPort}`;

const mediaByCountry = {
  JP: { id: 101, type: 'MANGA', countryOfOrigin: 'JP', title: { romaji: 'JP Manga' }, format: 'MANGA', chapters: 12, volumes: 2, genres: ['Action'], averageScore: 80, status: 'FINISHED', coverImage: { large: 'https://placehold.co/jp' }, authors: { edges: [] } },
  KR: { id: 102, type: 'MANGA', countryOfOrigin: 'KR', title: { romaji: 'KR Manhwa' }, format: 'MANGA', chapters: 20, volumes: 3, genres: ['Drama'], averageScore: 81, status: 'RELEASING', coverImage: { large: 'https://placehold.co/kr' }, authors: { edges: [] } },
  CN: { id: 103, type: 'MANGA', countryOfOrigin: 'CN', title: { romaji: 'CN Manhua' }, format: 'MANGA', chapters: null, volumes: null, genres: ['Fantasy'], averageScore: 82, status: 'FINISHED', coverImage: { large: 'https://placehold.co/cn' }, authors: { edges: [] } },
  TW: { id: 104, type: 'MANGA', countryOfOrigin: 'TW', title: { romaji: 'TW Manhua' }, format: 'MANGA', chapters: 9, volumes: 1, genres: ['Drama'], averageScore: 79, status: 'FINISHED', coverImage: { large: 'https://placehold.co/tw' }, authors: { edges: [] } }
};

function request(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${pathname}`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let parsed = body;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    }).on('error', reject);
  });
}

function waitForApp(process) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`AnimeHub did not start: ${output}`)), 10000);
    process.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes(`AnimeHub server listening on port ${appPort}.`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    process.once('exit', code => reject(new Error(`AnimeHub exited before startup: ${code}`)));
  });
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
      const wrongType = { ...mediaByCountry.JP, id: 190, type: 'ANIME' };
      const unknownOrigin = { ...mediaByCountry.JP, id: 191, countryOfOrigin: null };
      const unsupportedOrigin = { ...mediaByCountry.JP, id: 192, countryOfOrigin: 'US' };
      const conflictingOrigin = { ...mediaByCountry.KR, id: 193, countryOfOrigin: 'JP' };
      let media = isDetail
        ? Object.values(mediaByCountry).find(item => item.id === Number(variables.id)) || null
        : payload.variables.search === 'empty'
          ? []
          : payload.variables.search === 'malformed'
            ? null
            : [requested, wrongType, unknownOrigin, unsupportedOrigin, conflictingOrigin];
      if (!isDetail && ['last-page-fit', 'missing-page-info', 'unreliable-page-info'].includes(payload.variables.search)) media = [requested];
      if (payload.variables.search === 'null-record') media.push(null);
      if (!isDetail && Number(variables.page) === 50) media = [requested];
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
      const specialSearch = variables.search;
      const pageInfo = specialSearch === 'missing-page-info'
        ? { total: 20, perPage: Number(variables.perPage || 20), currentPage: Number(variables.page || 1), hasNextPage: true }
        : specialSearch === 'unreliable-page-info'
          ? { total: 20, perPage: Number(variables.perPage || 20), currentPage: 2, lastPage: 1, hasNextPage: true }
          : specialSearch === 'last-page-fit'
            ? { total: 40, perPage: Number(variables.perPage || 20), currentPage: Number(variables.page || 1), lastPage: 2, hasNextPage: Number(variables.page || 1) < 2 }
            : { total: variables.search === 'filtered-unknown' ? 100 : 5, perPage: Number(variables.perPage || 20), currentPage: Number(variables.page || 1), lastPage: variables.page === 50 ? 75 : 1, hasNextPage: variables.page === 50 ? true : false };
      const response = isDetail
        ? { data: { Media: media } }
        : payload.variables.search === 'malformed'
          ? { data: { Page: { media: null } } }
          : { data: { Page: { pageInfo, media } } };
      if (!isDetail && payload.query.includes('Page(') && !/\bid\s+type\s+title\b/.test(payload.query)) {
        jsonResponse(res, { errors: [{ message: 'type selection missing' }] }, 500);
        return;
      }
      if (isDetail && (!payload.query.includes('isAdult: false') || !/\bid\s+type\s+title\b/.test(payload.query))) {
        jsonResponse(res, { errors: [{ message: 'detail selection/filter missing' }] }, 500);
        return;
      }
      jsonResponse(res, response);
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
    const manga = await request('/api/manga');
    assert.strictEqual(manga.status, 200);
    assert.strictEqual(manga.body[0].contentType, 'manga');
    assert.strictEqual(manga.headers['x-content-has-next'], 'false');
    assert.strictEqual(manga.headers['x-content-total'], undefined, 'filtered provider totals must not be reported as category totals');
    const repeated = await request('/api/manga');
    assert.deepStrictEqual(repeated.body, manga.body, 'identical fresh requests must keep the list response shape');
    assert.strictEqual(repeated.headers['x-content-source'], 'anilist');

    const manhwa = await request('/api/manhwa');
    assert.strictEqual(manhwa.status, 200);
    assert.strictEqual(manhwa.body[0].contentType, 'manhwa');

    const manhua = await request('/api/manhua');
    assert.strictEqual(manhua.status, 200);
    assert.strictEqual(manhua.body[0].contentType, 'manhua');
    assert.strictEqual(manhua.body[0].chapters, null, 'unknown chapter totals must remain unknown');

    const search = await request('/api/manhwa/search?q=Tower');
    assert.strictEqual(search.status, 200);
    assert.strictEqual(search.body[0].contentType, 'manhwa');
    assert(manhwa.body.every(item => item.contentType === 'manhwa'));
    assert(manhua.body.every(item => item.contentType === 'manhua'));
    assert(await request('/api/manga?sort=trending').then(result => result.status === 200));
    assert.strictEqual((await request('/api/manga?sort=bad')).status, 400);
    assert.strictEqual((await request('/api/manga?page=0')).status, 400);
    assert.strictEqual((await request('/api/manga?perPage=31')).status, 400);
    const empty = await request('/api/manga?q=empty');
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(empty.body, []);
    assert.strictEqual(empty.headers['x-content-has-next'], 'false');
    const nullRecord = await request('/api/manga/search?q=null-record');
    assert.strictEqual(nullRecord.status, 200);
    assert(nullRecord.body.every(item => item && item.id), 'null provider records are discarded per-record');
    const unknownTotals = await request('/api/manga/search?q=filtered-unknown');
    assert.strictEqual(unknownTotals.status, 200);
    assert.strictEqual(unknownTotals.headers['x-content-total'], undefined);
    assert.strictEqual(unknownTotals.headers['x-content-total-pages'], undefined);
    const fittingTotals = await request('/api/manga/search?q=last-page-fit');
    assert.strictEqual(fittingTotals.status, 200);
    assert.strictEqual(fittingTotals.headers['x-content-total'], '40');
    assert.strictEqual(fittingTotals.headers['x-content-total-pages'], '2');
    const missingPageInfo = await request('/api/manga/search?q=missing-page-info');
    assert.strictEqual(missingPageInfo.status, 200);
    assert.strictEqual(missingPageInfo.headers['x-content-total'], '20');
    assert.strictEqual(missingPageInfo.headers['x-content-total-pages'], undefined);
    const unreliablePageInfo = await request('/api/manga/search?q=unreliable-page-info');
    assert.strictEqual(unreliablePageInfo.status, 200);
    assert.strictEqual(unreliablePageInfo.headers['x-content-total'], undefined);
    assert.strictEqual(unreliablePageInfo.headers['x-content-total-pages'], undefined);
    const finalPage = await request('/api/manga?page=50');
    assert.strictEqual(finalPage.status, 200);
    assert.strictEqual(finalPage.headers['x-content-has-next'], 'false', 'page 50 must never advertise a next page');
    assert.strictEqual(finalPage.headers['x-content-total-pages'], undefined, 'provider pages beyond the application cap must remain unknown');
    assert.strictEqual((await request('/api/manga?page=51')).status, 400);
    assert.strictEqual((await request('/api/manga?q=graphql-error')).status, 502);
    assert.strictEqual((await request('/api/manga?q=malformed')).status, 502);

    const invalid = await request('/api/manga/not-an-id');
    assert.strictEqual(invalid.status, 400);

    const mismatch = await request('/api/manga/102');
    assert.strictEqual(mismatch.status, 404, 'a Korean title must not leak into the manga route');
    const detail = await request('/api/manga/101');
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.id, 101);
    assert.strictEqual(detail.body.anilistId, detail.body.id);
    assert.strictEqual(detail.body.contentType, 'manga');
    const cachedDetail = await request('/api/manga/101');
    assert.strictEqual(cachedDetail.status, 200);
    assert.strictEqual(cachedDetail.body.anilistId, cachedDetail.body.id);
    assert.strictEqual(cachedDetail.body.contentType, 'manga');

    const graphqlErrorDetail = await request('/api/manga/105');
    assert.strictEqual(graphqlErrorDetail.status, 502, 'GraphQL detail errors should return the documented temporary-unavailability response');
    assert.strictEqual(graphqlErrorDetail.body.message, 'Manga details are temporarily unavailable.');

    const missingDetail = await request('/api/manga/999');
    assert.strictEqual(missingDetail.status, 404, 'A missing AniList detail entry should return not found');
    assert.strictEqual(missingDetail.body.message, 'Manga not found.');

    const networkErrorDetail = await request('/api/manga/106');
    assert.strictEqual(networkErrorDetail.status, 502, 'A provider/network detail failure without cached data should return temporary unavailability');
    assert.strictEqual(networkErrorDetail.body.message, 'Manga details are temporarily unavailable.');

    const anime = await request('/api/series');
    assert.strictEqual(anime.status, 200);
    assert(!anime.body.some(item => item.contentType === 'manga' || item.contentType === 'manhwa' || item.contentType === 'manhua'));
    console.log('Manga API routes, classification boundaries, pagination headers and anime isolation verified.');
  } finally {
    app.kill();
     await mock.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
