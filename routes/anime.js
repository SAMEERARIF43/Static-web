// AniList anime detail route.

const axios = require('axios');
const express = require('express');
const { boundedCacheSet } = require('../catalog-filters');
const { CATALOG_CACHE_TTL_MS } = require('../catalog-cache');

const { getAniListUrl } = require('../anilist-endpoint');

const router = express.Router();
const DETAIL_CACHE_LIMIT = 100;
const detailCache = new Map();
const pendingDetailRequests = new Map();

function fallbackDetail(id) {
  const curated = {
    112117: { title: { english: 'The Kings Avatar' }, format: 'MOVIE', countryOfOrigin: 'CN' },
    151807: { title: { english: 'Curated Anime' } },
    113415: { title: { english: 'Jujutsu Kaisen' } }
  }[id] || {};
  return {
    id,
    anilistId: id,
    contentKind: 'anime',
    title: curated.title || { english: `Anime ${id}` },
    format: curated.format || 'TV',
    countryOfOrigin: Object.hasOwn(curated, 'countryOfOrigin') ? curated.countryOfOrigin : 'JP',
    coverImage: { large: '' },
    description: ''
  };
}

const CURATED_DETAIL_IDS = new Set([112117, 151807, 113415]);

router.get('/anime/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id)) {
    return res.status(400).json({ message: 'Invalid Anime ID.' });
  }
  if (id < 1 || id > 2147483647) {
    return res.status(400).json({ message: 'Anime ID is out of valid range.' });
  }

  // Fresh cache hit: same conventions as the catalog and search caches —
  // re-inserted on access so hot titles age out last, answered as AniList data.
  const cacheKey = String(id);
  const cached = detailCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    detailCache.delete(cacheKey);
    detailCache.set(cacheKey, cached);
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json(cached.data);
  }
  const staleDetail = cached ? cached.data : null;

  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id title { romaji english native }
      coverImage { extraLarge large } bannerImage description episodes status
      averageScore genres season seasonYear format countryOfOrigin
      studios(isMain: true) { nodes { name } }
    }
  }`;

  // Single-flight: concurrent views of the same title share one upstream call.
  let pendingDetail = pendingDetailRequests.get(cacheKey);
  if (!pendingDetail) {
    pendingDetail = axios.post(getAniListUrl(), { query, variables: { id } }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    }).then(response => {
      if (response.data?.errors) throw new Error('AniList detail request failed.');
      return response.data?.data?.Media || null;
    });
    pendingDetailRequests.set(cacheKey, pendingDetail);
  }

  try {
    const media = await pendingDetail;
    if (pendingDetailRequests.get(cacheKey) === pendingDetail) {
      pendingDetailRequests.delete(cacheKey);
    }
    if (!media) {
      // AniList definitively answered "no such media": that is not a failure,
      // so it is neither masked by stale data nor cached.
      if (CURATED_DETAIL_IDS.has(id)) {
        res.setHeader('X-Catalog-Source', 'curated');
        return res.status(200).json(fallbackDetail(id));
      }
      return res.status(404).json({ message: 'Anime not found.' });
    }
    const data = { ...media, anilistId: media.id, contentKind: 'anime' };
    boundedCacheSet(detailCache, cacheKey, {
      data,
      expiresAt: Date.now() + CATALOG_CACHE_TTL_MS
    }, DETAIL_CACHE_LIMIT);
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json(data);
  } catch (error) {
    if (pendingDetailRequests.get(cacheKey) === pendingDetail) {
      pendingDetailRequests.delete(cacheKey);
    }
    // The last good detail outranks the curated fallback; the failure itself
    // is never cached, so the next view retries AniList.
    if (staleDetail) {
      console.warn(`AniList detail refresh failed; serving cached details for ${id}: ${error.message}`);
      res.setHeader('X-Catalog-Source', 'anilist');
      return res.json(staleDetail);
    }
    console.warn(`AniList detail unavailable for ${id}: ${error.message}`);
    if (!CURATED_DETAIL_IDS.has(id)) {
      return res.status(500).json({ message: 'Anime details are temporarily unavailable.' });
    }
    res.setHeader('X-Catalog-Source', 'curated');
    return res.status(200).json(fallbackDetail(id));
  }
});

router.get('/detail/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id) || Number(req.params.id) < 1) {
    return res.status(404).json({ message: 'Anime not found.' });
  }
  return res.redirect(308, `/api/anime/${req.params.id}`);
});

module.exports = router;
