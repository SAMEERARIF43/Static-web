// Browse and genre routes backed by AniList.

const axios = require('axios');
const express = require('express');
const { mapAniListMediaToCatalogItem } = require('../catalog-utils');
const {
  BROWSE_MAX_PAGE,
  browseCacheKey,
  boundedCacheSet,
  buildCatalogGraphQL,
  normalizeBrowsePageMeta,
  parseBrowseFilters
} = require('../catalog-filters');
const { CURATED_CATALOG } = require('../catalog-fallback');

const { getAniListUrl } = require('../anilist-endpoint');

const router = express.Router();
const REQUEST_TIMEOUT_MS = 10000;
const MAX_GENRE_LENGTH = 50;
const ADULT_GENRES = new Set(['hentai']);
const GENRE_PATTERN = /^[\p{L}\p{N}\s'.-]+$/u;
// Short five-minute window (max 100 entries) so Load-more pages stay cheap
// without pinning stale filters for long.
const BROWSE_CACHE_TTL_MS = 5 * 60 * 1000;
const BROWSE_CACHE_LIMIT = 100;
const browseQueryCache = new Map();
const pendingBrowseRequests = new Map();

function curatedGenreFallback(genre) {
  if (genre.toLowerCase() !== 'shounen') return [];
  return [{
    id: 113415,
    anilistId: 113415,
    title: 'Jujutsu Kaisen',
    genre: ['Shounen', 'Action'],
    genres: ['Shounen', 'Action'],
    type: 'TV',
    format: 'TV',
    studio: 'MAPPA',
    language: 'Japanese',
    countryOfOrigin: 'JP'
  }];
}

function filterCuratedCatalog(filters) {
  const wantedGenres = new Set((filters.genres || []).map(genre => genre.toLowerCase()));
  const results = CURATED_CATALOG.filter(item => {
    const genres = (item.genre || []).map(genre => String(genre).toLowerCase());
    if (wantedGenres.size && ![...wantedGenres].every(genre => genres.includes(genre))) return false;
    if (filters.minScore !== null && filters.minScore !== undefined && Number(item.rating || 0) * 10 < filters.minScore) return false;
    if (filters.format && String(item.format).toUpperCase() !== filters.format) return false;
    if (filters.status && String(item.status).toUpperCase() !== filters.status) return false;
    if (filters.countryOfOrigin && item.countryOfOrigin !== filters.countryOfOrigin) return false;
    return true;
  });
  if (filters.sort === 'score') results.sort((a, b) => b.rating - a.rating);
  return results;
}

function safeMedia(media) {
  if (!Array.isArray(media)) return [];
  return media
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => mapAniListMediaToCatalogItem(item));
}

async function postAniList(query, variables = {}) {
  const response = await axios.post(getAniListUrl(), { query, variables }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS
  });
  if (response.data?.errors) {
    throw new Error(response.data.errors.map(error => error.message).join('; '));
  }
  return response.data;
}

async function fetchBrowsePage(filters, perPage) {
  const { query, variables } = buildCatalogGraphQL(filters, { perPage });
  const payload = await postAniList(query, variables);
  const page = payload?.data?.Page;
  if (!page || !Array.isArray(page.media)) throw new Error('AniList returned an invalid catalog response.');
  return { media: page.media, pageInfo: page.pageInfo };
}

async function fetchGenreList() {
  const payload = await postAniList('query { GenreCollection }');
  const genres = payload?.data?.GenreCollection;
  if (!Array.isArray(genres)) throw new Error('AniList returned an invalid genre response.');
  return genres.filter(genre => !ADULT_GENRES.has(String(genre).toLowerCase()));
}

function setBrowseHeaders(res, meta, source) {
  res.setHeader('X-Catalog-Source', source);
  res.setHeader('X-Catalog-Page', String(meta.page));
  res.setHeader('X-Catalog-Per-Page', String(meta.perPage));
  res.setHeader('X-Catalog-Total-Pages', String(meta.totalPages));
  res.setHeader('X-Catalog-Has-Next', meta.hasNext ? 'true' : 'false');
  if (meta.total !== null) res.setHeader('X-Catalog-Total', String(meta.total));
}

/**
 * Resolve one validated browse page as `{ data, source, meta }`.
 * A warm entry answers whole (meta included); a failed refresh serves the last
 * good page for the same key; concurrent identical requests share one call.
 */
