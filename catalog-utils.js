const COUNTRY_LANGUAGES = {
  CN: 'Chinese',
  JP: 'Japanese',
  KR: 'Korean',
  TW: 'Chinese'
};

const STATUSES = {
  FINISHED: 'Completed',
  HIATUS: 'Hiatus',
  NOT_YET_RELEASED: 'Upcoming',
  RELEASING: 'Airing'
};

/**
 * Fields that describe the anime itself and change over time. Live AniList data
 * is authoritative for these; the local catalog only supplies them when AniList
 * has nothing usable to offer (see `hasUsableValue` below).
 */
const ANILIST_AUTHORITATIVE_FIELDS = [
  'title',
  'description',
  'image',
  'poster',
  'banner',
  'episodes',
  'status',
  'studio',
  'year',
  'rating',
  'genre',
  'type',
  'language'
];

/**
 * Values AniList uses for "not provided". A missing episode count (ongoing
 * series), a missing studio, an unknown country or a null score must all fall
 * back to the local catalog instead of overwriting it with junk.
 */
const MISSING_VALUE_STRINGS = new Set(['', 'unknown', 'n/a']);

function hasUsableValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') return !MISSING_VALUE_STRINGS.has(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function mapAniListMediaToCatalogItem(media) {
  const id = Number(media.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error('AniList returned a catalog entry without a valid ID.');
  }

  const title = media.title?.english || media.title?.romaji || media.title?.native || `Anime ${id}`;
  const poster = media.coverImage?.extraLarge || media.coverImage?.large || '';
  const studio = media.studios?.nodes?.find(node => node?.name)?.name || '';
  const year = media.seasonYear || media.startDate?.year || null;

  return {
    id,
    anilistId: id,
    title,
    genre: Array.isArray(media.genres) ? media.genres : [],
    year,
    rating: Number.isFinite(media.averageScore) ? media.averageScore / 10 : 0,
    episodes: media.episodes || 0,
    type: media.format || 'Unknown',
    studio,
    language: COUNTRY_LANGUAGES[media.countryOfOrigin] || 'Unknown',
    status: STATUSES[media.status] || media.status || 'Unknown',
    image: poster,
    poster,
    banner: media.bannerImage || '',
    description: media.description || ''
  };
}

/**
 * MERGE POLICY
 * ------------
 * Local entries are intentional site-specific curation; AniList entries are
 * factual, volatile metadata. The rules are:
 *
 *  1. Live AniList wins for every field in ANILIST_AUTHORITATIVE_FIELDS —
 *     title, artwork, description, episode count, airing status, studio, year,
 *     rating, genres, format and language — so stale local values (a wrong
 *     studio, an out-of-date episode count) can never mask current data.
 *  2. The local value is kept only where AniList supplies nothing usable
 *     (null, 0, "", [] or "Unknown"), so a partially populated AniList
 *     response degrades gracefully instead of blanking the catalog.
 *  3. Local-only keys — custom tags, editorial badges, presentation or link
 *     metadata — are never present on the AniList item and therefore always
 *     survive untouched. That is where site-specific curation belongs.
 *  4. `anilistId` always comes from AniList so detail links stay correct.
 *     `id` keeps the local key when a curated entry matches, preserving the
 *     existing local identifiers.
 *  5. Local entries with no AniList match are appended unchanged, and when
 *     AniList is unreachable server.js falls back to the untouched local
 *     catalog, so no field ever depends on AniList being available.
 */
function mergeCuratedItem(anilistItem, localItem) {
  const merged = { ...localItem };

  for (const field of ANILIST_AUTHORITATIVE_FIELDS) {
    if (hasUsableValue(anilistItem[field])) {
      merged[field] = anilistItem[field];
    }
  }

  merged.anilistId = anilistItem.anilistId;
  if (!hasUsableValue(merged.id)) merged.id = anilistItem.id;

  return merged;
}

function mergeAniListCatalog(localCatalog, mediaList) {
  const localByAniListId = new Map(
    localCatalog.map(item => [Number(item.anilistId || item.id), item])
  );
  const merged = [];
  const seen = new Set();

  for (const media of mediaList) {
    const mediaId = Number(media?.id);
    if (!Number.isInteger(mediaId) || mediaId < 1) continue;

    const item = mapAniListMediaToCatalogItem(media);
    if (seen.has(item.anilistId)) continue;
    seen.add(item.anilistId);
    const curatedItem = localByAniListId.get(item.anilistId);
    merged.push(curatedItem ? mergeCuratedItem(item, curatedItem) : item);
  }

  for (const item of localCatalog) {
    const anilistId = Number(item.anilistId || item.id);
    if (!seen.has(anilistId)) {
      seen.add(anilistId);
      merged.push({ ...item, anilistId });
    }
  }

  return merged;
}

module.exports = { mapAniListMediaToCatalogItem, mergeAniListCatalog };
