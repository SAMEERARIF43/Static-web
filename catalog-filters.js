/**
 * Catalog filter parsing, validation and query building for AnimeHub.
 *
 * Shared by `server.js` and the test suite (same convention as `search-utils.js`
 * and `catalog-utils.js`). Every user-supplied value is validated against an
 * allowlist or a numeric range here, and every value that reaches AniList is
 * bound as a GraphQL variable — never interpolated into the query document.
 */

// AniList media fields shared by every catalog query. Kept here so the filter
// query and the fixed catalogs select exactly the same shape.
const CATALOG_MEDIA_FIELDS = `
  id
  title {
    romaji
    english
    native
  }
  coverImage {
    large
    extraLarge
  }
  bannerImage
  description
  episodes
  status
  averageScore
  genres
  season
  seasonYear
  startDate {
    year
  }
  format
  countryOfOrigin
  studios(isMain: true) {
    nodes {
      name
    }
  }
`;

// Sort option (public, friendly name) -> AniList MediaSort enum values.
// Only these four are ever sent; the client can never choose an arbitrary sort.
const CATALOG_SORTS = {
  popularity: ['POPULARITY_DESC'],
  score: ['SCORE_DESC'],
  newest: ['START_DATE_DESC'],
  title: ['TITLE_ROMAJI']
};
const DEFAULT_SORT = 'popularity';

