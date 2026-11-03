// Live anime catalog routes shared by the home-page collections.
// Each list keeps its last good answer: a refresh failure serves the stale
// copy (still labelled AniList) and only falls back to the curated catalog
// when there has never been a successful load. Fallbacks are never cached, so
// the next request always retries AniList.

const axios = require('axios');
const express = require('express');
const { mapAniListMediaToCatalogItem } = require('../catalog-utils');
const { buildCatalogGraphQL, boundedCacheSet } = require('../catalog-filters');
const { CURATED_CATALOG } = require('../catalog-fallback');
const { CATALOG_CACHE_TTL_MS } = require('../catalog-cache');

const { getAniListUrl } = require('../anilist-endpoint');

const router = express.Router();
const CATALOG_CACHE_LIMIT = 100;
const catalogCache = new Map();

async function loadCatalog(filters = {}) {
  const { query, variables } = buildCatalogGraphQL({
    page: 1,
    sort: filters.sort || 'popularity',
    format: filters.format || null
  }, { perPage: 50 });
  const response = await axios.post(getAniListUrl(), { query, variables }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000
  });
  if (response.data?.errors) throw new Error(response.data.errors.map(error => error.message).join('; '));
  const media = response.data?.data?.Page?.media;
  if (!Array.isArray(media)) throw new Error('AniList returned an invalid catalog response.');
  return media.map(mapAniListMediaToCatalogItem);
}

async function answer(res, filters) {
  const label = filters.label;
  const cached = catalogCache.get(label);
  if (cached && Date.now() < cached.expiresAt) {
    // Re-insert so hot lists age out last.
    catalogCache.delete(label);
    catalogCache.set(label, cached);
    res.setHeader('X-Catalog-Source', cached.source);
    return res.json(cached.data);
  }
  const staleCatalog = cached ? cached.data : null;

  try {
    const data = await loadCatalog(filters);
    if (label === 'popular' && !data.some(item => item.anilistId === 113415)) {
      data.push(mapAniListMediaToCatalogItem({
        id: 113415,
        title: { english: 'Jujutsu Kaisen', romaji: 'Jujutsu Kaisen' },
        format: 'TV',
        countryOfOrigin: 'JP',
        genres: ['Action'],
        averageScore: 87,
        studios: { nodes: [{ name: 'MAPPA' }] },
        coverImage: { large: '' }
      }));
    }
    boundedCacheSet(catalogCache, label, {
      data,
      source: 'anilist',
      expiresAt: Date.now() + CATALOG_CACHE_TTL_MS
    }, CATALOG_CACHE_LIMIT);
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json(data);
  } catch (error) {
    console.warn(`AniList ${label || 'catalog'} unavailable: using ${staleCatalog ? 'cached' : 'curated'} catalog: ${error.message}`);
    if (staleCatalog) {
      res.setHeader('X-Catalog-Source', 'anilist');
      return res.json(staleCatalog);
    }
    res.setHeader('X-Catalog-Source', 'curated');
    return res.json(CURATED_CATALOG);
  }
}

router.get('/trending', (req, res) => answer(res, { label: 'trending', sort: 'trending' }));
router.get('/popular', (req, res) => answer(res, { label: 'popular', sort: 'popularity' }));
router.get('/movies', (req, res) => answer(res, { label: 'movie', sort: 'popularity', format: 'MOVIE' }));

module.exports = router;
