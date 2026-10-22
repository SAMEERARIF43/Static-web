// ============================================================================
// PROVIDER ROUTER — Multi-Provider Fallback (Phase 5, Task 2)
// ============================================================================
//
// Provides a Kitsu (https://kitsu.io) fallback provider for when AniList
// returns zero results or is unreachable. Kitsu uses the JSON:API spec;
// responses are normalized into Anime Hub's canonical media schema.
//
// All functions are pure/async and have no side effects beyond HTTP requests,
// so they can be unit-tested in isolation with a mock fetch/axios.
//
// Canonical media schema (matches /api/browse and /api/search item shape):
//   { id, anilistId, title, coverImage: { large }, bannerImage, description,
//     format, season, seasonYear, averageScore, genres, status, countryOfOrigin,
//     studios: { nodes: [{ name }] }, studios, ... }
// ============================================================================

const axios = require('axios');

const KITSU_BASE_URL = process.env.KITSU_BASE_URL || 'https://kitsu.io/api/edge';
const KITSU_TIMEOUT_MS = 10000;

// Kitsu showType → AniList-compatible format string.
const KITSU_FORMAT_MAP = {
  TV: 'TV',
  TV_SHORT: 'TV_SHORT',
  MOVIE: 'MOVIE',
  SPECIAL: 'SPECIAL',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'MUSIC'
};

// Kitsu status → AniList-compatible status string.
const KITSU_STATUS_MAP = {
  current: 'RELEASING',
  finished: 'FINISHED',
  unreleased: 'NOT_YET_RELEASED',
  cancelled: 'CANCELLED'
};

/**
 * Normalize a single Kitsu JSON:API resource into the canonical media schema.
 * @param {object} resource - Kitsu JSON:API `data` resource object.
 * @returns {object} Canonical media item.
 */
function normalizeKitsuAnime(resource) {
  if (!resource || !resource.attributes) return null;
  const a = resource.attributes;
  const id = Number(resource.id);
  const titles = a.titles || {};
  const canonicalTitle = a.canonicalTitle || titles.en || titles.en_jp || titles.ja_jp || '';
  const posterImage = a.posterImage || {};
  const coverImage = a.coverImage || {};
  const studios = a.studios || [];
  const averageRating = Number(a.averageRating);
  const episodeCount = Number(a.episodeCount) || null;
  const startDate = a.startDate ? new Date(a.startDate) : null;
  const seasonYear = startDate ? startDate.getUTCFullYear() : null;
  const showType = KITSU_FORMAT_MAP[a.showType] || a.showType || 'TV';
  const status = KITSU_STATUS_MAP[a.status] || a.status || 'FINISHED';

  return {
    id,
    anilistId: id,
    title: canonicalTitle,
    coverImage: {
      large: posterImage.original || posterImage.small || null,
      extraLarge: posterImage.original || posterImage.small || null
    },
    bannerImage: coverImage.original || coverImage.small || null,
    description: a.synopsis || null,
    format: showType,
    season: null,
    seasonYear,
    averageScore: Number.isFinite(averageRating) ? Math.round(averageRating) : null,
    genres: [], // Kitsu does not include genres on the anime endpoint by default.
    status,
    countryOfOrigin: null, // Kitsu does not expose country of origin on this endpoint.
    episodes: episodeCount,
    totalEpisodes: episodeCount,
    studios: {
      nodes: studios.map(s => ({ name: s.name || s || '' }))
    },
    source: 'kitsu',
    provider: 'kitsu',
    sourceId: resource.id,
    _kitsuId: resource.id
  };
}

/**
 * Fetch anime from Kitsu by text search. Returns normalized canonical items
 * or an empty array on any error.
 * @param {string} title - Search query text.
 * @param {number} limit - Maximum number of results.
 * @returns {Promise<Array>} Normalized media items.
 */
async function fetchKitsuFallback(title, limit = 10) {
  if (!title || typeof title !== 'string') return [];
  const trimmed = title.trim();
  if (!trimmed) return [];

  try {
    const url = `${KITSU_BASE_URL}/anime?filter[text]=${encodeURIComponent(trimmed)}&page[limit]=${Math.min(Math.max(Number(limit) || 10, 1), 20)}`;
    const response = await axios.get(url, {
      headers: { 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json' },
      timeout: KITSU_TIMEOUT_MS
    });

    const data = response.data && response.data.data;
    if (!Array.isArray(data)) return [];

    return data.map(normalizeKitsuAnime).filter(Boolean);
  } catch (error) {
    console.warn(`[provider-router] Kitsu fallback failed for "${title}":`, error.message);
    return [];
  }
}

/**
 * Fetch a single Kitsu anime by Kitsu ID.
 * @param {string|number} kitsuId - Kitsu resource ID.
 * @returns {Promise<object|null>} Normalized media item or null.
 */
async function fetchKitsuAnimeById(kitsuId) {
  if (!kitsuId) return null;
  try {
    const url = `${KITSU_BASE_URL}/anime/${encodeURIComponent(kitsuId)}`;
    const response = await axios.get(url, {
      headers: { 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json' },
      timeout: KITSU_TIMEOUT_MS
    });
    const resource = response.data && response.data.data;
    if (!resource) return null;
    return normalizeKitsuAnime(resource);
  } catch (error) {
    console.warn(`[provider-router] Kitsu detail fetch failed for id ${kitsuId}:`, error.message);
    return null;
  }
}

/**
 * Check whether the Kitsu provider is reachable (lightweight probe).
 * @returns {Promise<boolean>}
 */
async function isKitsuAvailable() {
  try {
    const response = await axios.get(`${KITSU_BASE_URL}/anime?page[limit]=1`, {
      headers: { Accept: 'application/vnd.api+json' },
      timeout: 5000
    });
    return response.status === 200 && Array.isArray(response.data.data);
  } catch {
    return false;
  }
}

module.exports = {
  KITSU_BASE_URL,
  fetchKitsuFallback,
  fetchKitsuAnimeById,
  isKitsuAvailable,
  normalizeKitsuAnime
};
