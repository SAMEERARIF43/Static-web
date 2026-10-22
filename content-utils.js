/** Utilities for the non-anime AniList content pipeline. */

const CONTENT_KINDS = new Set(['manga', 'manhwa', 'manhua']);
const CONTENT_COUNTRIES = { manga: ['JP'], manhwa: ['KR'], manhua: ['CN', 'TW'] };
const CONTENT_LABELS = { manga: 'Manga', manhwa: 'Manhwa', manhua: 'Manhua' };
const SORTS = {
  popularity: ['POPULARITY_DESC'],
  score: ['SCORE_DESC'],
  newest: ['START_DATE_DESC'],
  title: ['TITLE_ROMAJI'],
  trending: ['TRENDING_DESC']
};
const MEDIA_FIELDS = `
  id type title { romaji english native } coverImage { large extraLarge } bannerImage
  description chapters volumes status averageScore genres startDate { year month day }
  format countryOfOrigin source
  staff { edges { role node { name { full } } } }
`;

function normalizeContentKind(value, fallback = 'manga') {
  const kind = String(value || '').trim().toLowerCase();
  return CONTENT_KINDS.has(kind) ? kind : fallback;
}

function classifyAniListManga(media) {
  if (!media || String(media.type || '').toUpperCase() !== 'MANGA') return null;
  const country = String(media.countryOfOrigin || '').toUpperCase();
  if (country === 'KR') return 'manhwa';
  if (country === 'CN' || country === 'TW') return 'manhua';
  if (country === 'JP') return 'manga';
  return null;
}

function titleOf(media) {
  return media?.title?.english || media?.title?.romaji || media?.title?.native || `Manga ${media.id}`;
}

function normalizeMangaMedia(media, requestedKind = null) {
  if (!media || typeof media !== 'object' || Array.isArray(media)) throw new Error('AniList returned an invalid manga record.');
  const id = Number(media?.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('AniList returned manga without a valid ID.');
  if (String(media?.type || '').toUpperCase() !== 'MANGA') {
    throw new Error('AniList returned a non-MANGA record.');
  }
  const kind = classifyAniListManga(media);
  const staff = media.staff || media.authors || { edges: [] };
  const author = staff.edges?.find(edge => edge?.node?.name?.full)?.node?.name?.full || '';
  const chapters = Number.isSafeInteger(media.chapters) && media.chapters > 0 ? media.chapters : null;
  const volumes = Number.isSafeInteger(media.volumes) && media.volumes > 0 ? media.volumes : null;
  return {
    id, anilistId: id, contentType: kind,
    title: titleOf(media), titles: media.title || {},
    image: media.coverImage?.extraLarge || media.coverImage?.large || '',
    poster: media.coverImage?.extraLarge || media.coverImage?.large || '',
    banner: media.bannerImage || '', description: media.description || '',
    genre: Array.isArray(media.genres) ? media.genres : [],
    genres: Array.isArray(media.genres) ? media.genres : [],
    year: media.startDate?.year || null, rating: Number.isFinite(media.averageScore) ? media.averageScore / 10 : 0,
    chapters, volumes,
    status: media.status || 'UNKNOWN', format: media.format || 'MANGA', type: CONTENT_LABELS[kind] || 'Manga', mediaType: 'MANGA',
    countryOfOrigin: media.countryOfOrigin || null, source: media.source || null,
    author, authors: staff, staff, requestedKind: requestedKind || kind
  };
}

function parseMangaRequest(query = {}) {
  const errors = [];
  const kindRaw = query.type === undefined ? 'manga' : String(query.type);
  const kind = normalizeContentKind(kindRaw, '');
  if (!kind) errors.push('type must be manga, manhwa, or manhua.');
  const q = query.q === undefined ? '' : String(query.q).trim().replace(/\s+/g, ' ');
  if (q.length > 100) errors.push('q must be 100 characters or fewer.');
  if ([...q].some(char => { const code = char.codePointAt(0); return code < 0x20 || code === 0x7f; })) errors.push('q contains characters that are not allowed.');
  const page = query.page === undefined ? 1 : Number(query.page);
  const perPage = query.perPage === undefined ? 20 : Number(query.perPage);
  if (!Number.isSafeInteger(page) || page < 1 || page > 50) errors.push('page must be between 1 and 50.');
  if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 30) errors.push('perPage must be between 1 and 30.');
  const sort = query.sort === undefined ? 'popularity' : String(query.sort).toLowerCase();
  if (!Object.hasOwn(SORTS, sort)) errors.push('sort is invalid.');
  return { kind, q, page, perPage, sort, errors };
}

function buildMangaGraphQL({ kind, q = '', page = 1, perPage = 20, sort = 'popularity', detail = false, id = null }) {
  const args = ['type: MANGA', 'isAdult: false', 'sort: $sort'];
  const definitions = ['$page: Int', '$perPage: Int', '$sort: [MediaSort]'];
  const variables = { page, perPage, sort: SORTS[sort] || SORTS.popularity };
  if (q) { args.push('search: $search'); definitions.push('$search: String'); variables.search = q; }
  if (CONTENT_COUNTRIES[kind]) { args.push('countryOfOrigin_in: $countries'); definitions.push('$countries: [CountryCode]'); variables.countries = CONTENT_COUNTRIES[kind]; }
  if (detail) {
    return { query: `query ($id: Int) { Media(id: $id, type: MANGA, isAdult: false) { ${MEDIA_FIELDS} } }`, variables: { id } };
  }
  return { query: `query (${definitions.join(', ')}) { Page(page: $page, perPage: $perPage) { pageInfo { total perPage currentPage lastPage hasNextPage } media(${args.join(', ')}) { ${MEDIA_FIELDS} } } }`, variables };
}

function mangaCacheKey({ kind, q = '', page = 1, perPage = 20, sort = 'popularity', id = '' }) {
  return `manga:${normalizeContentKind(kind)}:${id || 'list'}:${String(q).trim().toLowerCase()}:${page}:${perPage}:${sort}`;
}

module.exports = { CONTENT_KINDS, CONTENT_COUNTRIES, normalizeContentKind, classifyAniListManga, normalizeMangaMedia, parseMangaRequest, buildMangaGraphQL, mangaCacheKey };