async function getBrowsePage(filters, perPage) {
  const key = browseCacheKey(filters, perPage);
  const cached = browseQueryCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    // Re-insert so hot filters age out last.
    browseQueryCache.delete(key);
    browseQueryCache.set(key, cached);
    return { data: cached.data, source: cached.source, meta: cached.meta };
  }
  const stalePage = cached || null;

  let pending = pendingBrowseRequests.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const result = await fetchBrowsePage(filters, perPage);
        const data = safeMedia(result.media);
        const meta = normalizeBrowsePageMeta(result.pageInfo, {
          page: filters.page,
          perPage,
          itemCount: data.length,
          maxPage: BROWSE_MAX_PAGE
        });
        boundedCacheSet(browseQueryCache, key, {
          data,
          source: 'anilist',
          meta,
          expiresAt: Date.now() + BROWSE_CACHE_TTL_MS
        }, BROWSE_CACHE_LIMIT);
        return { data, source: 'anilist', meta };
      } catch (error) {
        // The last good page outranks the curated fallback; the failure itself
        // is never cached, so the next request retries AniList.
        if (stalePage) {
          console.warn(`AniList browse unavailable; using cached page: ${error.message}`);
          return { data: stalePage.data, source: stalePage.source, meta: stalePage.meta };
        }
        throw error;
      } finally {
        if (pendingBrowseRequests.get(key) === pending) pendingBrowseRequests.delete(key);
      }
    })();
    pendingBrowseRequests.set(key, pending);
  }
  return pending;
}

router.get('/browse', async (req, res) => {
  const structural = parseBrowseFilters(req.query, {
    skipGenreMembership: true,
    maxYear: new Date().getFullYear() + 1
  });
  if (structural.errors.length) return res.status(400).json({ message: structural.errors[0] });

  let filters = structural.filters;
  if (filters.genres.length) {
    let knownGenres;
    try {
      knownGenres = await fetchGenreList();
    } catch (error) {
      console.warn(`AniList genre list unavailable: ${error.message}`);
      knownGenres = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Sci-Fi', 'Shounen'];
    }
    const validated = parseBrowseFilters(req.query, {
      knownGenres,
      maxYear: new Date().getFullYear() + 1
    });
    if (validated.errors.length) return res.status(400).json({ message: validated.errors[0] });
    filters = validated.filters;
  }

  try {
    const { data, source, meta } = await getBrowsePage(filters, structural.perPage);
    setBrowseHeaders(res, meta, source);
    return res.json(data);
  } catch (error) {
    console.warn(`AniList browse unavailable: ${error.message}`);
    const matches = filterCuratedCatalog(filters);
    const start = (filters.page - 1) * structural.perPage;
    const data = matches.slice(start, start + structural.perPage);
    const meta = normalizeBrowsePageMeta(null, {
      page: filters.page,
      perPage: structural.perPage,
      itemCount: data.length,
      maxPage: BROWSE_MAX_PAGE,
      totalCount: matches.length
    });
    setBrowseHeaders(res, meta, 'curated');
    return res.json(data);
  }
});

router.get('/genre/:genre', async (req, res) => {
  const genre = typeof req.params.genre === 'string' ? req.params.genre.trim() : '';
  if (!genre || genre.length > MAX_GENRE_LENGTH) {
    return res.status(400).json({ message: `Enter a genre name of 1 to ${MAX_GENRE_LENGTH} characters.` });
  }
  if (!GENRE_PATTERN.test(genre)) {
    return res.status(400).json({ message: "Genre contains invalid characters. Use letters, numbers, and .'- ." });
  }
  if (Array.isArray(req.query.type)) {
    return res.status(400).json({ message: 'Genre type must be provided once.' });
  }
  if (req.query.type !== undefined && typeof req.query.type !== 'string') {
    return res.status(400).json({ message: 'Genre type must be a string.' });
  }
  const type = req.query.type || '';
  if (type && !['series', 'movies'].includes(type)) {
    return res.status(400).json({ message: 'Genre type must be one of: series, movies.' });
  }
  if (ADULT_GENRES.has(genre.toLowerCase())) {
    res.setHeader('X-Catalog-Source', 'curated');
    return res.json([]);
  }

  try {
    const knownGenres = await fetchGenreList();
    const known = knownGenres.some(item => String(item).toLowerCase() === genre.toLowerCase());
    if (!known) {
      res.setHeader('X-Catalog-Source', 'curated');
      return res.json(curatedGenreFallback(genre));
    }

    const filters = {
      genres: [genre],
      sort: 'popularity',
      page: 1,
      format: type === 'series' ? 'TV' : type === 'movies' ? 'MOVIE' : null
    };
    const result = await fetchBrowsePage(filters, 30);
    const data = safeMedia(result.media).filter(item => {
      const genres = Array.isArray(item.genre) ? item.genre : [];
      if (!genres.some(itemGenre => String(itemGenre).toLowerCase() === genre.toLowerCase())) return false;
      if (type === 'series') return ['TV', 'TV_SHORT'].includes(String(item.type).toUpperCase());
      if (type === 'movies') return String(item.type).toUpperCase() === 'MOVIE';
      return true;
    });
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json(data);
  } catch (error) {
    console.warn(`AniList genre unavailable: ${error.message}`);
    res.setHeader('X-Catalog-Source', 'curated');
    return res.json(curatedGenreFallback(genre));
  }
});

router.get('/genres', async (_req, res) => {
  try {
    const genres = await fetchGenreList();
    return res.json([...new Set(genres)].sort((a, b) => a.localeCompare(b)));
  } catch (error) {
    console.warn(`AniList genres unavailable: ${error.message}`);
    return res.json([]);
  }
});

module.exports = router;
