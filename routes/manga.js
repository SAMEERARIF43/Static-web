// Manga routes — used by server.js
// Handles the AniList-backed manga, manhwa, and manhua content pipeline.

const axios = require('axios');
const express = require('express');
const {
  CONTENT_KINDS,
  normalizeContentKind,
  normalizeMangaMedia,
  parseMangaRequest,
  buildMangaGraphQL,
  mangaCacheKey
} = require('../content-utils');

const { getAniListUrl } = require('../anilist-endpoint');

const router = express.Router();
const MANGA_CACHE_TTL_MS = 5 * 60 * 1000;
const MANGA_CACHE_LIMIT = 100;
const MANGA_REQUEST_TIMEOUT_MS = 10000;
const mangaContentCache = new Map();

function sanitizeDescription(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\n/g, '<br>');
}

function cacheMangaContent(key, value) {
  if (mangaContentCache.size >= MANGA_CACHE_LIMIT && !mangaContentCache.has(key)) {
    mangaContentCache.delete(mangaContentCache.keys().next().value);
  }
  mangaContentCache.set(key, value);
}

function mangaMeta(pageInfo, page, perPage, count, rawCount = count) {
  const hasNext = page < 50 && (
    typeof pageInfo?.hasNextPage === 'boolean' ? pageInfo.hasNextPage : rawCount >= perPage
  );
  const pageInfoMatchesRequest = Number.isSafeInteger(pageInfo?.currentPage)
    && pageInfo.currentPage === page
    && Number.isSafeInteger(pageInfo?.perPage)
    && pageInfo.perPage === perPage;
  const total = rawCount === count
    && pageInfoMatchesRequest
    && Number.isSafeInteger(pageInfo?.total)
    && pageInfo.total >= 0
    ? pageInfo.total
    : null;
  const totalPages = rawCount === count
    && pageInfoMatchesRequest
    && Number.isSafeInteger(pageInfo?.lastPage)
    && pageInfo.lastPage >= page
    && pageInfo.lastPage <= 50
    ? pageInfo.lastPage
    : null;
  return { page, perPage, total, totalPages, hasNext };
}

async function fetchMangaPage(options) {
  const { query, variables } = buildMangaGraphQL(options);
  const response = await axios.post(
    getAniListUrl(),
    { query, variables },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: MANGA_REQUEST_TIMEOUT_MS
    }
  );
  if (response.data?.errors) {
    throw new Error(response.data.errors.map(error => error.message).join('; '));
  }
  const page = response.data?.data?.Page;
  if (!page || !Array.isArray(page.media)) {
    throw new Error('AniList returned an invalid manga response.');
  }
  return { media: page.media, pageInfo: page.pageInfo };
}

async function getMangaDiscovery(options) {
  const key = mangaCacheKey(options);
  const cached = mangaContentCache.get(key);
  if (cached?.pending) return cached.pending;
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const pending = (async () => {
    try {
      const result = await fetchMangaPage(options);
      const data = result.media.flatMap(item => {
        try {
          const normalized = normalizeMangaMedia(item, options.kind);
          normalized.description = sanitizeDescription(normalized.description);
          return normalized.contentType === options.kind ? [normalized] : [];
        } catch (error) {
          console.warn(`Ignoring malformed ${options.kind} record: ${error.message}`);
          return [];
        }
      });
      const value = {
        data,
        meta: mangaMeta(result.pageInfo, options.page, options.perPage, data.length, result.media.length),
        source: 'anilist'
      };
      cacheMangaContent(key, { value, expiresAt: Date.now() + MANGA_CACHE_TTL_MS });
      return value;
    } catch (error) {
      const stale = cached?.value;
      console.warn(`AniList ${options.kind} unavailable; using ${stale ? 'cached' : 'error'} manga catalog: ${error.message}`);
      if (stale) {
        cacheMangaContent(key, { value: stale, expiresAt: cached.expiresAt });
        return stale;
      }
      throw error;
    } finally {
      if (mangaContentCache.get(key)?.pending === pending) mangaContentCache.delete(key);
    }
  })();

  cacheMangaContent(key, { pending, expiresAt: 0 });
  return pending;
}

