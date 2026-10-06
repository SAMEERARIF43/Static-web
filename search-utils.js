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

function normalizeSearchText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')
    : '';
}

function titleVariants(anime) {
  const title = anime?.title;
  if (typeof title === 'string') return [title];
  return [title?.english, title?.romaji, title?.native].filter(value => typeof value === 'string');
}

function differsByOneCharacter(first, second) {
  if (Math.abs(first.length - second.length) > 1) return false;

  let firstIndex = 0;
  let secondIndex = 0;
  let differences = 0;

  while (firstIndex < first.length && secondIndex < second.length) {
    if (first[firstIndex] === second[secondIndex]) {
      firstIndex += 1;
      secondIndex += 1;
      continue;
    }

    differences += 1;
    if (differences > 1) return false;

    if (
      firstIndex + 1 < first.length &&
      secondIndex + 1 < second.length &&
      first[firstIndex] === second[secondIndex + 1] &&
      first[firstIndex + 1] === second[secondIndex]
    ) {
      firstIndex += 2;
      secondIndex += 2;
    } else if (first.length > second.length) {
      firstIndex += 1;
    } else if (first.length < second.length) {
      secondIndex += 1;
    } else {
      firstIndex += 1;
      secondIndex += 1;
    }
  }

  return differences + Number(firstIndex < first.length || secondIndex < second.length) <= 1;
}

function suggestionMatchRank(anime, query) {
  const normalizedQuery = normalizeSearchText(query);
  const titles = titleVariants(anime).map(normalizeSearchText).filter(Boolean);
  if (!normalizedQuery || !titles.length) return 0;
  if (titles.some(title => title === normalizedQuery)) return 4;
  if (titles.some(title => title.startsWith(normalizedQuery))) return 3;

  const queryTokens = normalizedQuery.split(' ');
  const titleTokens = titles.map(title => title.split(' '));
  const fuzzyTokenMatch = titleTokens.some(tokens =>
    queryTokens.every(queryToken =>
      tokens.some(titleToken => titleToken === queryToken || differsByOneCharacter(titleToken, queryToken))
    ) &&
    queryTokens.some(queryToken =>
      tokens.some(titleToken => titleToken !== queryToken && differsByOneCharacter(titleToken, queryToken))
    )
  );
  if (fuzzyTokenMatch || titles.some(title => differsByOneCharacter(title, normalizedQuery))) return 2;

  if (titles.some(title => title.includes(normalizedQuery))) return 1;
  if (titleTokens.some(tokens => queryTokens.every(queryToken => tokens.some(token => token.includes(queryToken))))) return 1;
  return 0;
}

function rankAnimeSuggestions(animeList, query) {
  return (Array.isArray(animeList) ? animeList : [])
    .map((anime, index) => ({ anime, index, rank: suggestionMatchRank(anime, query) }))
    .sort((first, second) => second.rank - first.rank || first.index - second.index)
    .map(({ anime }) => anime);
}

function searchAnimeLocalFuzzy(animeDb, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || normalizedQuery.length < 2) return [];

  const queryTokens = normalizedQuery.split(' ');
  return (Array.isArray(animeDb) ? animeDb : []).filter(anime => {
    const titleTokens = titleVariants(anime).map(normalizeSearchText).flatMap(title => title.split(' '));
    let hasTypo = false;
    const allTokensMatch = queryTokens.every(queryToken =>
      titleTokens.some(titleToken => {
        if (titleToken === queryToken) return true;
        const isTypoMatch = differsByOneCharacter(titleToken, queryToken);
        hasTypo ||= isTypoMatch;
        return isTypoMatch;
      })
    );
    return allTokensMatch && hasTypo;
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
    bannerImage: anime.banner || null,
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

module.exports = {
  mapLocalAnimeToAniList,
  rankAnimeSuggestions,
  searchAnimeLocal,
  searchAnimeLocalFuzzy,
  suggestionMatchRank,
  deduplicateMediaList
};
