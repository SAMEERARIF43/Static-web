// Recommendations route — used by server.js under /api/recommendations.
// Accepts GET with query parameters `genres` (comma-separated list) and
// `favorites` (comma-separated list of AniList IDs).
//
// The response parser deliberately consumes exactly what
// catalog-filters.buildRecommendationsGraphQL produces: `genrePage.media` for
// genre preferences and the recommendation edges hanging off
// `favoritePage.media`. AniList has no root-level `recommendations` field, so
// the two sides of this contract are kept in step here. When there is nothing
// to personalize, or AniList is unavailable, the curated catalog is served
// instead.

const express = require('express');
const axios = require('axios');
const {
  buildRecommendationsGraphQL,
  RECOMMENDATIONS_MAX_RESULTS
} = require('../catalog-filters');
const { CURATED_CATALOG } = require('../catalog-fallback');
const { getAniListUrl } = require('../anilist-endpoint');
const { deduplicateMediaList } = require('../search-utils');

const router = express.Router();
const REQUEST_TIMEOUT_MS = 10000;

function stringQueryParam(value) {
  return typeof value === 'string' ? value : '';
}

// Each requested genre carries an equal weight of 1, preserving the previous
// semantics of the endpoint.
function parseGenreWeights(genresParam) {
  return stringQueryParam(genresParam)
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length)
    .map(name => ({ name, weight: 1 }));
}

// `$favoriteIds: [Int!]` — anything that is not a positive safe integer would
// either be coerced into a wrong id or rejected by AniList outright.
function parseFavoriteIds(favoritesParam) {
  return stringQueryParam(favoritesParam)
    .split(',')
    .map(value => Number(value.trim()))
    .filter(id => Number.isSafeInteger(id) && id > 0)
    .map(String);
}

/**
 * Flatten an AniList recommendations payload into one de-duplicated list.
 * Favourites are more specific than a genre page, so their recommendation
 * edges lead and the genre page fills the remaining slots.
 * @param {object} payload raw GraphQL response body
 * @returns {object[]}
 */
function collectRecommendations(payload) {
  const genreMedia = payload?.data?.genrePage?.media;
  const favoriteMedia = payload?.data?.favoritePage?.media;

  const fromFavorites = (Array.isArray(favoriteMedia) ? favoriteMedia : [])
    .flatMap(media => (Array.isArray(media?.recommendations?.edges) ? media.recommendations.edges : []))
    .map(edge => edge?.node?.mediaRecommendation)
    .filter(Boolean);
  const fromGenres = Array.isArray(genreMedia) ? genreMedia : [];

  return deduplicateMediaList([...fromFavorites, ...fromGenres])
    .slice(0, RECOMMENDATIONS_MAX_RESULTS);
}

function curatedResponse() {
  return {
    source: 'curated',
    data: CURATED_CATALOG.slice(0, RECOMMENDATIONS_MAX_RESULTS).map(item => ({
      ...item,
      anilistId: item.anilistId || item.id
    }))
  };
}

router.get('/', async (req, res) => {
  const genreWeights = parseGenreWeights(req.query.genres);
  const favoriteIds = parseFavoriteIds(req.query.favorites);

  if (!genreWeights.length && !favoriteIds.length) {
    // Nothing to personalize: skip the upstream round trip entirely rather than
    // sending a query that could not select anything useful.
    return res.json(curatedResponse());
  }

  const { query, variables } = buildRecommendationsGraphQL({ genreWeights, favoriteIds });

  try {
    const response = await axios.post(
      getAniListUrl(),
      { query, variables },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT_MS
      }
    );

    if (response.data?.errors) {
      throw new Error(response.data.errors.map(error => error.message).join('; '));
    }

    const recommendations = collectRecommendations(response.data);
    if (!recommendations.length) return res.json(curatedResponse());

    return res.json({ source: 'anilist', data: recommendations });
  } catch (error) {
    console.error('Recommendations error:', error.message);
    return res.json(curatedResponse());
  }
});

module.exports = router;
