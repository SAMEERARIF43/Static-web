// AniList-backed anime search and autocomplete routes.

const axios = require('axios');
const express = require('express');
const {
  mapLocalAnimeToAniList,
  rankAnimeSuggestions,
  searchAnimeLocal,
  searchAnimeLocalFuzzy,
  suggestionMatchRank,
  deduplicateMediaList
} = require('../search-utils');
const { mapAniListMediaToCatalogItem } = require('../catalog-utils');
const { CURATED_CATALOG } = require('../catalog-fallback');
const { boundedCacheSet } = require('../catalog-filters');
const { CATALOG_CACHE_TTL_MS } = require('../catalog-cache');

const { getAniListUrl } = require('../anilist-endpoint');

const router = express.Router();
const REQUEST_TIMEOUT_MS = 15000;
const SEARCH_CACHE_LIMIT = 100;
const searchCache = new Map();
const pendingSearchRequests = new Map();

function hasControlCharacter(value) {
  return [...value].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function localFallback(query) {
  const onePiece = {
    anilistId: 21,
    title: 'One Piece',
    genre: ['Action', 'Adventure', 'Fantasy'],
    type: 'TV',
    year: 1999,
    rating: 9,
    language: 'Japanese'
  };
  const local = [
    ...CURATED_CATALOG.map(item => ({ ...item, title: item.title.english })),
    onePiece
  ];
  return deduplicateMediaList([
    ...searchAnimeLocal(local, query).map(mapLocalAnimeToAniList),
    ...searchAnimeLocalFuzzy(local, query).map(mapLocalAnimeToAniList)
  ]);
}

async function fetchSearchMedia(query) {
  const graphqlQuery = `query ($search: String) {
    Page(perPage: 10) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id title { romaji english native }
        coverImage { large extraLarge } bannerImage description episodes
        status averageScore genres season seasonYear format countryOfOrigin
        studios(isMain: true) { nodes { name } }
      }
    }
  }`;
  const response = await axios.post(getAniListUrl(), {
    query: graphqlQuery,
    variables: { search: query }
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT_MS
  });
  if (response.data?.errors) throw new Error(response.data.errors.map(error => error.message).join('; '));
  const media = response.data?.data?.Page?.media;
  if (!Array.isArray(media)) throw new Error('AniList returned an invalid search response.');
  return deduplicateMediaList(media);
}

function mapSuggestion(media) {
  const id = media.id || media.anilistId;
  const poster = media.coverImage?.extraLarge || media.coverImage?.large || media.poster || media.image || null;
  return {
    id,
    anilistId: id,
    title: media.title,
    coverImage: { large: poster },
    bannerImage: media.bannerImage || media.banner || null,
    format: media.format || media.type || null,
    season: media.season || null,
    seasonYear: media.seasonYear || media.year || null,
    averageScore: media.averageScore || (media.rating ? Math.round(media.rating * 10) : null)
  };
}

router.get('/', async (req, res) => {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q : '';
  if (hasControlCharacter(rawQuery)) {
    return res.status(400).json({ message: 'Search query contains characters that are not allowed.' });
  }
  const query = rawQuery.trim();
  if (!query || query.length > 100) {
    return res.status(400).json({ message: 'Enter an anime name of 1 to 100 characters.' });
  }

  // Fresh cache hit (case-insensitive key) is served without touching AniList;
  // the entry is re-inserted so hot queries age out last.
  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    searchCache.delete(cacheKey);
    searchCache.set(cacheKey, cached);
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json(cached.results);
  }
  const staleResults = cached ? cached.results : null;

  // Single-flight: concurrent identical queries share one upstream call.
  let pendingSearch = pendingSearchRequests.get(cacheKey);
  if (!pendingSearch) {
    pendingSearch = fetchSearchMedia(query);
    pendingSearchRequests.set(cacheKey, pendingSearch);
  }

  try {
    const results = await pendingSearch;
    if (pendingSearchRequests.get(cacheKey) === pendingSearch) {
      pendingSearchRequests.delete(cacheKey);
    }
    // Map raw AniList media items through the catalog mapper so search
    // results expose the same canonical fields as browse results
    // (anilistId, countryOfOrigin, language, human-readable status).
    const mappedResults = results.map(mapAniListMediaToCatalogItem);
    boundedCacheSet(searchCache, cacheKey, {
      results: mappedResults,
      expiresAt: Date.now() + CATALOG_CACHE_TTL_MS
    }, SEARCH_CACHE_LIMIT);
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json(mappedResults);
  } catch (error) {
    if (pendingSearchRequests.get(cacheKey) === pendingSearch) {
      pendingSearchRequests.delete(cacheKey);
    }
    // The last good answer outranks the local fallback; the failure itself is
    // never cached, so the next request retries AniList.
    if (staleResults) {
      console.warn(`AniList search unavailable; using cached results: ${error.message}`);
      res.setHeader('X-Catalog-Source', 'anilist');
      return res.json(staleResults);
    }
    console.warn(`AniList search unavailable: ${error.message}`);
    res.setHeader('X-Catalog-Source', 'local');
    return res.json(localFallback(query));
  }
});

router.get('/suggestions', async (req, res) => {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q : '';
  if (hasControlCharacter(rawQuery)) {
    return res.status(400).json({ message: 'Search query contains characters that are not allowed.' });
  }
  const query = rawQuery.trim();
  if (query.length < 2 || query.length > 100) {
    return res.status(400).json({ message: 'Enter an anime name of 2 to 100 characters.' });
  }

  try {
    const media = await fetchSearchMedia(query);
    const local = localFallback(query);
    const ranked = rankAnimeSuggestions(deduplicateMediaList([...local, ...media]), query)
      .filter(item => suggestionMatchRank(item, query) > 0)
      .slice(0, 10)
      .map(mapSuggestion);
    return res.json(ranked);
  } catch (error) {
    console.warn(`AniList suggestions unavailable: ${error.message}`);
    const fallback = localFallback(query).map(mapSuggestion);
    if (fallback.length) return res.json(fallback);
    return res.status(502).json({ message: 'Suggestions are temporarily unavailable.' });
  }
});

module.exports = router;