const CATALOG_STATUSES = ['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'HIATUS', 'CANCELLED'];

// AniList's status enum -> the labels the curated catalog uses, and vice versa.
// `normalizeStatus` accepts both so the same filter value works on live and
// curated data.
const STATUS_LABELS = {
  FINISHED: 'Completed',
  RELEASING: 'Airing',
  NOT_YET_RELEASED: 'Upcoming',
  HIATUS: 'Hiatus',
  CANCELLED: 'Cancelled'
};
const CURATED_STATUS_TO_ENUM = {
  completed: 'FINISHED',
  finished: 'FINISHED',
  airing: 'RELEASING',
  releasing: 'RELEASING',
  upcoming: 'NOT_YET_RELEASED',
  'not yet released': 'NOT_YET_RELEASED',
  hiatus: 'HIATUS',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED'
};

const ADULT_GENRES = new Set(['hentai']);
const MAX_GENRE_LENGTH = 50;
const MAX_GENRE_FILTERS = 10;
const CATALOG_PER_PAGE = 30;

// Genre names may contain letters (any script), digits and basic punctuation.
const GENRE_PATTERN = /^[\p{L}\p{N}\s'.-]+$/u;
const SEASON_PATTERN = /^[A-Za-z]+$/;

/** Normalize a status value (AniList enum or curated label) to the AniList enum. */
function normalizeStatus(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const upper = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (CATALOG_STATUSES.includes(upper)) return upper;
  return CURATED_STATUS_TO_ENUM[raw.trim().toLowerCase()] || '';
}

/** Parse a positive integer parameter, or return null when unusable. */
function parseInteger(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!/^-?\d+$/.test(raw)) return NaN;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : NaN;
}

/** Build the lowercase -> canonical-display lookup for a genre allowlist. */
function buildGenreLookup(knownGenres) {
  const lookup = new Map();
  for (const name of knownGenres || []) {
    const display = String(name).trim();
    if (display) lookup.set(display.toLowerCase(), display);
  }
  return lookup;
}

/**
 * Validate a comma-separated multi-genre value against the allowlist.
 * Returns the canonical spellings; the first problem is pushed into `errors`
 * and an empty list is returned. Adult genres never reach this point: the
 * caller deletes them from the lookup, so they are rejected as unknown.
 *
 * When `skipGenreMembership` is true the allowlist membership check is
 * deferred: malformed or over-length values are still rejected, but a
 * syntactically-valid genre is accepted without loading the provider-backed
 * allowlist. The caller is then responsible for confirming membership (and
 * canonical spelling) once the allowlist is available.
 */
function collectGenres(rawValue, genreLookup, errors, skipGenreMembership = false) {
  const requested = String(rawValue).split(',').map(part => part.trim()).filter(Boolean);
  if (requested.length > MAX_GENRE_FILTERS) {
    errors.push(`Select at most ${MAX_GENRE_FILTERS} genres.`);
    return [];
  }
  const genres = [];
  for (const name of requested) {
    if (name.length > MAX_GENRE_LENGTH) {
      errors.push(`Each genre must be ${MAX_GENRE_LENGTH} characters or fewer.`);
      return [];
    }
    if (!GENRE_PATTERN.test(name)) {
      errors.push('Genre contains characters that are not allowed.');
      return [];
    }
    const lower = name.toLowerCase();
    if (!skipGenreMembership && genreLookup && !genreLookup.has(lower)) {
      errors.push(`Unknown genre: "${name}".`);
      return [];
    }
    if (!genres.some(existing => existing.toLowerCase() === lower)) {
      // Keep the known-canonical spelling so AniList matches case-sensitively.
      genres.push(skipGenreMembership ? name : (genreLookup ? genreLookup.get(lower) : name));
    }
  }
  return genres;
}

/**
 * Read one query parameter, rejecting repeated (array-valued) occurrences.
 * URLSearchParams exposes repeats through `getAll()`; Express plain objects
 * produce arrays. Unrelated names are never read, so they stay ignored.
 */
function readStrictParam(query, name, errors) {
  if (!query) return null;
  if (typeof query.getAll === 'function') {
    const values = query.getAll(name);
    if (values.length > 1) {
      errors.push(`${name} must not be provided more than once.`);
      return null;
    }
    return values.length ? values[0] : null;
  }
  const value = query[name];
  if (Array.isArray(value)) {
    errors.push(`${name} must not be provided more than once.`);
    return null;
  }
  if (value === undefined || value === null) return null;
  return String(value);
}

/**
 * Build the AniList query document and its variables for a validated filter set.
 * Every user value is a variable; nothing user-supplied is interpolated.
 */
function buildCatalogGraphQL(filters, { perPage = CATALOG_PER_PAGE } = {}) {
  // Only the arguments that are actually set are included. AniList rejects
  // some null arguments outright ("Illegal operator and value combination" for
  // averageScore_greater: null) and treats others as a filter, so an unset
  // filter must be omitted rather than sent as null.
  const args = ['type: ANIME', 'isAdult: false', 'sort: $sort'];
  const variableDefinitions = ['$page: Int', '$perPage: Int', '$sort: [MediaSort]'];
  const variables = {
    page: filters.page || 1,
    perPage,
    sort: CATALOG_SORTS[filters.sort] || CATALOG_SORTS[DEFAULT_SORT]
  };

  if (filters.genres && filters.genres.length) {
    args.push('genre_in: $genre_in');
    variableDefinitions.push('$genre_in: [String]');
    variables.genre_in = filters.genres;
  }
  if (filters.season) {
    args.push('season: $season');
    variableDefinitions.push('$season: MediaSeason');
    variables.season = filters.season;
  }
  const seasonYear = filters.seasonYear ?? filters.year;
  if (seasonYear) {
    args.push('seasonYear: $seasonYear');
    variableDefinitions.push('$seasonYear: Int');
    variables.seasonYear = seasonYear;
  }
  if (filters.format) {
    args.push('format: $format');
    variableDefinitions.push('$format: MediaFormat');
    variables.format = filters.format;
  }
  if (filters.status) {
    args.push('status: $status');
    variableDefinitions.push('$status: MediaStatus');
    variables.status = filters.status;
  }
  if (filters.countryOfOrigin) {
    args.push('countryOfOrigin: $countryOfOrigin');
    variableDefinitions.push('$countryOfOrigin: String');
    variables.countryOfOrigin = filters.countryOfOrigin;
  }
  if (filters.minScore !== null && filters.minScore !== undefined) {
    args.push('averageScore_greater: $minScore');
    variableDefinitions.push('$minScore: Int');
    variables.minScore = filters.minScore;
  }

  // pageInfo carries the real totals so the client can render an honest
  // "page N of M" and disable Next on the last page instead of guessing from a
  // full-size page (a filtered page can legitimately return fewer than perPage).
  const query = `query (${variableDefinitions.join(', ')}) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      total
      perPage
      currentPage
      lastPage
      hasNextPage
    }
    media(${args.join(', ')}) {
      ${CATALOG_MEDIA_FIELDS}
    }
  }
}`;

  return { query, variables };
}

/** Numeric score for any catalog item, normalized to AniList's 0-100 scale. */
function scoreOf(item) {
  if (Number.isFinite(item?.averageScore) && item.averageScore > 0) return item.averageScore;
  if (Number.isFinite(item?.rating) && item.rating > 0) return item.rating * 10;
  return 0;
}

function formatOf(item) {
  return String(item?.format || item?.type || '').toUpperCase();
}

function yearOf(item) {
  const year = item?.seasonYear ?? item?.year;
  return Number.isFinite(Number(year)) ? Number(year) : null;
}

function genresOf(item) {
  const value = item?.genres || item?.genre || [];
  return (Array.isArray(value) ? value : [value]).map(entry => String(entry).toLowerCase());
}

/** Normalize a local catalog item's country into the browse allowlist. */
function browseCountryOf(item) {
  const country = String(item?.countryOfOrigin || '').trim().toUpperCase();
  return BROWSE_COUNTRIES.includes(country) ? country : 'OTHER';
}

/**
 * Filter and sort catalog items locally. Used for the curated fallback so the
 * same filter/sort semantics apply when AniList is unreachable.
 */
function filterCatalogLocally(items, filters) {
  const list = Array.isArray(items) ? items : [];
  const wantedGenres = filters.genres || [];
  const wantedStatus = filters.status || null;
  const wantedCountry = filters.countryOfOrigin || null;

  const matched = list.filter(item => {
    if (!item) return false;

    if (wantedGenres.length) {
      const genres = genresOf(item);
      // Mirrors AniList's genre_in: match ANY of the selected genres.
      if (!wantedGenres.some(genre => genres.includes(String(genre).toLowerCase()))) return false;
    }
    const seasonYear = filters.seasonYear ?? filters.year;
    if (seasonYear !== null && seasonYear !== undefined && yearOf(item) !== seasonYear) return false;
    if (filters.season) {
      const season = String(item?.season || '').trim().toUpperCase();
      if (!season || season !== filters.season) return false;
    }
    if (filters.format && formatOf(item) !== filters.format) return false;
    if (wantedStatus && normalizeStatus(item?.status) !== wantedStatus) return false;
    if (wantedCountry && browseCountryOf(item) !== wantedCountry) return false;
    if (filters.minScore !== null && filters.minScore !== undefined && scoreOf(item) < filters.minScore) return false;
    return true;
  });

  const sorted = [...matched];
  if (filters.sort === 'score') {
    sorted.sort((a, b) => scoreOf(b) - scoreOf(a));
  } else if (filters.sort === 'newest') {
    sorted.sort((a, b) => (yearOf(b) || 0) - (yearOf(a) || 0));
  } else if (filters.sort === 'title') {
    sorted.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  }
  // 'popularity' keeps the curated/catalog order supplied by the caller.

  return sorted;
}

/** Best-effort display title for local sorting. */
function titleOf(item) {
  const title = item?.title;
  if (typeof title === 'string') return title;
  return title?.english || title?.romaji || title?.native || '';
}

// ---- /api/browse (Task 2A) --------------------------------------------------
// Strict filters for the Popular page: fixed enum spellings, a tighter year
// range, page 1..50, perPage 1..30, and repeated (array-valued) parameters
// rejected outright instead of silently taking the first value.
const BROWSE_SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const BROWSE_FORMATS = ['TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'];
const BROWSE_STATUSES = ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED'];
const BROWSE_COUNTRIES = ['JP', 'CN', 'US', 'KR', 'IN', 'FR', 'GB', 'CA', 'BR', 'OTHER'];
const BROWSE_SORTS = ['POPULARITY_DESC', 'SCORE_DESC', 'START_DATE_DESC', 'TITLE_ROMAJI'];
const DEFAULT_BROWSE_SORT = 'POPULARITY_DESC';
const BROWSE_MIN_YEAR = 1960;
const BROWSE_MAX_PAGE = 50;
const BROWSE_MAX_PER_PAGE = 30;
const BROWSE_DEFAULT_PER_PAGE = 30;

// Browse sort enum -> the friendly sort key consumed by `buildCatalogGraphQL`
// and `filterCatalogLocally`, so the query builder and the curated fallback
// are shared unchanged between both endpoints.
const BROWSE_SORT_KEYS = {
  POPULARITY_DESC: 'popularity',
  SCORE_DESC: 'score',
  START_DATE_DESC: 'newest',
  TITLE_ROMAJI: 'title'
};

/**
 * Normalize provider pagination into the bounded contract exposed by browse.
 * Provider metadata is untrusted: malformed totals, page sizes, and booleans
 * must never make the client advertise a page outside the supported window.
 */
function normalizeBrowsePageMeta(pageInfo, {
  page = 1,
  perPage = BROWSE_DEFAULT_PER_PAGE,
  itemCount = 0,
  totalCount = null,
  maxPage = BROWSE_MAX_PAGE
} = {}) {
  const requestedPage = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const requestedPerPage = Number.isSafeInteger(perPage) && perPage >= 1
    ? perPage
    : BROWSE_DEFAULT_PER_PAGE;
  const pageLimit = Number.isSafeInteger(maxPage) && maxPage >= 1 ? maxPage : BROWSE_MAX_PAGE;
  const provider = pageInfo && typeof pageInfo === 'object' && !Array.isArray(pageInfo)
    ? pageInfo
    : {};
  const providerTotal = Number.isSafeInteger(provider.total) && provider.total >= 0
    ? provider.total
    : Number.isSafeInteger(totalCount) && totalCount >= 0
      ? totalCount
      : null;
  const providerLastPage = Number.isSafeInteger(provider.lastPage) && provider.lastPage >= 1
    ? provider.lastPage
    : null;
  const providerHasNext = typeof provider.hasNextPage === 'boolean'
    ? provider.hasNextPage
    : Number.isSafeInteger(itemCount) && itemCount >= requestedPerPage;
  const calculatedPages = providerTotal !== null
    ? Math.ceil(providerTotal / requestedPerPage)
    : providerLastPage || requestedPage + (providerHasNext ? 1 : 0);
  const totalPages = Math.min(
    pageLimit,
    Math.max(1, Number.isSafeInteger(calculatedPages) ? calculatedPages : 1)
  );

  return {
    page: requestedPage,
    perPage: requestedPerPage,
    total: providerTotal,
    totalPages,
    hasNext: requestedPage < pageLimit && providerHasNext
  };
}

/**
 * Parse and validate the `/api/browse` query string.
 *
 * Every parameter is checked against an allowlist or a numeric range, and a
 * repeated parameter is rejected rather than truncated. The returned `filters`
 * use the shape `buildCatalogGraphQL` and `filterCatalogLocally` expect, so
 * the query builder and the curated fallback work unchanged; `sort` arrives
 * as a browse enum and is mapped to the friendly key (`SCORE_DESC` -> `score`).
 *
 * @param {object|URLSearchParams} query raw request query params
 * @param {{ knownGenres?: Iterable<string>, maxYear?: number }} [options]
 * @returns {{ filters: object, perPage: number, errors: string[] }}
 */
function parseBrowseFilters(query, options = {}) {
  const errors = [];
  const maxYear = Number.isInteger(options.maxYear) ? options.maxYear : new Date().getFullYear() + 1;
  const skipGenreMembership = options.skipGenreMembership === true;
  const genreLookup = buildGenreLookup(options.knownGenres);
  // Adult genres are not part of the public allowlist: removing them from the
  // lookup means `genre=Hentai` is rejected as unknown instead of silently
  // widening the result set.
  for (const adult of ADULT_GENRES) genreLookup.delete(adult);

  const filters = {
    genres: [],
    year: null,
    seasonYear: null,
    season: null,
    format: null,
    status: null,
    countryOfOrigin: null,
    minScore: null,
    sort: BROWSE_SORT_KEYS[DEFAULT_BROWSE_SORT],
    page: 1
  };
  let perPage = BROWSE_DEFAULT_PER_PAGE;

  // ---- genre (comma-separated multi-select, allowlisted) ------------------
  const rawGenre = readStrictParam(query, 'genre', errors);
  if (rawGenre !== null && rawGenre.trim() !== '') {
    filters.genres = collectGenres(rawGenre, genreLookup, errors, skipGenreMembership);
  }

  // ---- year / seasonYear (1960 .. current year + 1) ------------------------
  const rawYear = readStrictParam(query, 'year', errors);
  const rawSeasonYear = readStrictParam(query, 'seasonYear', errors);
  const hasYear = rawYear !== null && rawYear.trim() !== '';
  const hasSeasonYear = rawSeasonYear !== null && rawSeasonYear.trim() !== '';
  if (hasYear && hasSeasonYear) {
    errors.push('Use either year or seasonYear, not both.');
  } else if (hasYear || hasSeasonYear) {
    const rawValue = hasSeasonYear ? rawSeasonYear : rawYear;
    const year = parseInteger(rawValue);
    if (year === null || Number.isNaN(year)) {
      errors.push('Year/seasonYear must be a whole number.');
    } else if (year < BROWSE_MIN_YEAR || year > maxYear) {
      errors.push(`Year must be between ${BROWSE_MIN_YEAR} and ${maxYear}.`);
    } else {
      filters.year = year;
      filters.seasonYear = year;
    }
  }

  // ---- season --------------------------------------------------------------
  const rawSeason = readStrictParam(query, 'season', errors);
  if (rawSeason !== null && rawSeason.trim() !== '') {
    const season = rawSeason.trim().toUpperCase();
    if (!SEASON_PATTERN.test(season) || !BROWSE_SEASONS.includes(season)) {
      errors.push(`Season must be one of: ${BROWSE_SEASONS.join(', ')}.`);
    } else {
      filters.season = season;
    }
  }

  // ---- format --------------------------------------------------------------
  const rawFormat = readStrictParam(query, 'format', errors);
  if (rawFormat !== null && rawFormat.trim() !== '') {
    const format = rawFormat.trim().toUpperCase();
    if (!BROWSE_FORMATS.includes(format)) {
      errors.push(`Format must be one of: ${BROWSE_FORMATS.join(', ')}.`);
    } else {
      filters.format = format;
    }
  }

  // ---- status --------------------------------------------------------------
  const rawStatus = readStrictParam(query, 'status', errors);
  if (rawStatus !== null && rawStatus.trim() !== '') {
    const status = rawStatus.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!BROWSE_STATUSES.includes(status)) {
      errors.push(`Status must be one of: ${BROWSE_STATUSES.join(', ')}.`);
    } else {
      filters.status = status;
    }
  }

  // ---- country of origin (allowlisted, case-normalized) --------------------
  const rawCountryOfOrigin = readStrictParam(query, 'countryOfOrigin', errors);
  if (rawCountryOfOrigin !== null && rawCountryOfOrigin.trim() !== '') {
    const countryOfOrigin = rawCountryOfOrigin.trim().toUpperCase();
    if (!BROWSE_COUNTRIES.includes(countryOfOrigin)) {
      errors.push(`Country of origin must be one of: ${BROWSE_COUNTRIES.join(', ')}.`);
    } else {
      filters.countryOfOrigin = countryOfOrigin;
    }
  }

  // ---- minimum score (0-100) -----------------------------------------------
  const rawScore = readStrictParam(query, 'minScore', errors);
  if (rawScore !== null && rawScore.trim() !== '') {
    const score = parseInteger(rawScore);
    if (score === null || Number.isNaN(score)) {
      errors.push('Minimum score must be a whole number.');
    } else if (score < 0 || score > 100) {
      errors.push('Minimum score must be between 0 and 100.');
    } else {
      filters.minScore = score;
    }
  }

  // ---- sort (AniList MediaSort enums) --------------------------------------
  const rawSort = readStrictParam(query, 'sort', errors);
  if (rawSort !== null && rawSort.trim() !== '') {
    const sort = rawSort.trim().toUpperCase();
    if (!BROWSE_SORTS.includes(sort)) {
      errors.push(`Sort must be one of: ${BROWSE_SORTS.join(', ')}.`);
    } else {
      filters.sort = BROWSE_SORT_KEYS[sort];
    }
  }

  // ---- page (1..50) ---------------------------------------------------------
  // The single-page app already uses `?page=` for its own route, so a request
  // carrying `page=popular` is an unknown *value* here and answers 400. The
  // frontend builds its API query separately and never sends the route marker.
  const rawPage = readStrictParam(query, 'page', errors);
  if (rawPage !== null && rawPage.trim() !== '') {
    const page = parseInteger(rawPage);
    if (page === null || Number.isNaN(page)) {
      errors.push('Page must be a whole number.');
    } else if (page < 1 || page > BROWSE_MAX_PAGE) {
      errors.push(`Page must be between 1 and ${BROWSE_MAX_PAGE}.`);
    } else {
      filters.page = page;
    }
  }

  // ---- perPage (1..30) ------------------------------------------------------
  const rawPerPage = readStrictParam(query, 'perPage', errors);
  if (rawPerPage !== null && rawPerPage.trim() !== '') {
    const size = parseInteger(rawPerPage);
    if (size === null || Number.isNaN(size)) {
      errors.push('perPage must be a whole number.');
    } else if (size < 1 || size > BROWSE_MAX_PER_PAGE) {
      errors.push(`perPage must be between 1 and ${BROWSE_MAX_PER_PAGE}.`);
    } else {
      perPage = size;
    }
  }

  return { filters, perPage, errors };
}

