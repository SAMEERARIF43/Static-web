const assert = require('assert');
const {
  classifyAniListManga, normalizeMangaMedia, parseMangaRequest,
  buildMangaGraphQL, mangaCacheKey
} = require('./content-utils');

assert.strictEqual(classifyAniListManga({ type: 'MANGA', countryOfOrigin: 'JP' }), 'manga');
assert.strictEqual(classifyAniListManga({ type: 'MANGA', countryOfOrigin: 'KR' }), 'manhwa');
assert.strictEqual(classifyAniListManga({ type: 'MANGA', countryOfOrigin: 'CN' }), 'manhua');
assert.strictEqual(classifyAniListManga({ type: 'MANGA', countryOfOrigin: 'TW' }), 'manhua');
assert.strictEqual(classifyAniListManga({ type: 'MANGA', countryOfOrigin: null }), null);
assert.strictEqual(classifyAniListManga({ type: 'MANGA', countryOfOrigin: 'US' }), null);
assert.strictEqual(classifyAniListManga({ type: 'ANIME', countryOfOrigin: 'JP' }), null);
assert.throws(() => normalizeMangaMedia({ id: 44, type: 'ANIME', countryOfOrigin: 'JP' }), /non-MANGA/);
assert.throws(() => normalizeMangaMedia({ id: 45, countryOfOrigin: 'JP' }), /non-MANGA/);
for (const media of [null, undefined, [], 'invalid', 42]) {
  assert.throws(() => normalizeMangaMedia(media), /invalid manga record/);
}

const normalized = normalizeMangaMedia({
  id: 42, type: 'MANGA', countryOfOrigin: 'KR', title: { romaji: 'Tower', english: 'Tower' },
  coverImage: { large: 'cover' }, genres: ['Action'], chapters: 100, volumes: 10,
   averageScore: 85, staff: { edges: [{ role: 'Story', node: { name: { full: 'Author' } } }] }
});
assert.deepStrictEqual({ id: normalized.id, anilistId: normalized.anilistId, contentType: normalized.contentType, chapters: normalized.chapters, volumes: normalized.volumes, author: normalized.author }, { id: 42, anilistId: 42, contentType: 'manhwa', chapters: 100, volumes: 10, author: 'Author' });
assert.strictEqual(normalizeMangaMedia({ id: 43, type: 'MANGA', countryOfOrigin: 'US', chapters: 0, volumes: 0 }).contentType, null);
assert.strictEqual(normalizeMangaMedia({ id: 43, type: 'MANGA', countryOfOrigin: 'US', chapters: 0, volumes: 0 }).chapters, null);

assert.deepStrictEqual(parseMangaRequest({ type: 'manhwa', q: '  Tower   of God ', page: '2', perPage: '10', sort: 'score' }).errors, []);
assert.deepStrictEqual(parseMangaRequest({ type: 'manhua', sort: 'trending' }).errors, []);
assert(parseMangaRequest({ type: 'not-real' }).errors.length);
assert(parseMangaRequest({ sort: 'not-real' }).errors.length);
assert(parseMangaRequest({ q: '\u0000' }).errors.some(error => error.includes('not allowed')));

const built = buildMangaGraphQL({ kind: 'manhua', q: 'nezha', page: 2, perPage: 10, sort: 'newest' });
assert(built.query.includes('type: MANGA'));
assert(/\bid\s+type\s+title\b/.test(built.query), 'list must select provider type, not just filter by it');
assert(built.query.includes('isAdult: false'));
const detail = buildMangaGraphQL({ kind: 'manga', detail: true, id: 42 });
assert(/\bid\s+type\s+title\b/.test(detail.query), 'detail must select provider type');
assert(detail.query.includes('isAdult: false'));
assert.deepStrictEqual(detail.variables, { id: 42 });
assert(built.query.includes('staff {'));
assert(built.query.includes('countryOfOrigin_in: $countries'));
assert(!built.query.includes('nezha'));
assert.deepStrictEqual(built.variables.countries, ['CN', 'TW']);
assert.strictEqual(built.variables.page, 2);
const trending = buildMangaGraphQL({ kind: 'manga', sort: 'trending' });
assert.deepStrictEqual(trending.variables.sort, ['TRENDING_DESC']);
assert.notStrictEqual(mangaCacheKey({ kind: 'manga', sort: 'popularity' }), mangaCacheKey({ kind: 'manga', sort: 'trending' }));
assert.notStrictEqual(mangaCacheKey({ kind: 'manga', q: 'x' }), mangaCacheKey({ kind: 'manhwa', q: 'x' }));
for (const options of [{ page: 2 }, { perPage: 10 }, { q: 'different' }, { id: 42 }]) {
  assert.notStrictEqual(mangaCacheKey({ kind: 'manga' }), mangaCacheKey({ kind: 'manga', ...options }));
}
console.log('Content classification, normalization, validation, query binding and cache isolation verified.');
