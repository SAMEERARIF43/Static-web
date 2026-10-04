/**
 * Search and normalization utilities for AnimeHub.
 */

function searchAnimeLocal(animeDb, query) {
  if (!query || typeof query !== 'string') return [];
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return [];

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

  const matched = (animeDb || []).filter(anime => {
    if (!anime) return false;
    const title = (anime.title || '').toLowerCase();
    const genres = (anime.genre || anime.genres || []).map(g => String(g).toLowerCase());
    const studio = (anime.studio || '').toLowerCase();
    const type = (anime.type || anime.format || '').toLowerCase();

    // Direct substring match in title, genres, or studio
    if (title.includes(normalizedQuery)) return true;
    if (genres.some(g => g.includes(normalizedQuery))) return true;
    if (studio.includes(normalizedQuery)) return true;

    // Multi-token match across fields
    return tokens.every(token =>
      title.includes(token) ||
      genres.some(g => g.includes(token)) ||
      studio.includes(token) ||
      type.includes(token)
    );
  });

  // Relevance ranking: exact match > prefix match > substring match > score
  matched.sort((a, b) => {
    const titleA = (a.title || '').toLowerCase();
    const titleB = (b.title || '').toLowerCase();

    const exactA = titleA === normalizedQuery ? 4 : 0;
    const exactB = titleB === normalizedQuery ? 4 : 0;
    if (exactA !== exactB) return exactB - exactA;

    const startsA = titleA.startsWith(normalizedQuery) ? 3 : 0;
    const startsB = titleB.startsWith(normalizedQuery) ? 3 : 0;
    if (startsA !== startsB) return startsB - startsA;

    const containsA = titleA.includes(normalizedQuery) ? 2 : 0;
    const containsB = titleB.includes(normalizedQuery) ? 2 : 0;
    if (containsA !== containsB) return containsB - containsA;

    return (b.rating || 0) - (a.rating || 0);
  });

  // Deduplicate by ID
  const seen = new Set();
  return matched.filter(anime => {
    const key = anime.anilistId || anime.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateMediaList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter(item => {
    if (!item) return false;
    const id = item.id || item.anilistId;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function mapLocalAnimeToAniList(anime) {
  const poster = anime.poster || anime.image || null;
  return {
    id: anime.anilistId || anime.id,
    title: {
      english: anime.title,
      romaji: anime.title,
      native: null
    },
    coverImage: {
      large: poster,
      extraLarge: poster
    },
    description: anime.description || '',
    episodes: anime.episodes || null,
    status: anime.status || 'UNKNOWN',
    averageScore: anime.rating ? Math.round(anime.rating * 10) : null,
    genres: anime.genre || anime.genres || [],
    season: null,
    seasonYear: anime.year || null,
    format: anime.type || 'TV',
    studios: {
      nodes: anime.studio ? [{ name: anime.studio }] : []
    },
    countryOfOrigin: 'JP'
  };
}

module.exports = { mapLocalAnimeToAniList, searchAnimeLocal, deduplicateMediaList };