/**
 * Normalized cache key for `/api/browse`. Genres are lowercased and sorted so
 * `genre=Action,Comedy` and `genre=comedy,action` share one entry; page and
 * perPage are part of the key because they address different slices.
 */
function browseCacheKey(filters, perPage) {
  return JSON.stringify([
    [...(filters.genres || [])].map(genre => genre.toLowerCase()).sort(),
    filters.seasonYear ?? filters.year ?? null,
    filters.season ?? null,
    filters.format ?? null,
    filters.status ?? null,
    filters.countryOfOrigin ? String(filters.countryOfOrigin).trim().toUpperCase() : null,
    filters.minScore ?? null,
    filters.sort ?? null,
    filters.page ?? 1,
    Number.isInteger(perPage) ? perPage : BROWSE_DEFAULT_PER_PAGE
  ]);
}

const RECOMMENDATIONS_MAX_GENRES = 20;
const RECOMMENDATIONS_MAX_FAVORITE_IDS = 30;
const RECOMMENDATIONS_MAX_RESULTS = 30;
const RECOMMENDATION_GENRE_PATTERN = /^[\p{L}\p{N}\s'.-]+$/u;

/**
 * Validate the untrusted, client-owned recommendation inputs. The server never
 * persists this data; it is only used to bind a short-lived AniList request.
 */
function parseRecommendationInput(input) {
  const errors = [];
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const genreWeights = Object.create(null);
  const rawWeights = body.genreWeights;
  if (rawWeights !== undefined) {
    if (!rawWeights || typeof rawWeights !== 'object' || Array.isArray(rawWeights)) {
      errors.push('genreWeights must be an object of genre names to positive weights.');
    } else {
      const entries = Object.entries(rawWeights);
      if (entries.length > RECOMMENDATIONS_MAX_GENRES) {
        errors.push(`Provide at most ${RECOMMENDATIONS_MAX_GENRES} genre weights.`);
      } else {
        for (const [rawGenre, rawWeight] of entries) {
          const genre = String(rawGenre).trim();
          const weight = typeof rawWeight === 'number' ? rawWeight : NaN;
          const lowerGenre = genre.toLowerCase();
          if (!genre || genre.length > MAX_GENRE_LENGTH || !RECOMMENDATION_GENRE_PATTERN.test(genre) || ADULT_GENRES.has(lowerGenre) || ['__proto__', 'constructor', 'prototype'].includes(lowerGenre)) {
            errors.push('Recommendation genres contain an invalid or adult genre.');
            break;
          }
          if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
            errors.push('Recommendation genre weights must be finite numbers greater than 0 and at most 100.');
            break;
          }
          const key = lowerGenre;
          if (!Object.hasOwn(genreWeights, key)) genreWeights[key] = { name: genre, weight };
        }
      }
    }
  }

  const favoriteIds = [];
  const rawFavoriteIds = body.favoriteIds;
  if (rawFavoriteIds !== undefined) {
    if (!Array.isArray(rawFavoriteIds)) {
      errors.push('favoriteIds must be an array of AniList IDs.');
    } else if (rawFavoriteIds.length > RECOMMENDATIONS_MAX_FAVORITE_IDS) {
      errors.push(`Provide at most ${RECOMMENDATIONS_MAX_FAVORITE_IDS} favorite IDs.`);
    } else {
      for (const value of rawFavoriteIds) {
        const normalized = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
        if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 2147483647) {
          errors.push('favoriteIds must contain valid positive AniList IDs.');
          break;
        }
        if (!favoriteIds.includes(normalized)) favoriteIds.push(normalized);
      }
    }
  }

  if (!errors.length && !Object.keys(genreWeights).length && !favoriteIds.length) {
    errors.push('Provide genreWeights or favoriteIds to build recommendations.');
  }
  return {
    genreWeights: Object.values(genreWeights),
    favoriteIds,
    errors
  };
}

