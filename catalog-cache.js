// Shared TTL for the AniList-backed catalog, search and detail caches.
// A failed refresh serves the last good answer for that key, so the site keeps
// working while AniList is unavailable. Tests override CATALOG_CACHE_TTL_MS to
// exercise expiry without waiting out the production window; an invalid value
// fails fast at startup instead of silently misbehaving.

const rawCatalogCacheTtl = process.env.CATALOG_CACHE_TTL_MS;
const CATALOG_CACHE_TTL_MS = rawCatalogCacheTtl === undefined || rawCatalogCacheTtl.trim() === ''
  ? 10 * 60 * 1000
  : Number(rawCatalogCacheTtl);

if (!Number.isFinite(CATALOG_CACHE_TTL_MS) || CATALOG_CACHE_TTL_MS < 0) {
  throw new Error('CATALOG_CACHE_TTL_MS must be a finite, non-negative number of milliseconds; leave it unset for the default.');
}

module.exports = { CATALOG_CACHE_TTL_MS };
