/* eslint-env jest */
// Regression tests for GET /api/recommendations.
//
// Mounts the genuine Express router, mocks axios (the route's upstream
// transport) and points ANILIST_GRAPHQL_URL at a throwaway origin. The mocks
// reproduce the response shape catalog-filters.buildRecommendationsGraphQL
// actually asks AniList for (`genrePage.media` and the recommendation edges on
// `favoritePage.media`), so a valid upstream answer must produce
// `source: 'anilist'` — not the curated fallback. Does NOT contact AniList.

jest.mock('axios', () => {
  const actualAxios = jest.requireActual('axios');
  return { ...actualAxios, post: jest.fn() };
});

const axios = require('axios');
const express = require('express');
const http = require('http');

const ANILIST_TEST_ENDPOINT = 'http://127.0.0.1:9999/graphql';

function createTestApp() {
  const app = express();
  app.use('/api/recommendations', require('../routes/recommendations'));
  return app;
}

function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    const port = server.address().port;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          server.close();
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        });
      }
    );
    req.on('error', (err) => {
      server.close();
      reject(err);
    });
    req.setTimeout(5000, () => {
      req.destroy();
      server.close();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

function media(id) {
  return {
    id,
    title: { romaji: `Title ${id}`, english: `Title ${id}` },
    coverImage: { large: '' },
    format: 'TV',
  };
}

describe('GET /api/recommendations', () => {
  let app;

  beforeEach(() => {
    axios.post.mockReset();
    process.env.ANILIST_GRAPHQL_URL = ANILIST_TEST_ENDPOINT;
    app = createTestApp();
  });

  afterEach(() => {
    delete process.env.ANILIST_GRAPHQL_URL;
  });

  it('serves curated items without contacting AniList when no preferences are given', async () => {
    const res = await request(app, '/api/recommendations');

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('curated');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    // The empty-preference path must not send a query at all.
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('ignores non-numeric favorites instead of sending invalid GraphQL variables', async () => {
    const res = await request(app, '/api/recommendations?favorites=not-an-id,0,-3');

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('curated');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('returns source "anilist" when genre preferences yield an upstream page', async () => {
    axios.post.mockResolvedValueOnce({
      data: { data: { genrePage: { media: [media(1), media(2)] } } },
    });

    const res = await request(app, '/api/recommendations?genres=Action,Drama');

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('anilist');
    expect(res.body.data.map((item) => item.id)).toEqual([1, 2]);

    // Upstream is resolved through the shared, validated endpoint module.
    const [url, payload, options] = axios.post.mock.calls[0];
    expect(url).toBe(ANILIST_TEST_ENDPOINT);
    expect(options.timeout).toBeGreaterThan(0);
    expect(payload.query).toContain('genrePage');
    // Client values are variables, never interpolated into the document.
    expect(payload.query).not.toContain('Action');
    expect(payload.variables.genres).toEqual(['Action', 'Drama']);
  });

  it('returns source "anilist" from the recommendation edges of favourite titles', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        data: {
          favoritePage: {
            media: [
              {
                id: 21,
                recommendations: {
                  edges: [
                    { node: { mediaRecommendation: media(11) } },
                    { node: { mediaRecommendation: media(12) } },
                    { node: { mediaRecommendation: null } },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    const res = await request(app, '/api/recommendations?favorites=21');

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('anilist');
    expect(res.body.data.map((item) => item.id)).toEqual([11, 12]);
    expect(axios.post.mock.calls[0][1].query).toContain('favoritePage');
  });

  it('de-duplicates titles that appear in both the genre page and the favourites', async () => {
    axios.post.mockResolvedValueOnce({
      data: {
        data: {
          genrePage: { media: [media(7), media(8)] },
          favoritePage: {
            media: [{ id: 21, recommendations: { edges: [{ node: { mediaRecommendation: media(7) } }] } }],
          },
        },
      },
    });

    const res = await request(app, '/api/recommendations?genres=Action&favorites=21');

    expect(res.body.source).toBe('anilist');
    expect(res.body.data.map((item) => item.id)).toEqual([7, 8]);
  });

  it('falls back to curated when AniList returns GraphQL errors', async () => {
    axios.post.mockResolvedValueOnce({
      data: { errors: [{ message: 'Invalid genre' }] },
    });

    const res = await request(app, '/api/recommendations?genres=Action');

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('curated');
  });

  it('falls back to curated when the upstream request fails', async () => {
    axios.post.mockRejectedValueOnce(new Error('socket hang up'));

    const res = await request(app, '/api/recommendations?genres=Action');

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('curated');
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('falls back to curated when the upstream answer contains nothing usable', async () => {
    axios.post.mockResolvedValueOnce({
      data: { data: { genrePage: { media: [] }, favoritePage: { media: [] } } },
    });

    const res = await request(app, '/api/recommendations?genres=Action');

    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('curated');
  });
});