/** Build the recommendation query without interpolating client values. */
function buildRecommendationsGraphQL(input, { perPage = RECOMMENDATIONS_MAX_RESULTS } = {}) {
  const genreWeights = Array.isArray(input?.genreWeights) ? input.genreWeights : [];
  const favoriteIds = Array.isArray(input?.favoriteIds) ? input.favoriteIds : [];
  const variables = { perPage };
  const definitions = ['$perPage: Int!'];
  const fields = [];
  if (genreWeights.length) {
    definitions.push('$genres: [String!]');
    variables.genres = genreWeights.map(entry => entry.name);
    fields.push(`genrePage: Page(page: 1, perPage: $perPage) {
    media(type: ANIME, isAdult: false, genre_in: $genres, sort: POPULARITY_DESC) {
      ${CATALOG_MEDIA_FIELDS}
    }
  }`);
  }
  if (favoriteIds.length) {
    definitions.push('$favoriteIds: [Int!]');
    variables.favoriteIds = favoriteIds;
    fields.push(`favoritePage: Page(page: 1, perPage: $perPage) {
    media(type: ANIME, isAdult: false, id_in: $favoriteIds) {
      recommendations(sort: RATING_DESC, perPage: $perPage) {
        edges {
          node {
            mediaRecommendation {
              ${CATALOG_MEDIA_FIELDS}
            }
          }
        }
      }
    }
  }`);
  }
  return {
    query: `query (${definitions.join(', ')}) {\n${fields.join('\n')}\n}`,
    variables
  };
}

/**
 * Bounded cache insertion with FIFO eviction: when the map is already at
 * `limit`, its oldest key is dropped before the new entry is stored, so a
 * cache backed by this helper can never grow without bound. `server.js` uses
 * it for the `/api/browse` query cache (limit 100) so the guarantee is
 * unit-testable without booting the server.
 */
function boundedCacheSet(cache, key, entry, limit) {
  if (cache.size >= limit) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, entry);
  return cache;
}

module.exports = {
  CATALOG_MEDIA_FIELDS,
  CATALOG_SORTS,
  CATALOG_STATUSES,
  CATALOG_PER_PAGE,
  BROWSE_SEASONS,
  BROWSE_FORMATS,
  BROWSE_STATUSES,
  BROWSE_COUNTRIES,
  BROWSE_MAX_PAGE,
  MAX_GENRE_FILTERS,
  MAX_GENRE_LENGTH,
  STATUS_LABELS,
  browseCacheKey,
  boundedCacheSet,
  buildCatalogGraphQL,
  buildRecommendationsGraphQL,
  filterCatalogLocally,
  normalizeBrowsePageMeta,
  normalizeStatus,
  parseBrowseFilters,
  parseRecommendationInput,
  RECOMMENDATIONS_MAX_RESULTS
};