function mangaHeaders(res, result) {
  res.setHeader('X-Content-Source', result.source);
  res.setHeader('X-Content-Page', String(result.meta.page));
  res.setHeader('X-Content-Per-Page', String(result.meta.perPage));
  if (result.meta.totalPages !== null) res.setHeader('X-Content-Total-Pages', String(result.meta.totalPages));
  res.setHeader('X-Content-Has-Next', result.meta.hasNext ? 'true' : 'false');
  if (result.meta.total !== null) res.setHeader('X-Content-Total', String(result.meta.total));
}

function routeContentKind(req) {
  const mountedKind = String(req.baseUrl || '').split('/').pop();
  return CONTENT_KINDS.has(mountedKind)
    ? mountedKind
    : normalizeContentKind(req.query.type, 'manga');
}

async function handleMangaDiscovery(req, res) {
  const kind = routeContentKind(req);
  const parsed = parseMangaRequest({ ...req.query, type: kind });
  if (parsed.errors.length) return res.status(400).json({ message: parsed.errors[0] });
  try {
    const result = await getMangaDiscovery({ ...parsed, kind });
    mangaHeaders(res, result);
    return res.json(result.data);
  } catch {
    return res.status(502).json({ message: 'Manga catalog is temporarily unavailable.' });
  }
}

async function handleMangaSearch(req, res) {
  const kind = routeContentKind(req);
  const parsed = parseMangaRequest({ ...req.query, type: kind });
  if (parsed.errors.length) return res.status(400).json({ message: parsed.errors[0] });
  if (!parsed.q) return res.status(400).json({ message: 'Enter a manga name of 1 to 100 characters.' });
  try {
    const result = await getMangaDiscovery({ ...parsed, kind });
    mangaHeaders(res, result);
    return res.json(result.data);
  } catch {
    return res.status(502).json({ message: 'Manga search is temporarily unavailable.' });
  }
}

async function handleMangaDetail(req, res) {
  const kind = routeContentKind(req);
  if (!/^\d+$/.test(req.params.id)
    || !Number.isSafeInteger(Number(req.params.id))
    || Number(req.params.id) < 1
    || Number(req.params.id) > 2147483647) {
    return res.status(400).json({ message: 'Invalid manga ID.' });
  }

  const id = Number(req.params.id);
  const key = mangaCacheKey({ kind, id });
  const cached = mangaContentCache.get(key);
  if (cached?.value && Date.now() < cached.expiresAt) return res.json(cached.value);

  try {
    const { query, variables } = buildMangaGraphQL({ kind, detail: true, id });
    const response = await axios.post(getAniListUrl(), { query, variables }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: MANGA_REQUEST_TIMEOUT_MS
    });
    if (response.data?.errors) {
      throw new Error(response.data.errors.map(error => error.message).join('; '));
    }
    const media = response.data?.data?.Media;
    if (!media) return res.status(404).json({ message: 'Manga not found.' });
    const item = normalizeMangaMedia(media, kind);
    item.description = sanitizeDescription(item.description);
    if (item.contentType !== kind) return res.status(404).json({ message: `${kind} not found.` });
    cacheMangaContent(key, { value: item, expiresAt: Date.now() + MANGA_CACHE_TTL_MS });
    return res.json(item);
  } catch (error) {
    const stale = cached?.value;
    if (stale) return res.json(stale);
    console.warn(`AniList ${kind} detail unavailable: ${error.message}`);
    return res.status(502).json({ message: 'Manga details are temporarily unavailable.' });
  }
}

router.get(['/','/discover'], handleMangaDiscovery);
router.get('/search', handleMangaSearch);
router.get('/:id', handleMangaDetail);

module.exports = router;
