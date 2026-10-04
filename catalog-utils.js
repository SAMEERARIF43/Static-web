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

function mergeAniListCatalog(localCatalog, mediaList) {
  const localByAniListId = new Map(
    localCatalog.map(item => [Number(item.anilistId || item.id), item])
  );
  const merged = [];
  const seen = new Set();

  for (const media of mediaList) {
    const item = mapAniListMediaToCatalogItem(media);
    if (seen.has(item.anilistId)) continue;
    seen.add(item.anilistId);
    const curatedItem = localByAniListId.get(item.anilistId);
    merged.push(curatedItem ? { ...item, ...curatedItem, anilistId: item.anilistId } : item);
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
