// ============================================================
// ANIME HUB SERVER
// ============================================================
// Optionally load an external env file (e.g. to keep secrets outside a
// synced folder) via ANIME_HUB_ENV_FILE; unset keeps the default cwd-relative
// .env. No override: real process env vars retain precedence over file values.
require('dotenv').config(
  process.env.ANIME_HUB_ENV_FILE ? { path: process.env.ANIME_HUB_ENV_FILE } : {}
);
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const {
  mapLocalAnimeToAniList,
  rankAnimeSuggestions,
  searchAnimeLocal,
  searchAnimeLocalFuzzy,
  suggestionMatchRank,
  deduplicateMediaList
} = require('./search-utils');
const { mergeAniListCatalog, withCanonicalId } = require('./catalog-utils');
const {
  boundedCacheSet,
  browseCacheKey,
  BROWSE_MAX_PAGE,
  CATALOG_MEDIA_FIELDS,
  CATALOG_PER_PAGE,
  buildCatalogGraphQL,
  buildRecommendationsGraphQL,
  filterCatalogLocally,
  normalizeBrowsePageMeta,
  parseBrowseFilters,
  parseRecommendationInput,
  RECOMMENDATIONS_MAX_RESULTS
} = require('./catalog-filters');
const { fetchKitsuFallback } = require('./provider-router');
const {
  CONTENT_KINDS,
  normalizeContentKind,
  normalizeMangaMedia,
  parseMangaRequest,
  buildMangaGraphQL,
  mangaCacheKey
} = require('./content-utils');
const {
  createStreamToken,
  extractStreamUrl,
  proxyStreamRequest,
  proxySubtitleRequest,
  proxyUrlForToken,
  subtitleProxyUrlForToken
} = require('./stream-proxy');

const app = express();

// Behind a reverse proxy (production PaaS), client IPs arrive in
// X-Forwarded-For; TRUST_PROXY (hop count) makes req.ip the real client so
// rate limiting and logs attribute requests correctly. Disabled by default so
// a direct deployment cannot have its client IP spoofed via headers.
if (process.env.TRUST_PROXY) {
  const proxyHops = process.env.TRUST_PROXY;
  if (!/^[1-9]\d*$/.test(proxyHops) || !Number.isSafeInteger(Number(proxyHops))) {
    throw new Error('TRUST_PROXY must be a positive integer hop count; leave it unset when no trusted proxy is present.');
  }
  app.set('trust proxy', Number(proxyHops));
}

const PORT = process.env.PORT || 3000;
const configuredSiteUrl = new URL(process.env.SITE_URL || `http://localhost:${PORT}`);
if (
  !['http:', 'https:'].includes(configuredSiteUrl.protocol) ||
  configuredSiteUrl.origin === 'null' ||
  configuredSiteUrl.username ||
  configuredSiteUrl.password
) {
  throw new Error('SITE_URL must be an HTTP or HTTPS site origin.');
}
const SITE_URL = configuredSiteUrl.origin;

/**
 * AniList GraphQL endpoint. Production uses the public API; the override lets
 * tests and outage drills point the live catalog at a local mock instead.
 */
function resolveAnilistGraphqlUrl(value) {
  if (!value) return 'https://graphql.anilist.co';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('ANILIST_GRAPHQL_URL must be a valid http(s) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('ANILIST_GRAPHQL_URL must be an http(s) URL without credentials.');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('ANILIST_GRAPHQL_URL must use HTTPS in production.');
  }
  return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
}

const ANILIST_GRAPHQL_URL = resolveAnilistGraphqlUrl(process.env.ANILIST_GRAPHQL_URL);
const SUGGESTION_CACHE_TTL_MS = 60 * 1000;
const SUGGESTION_CACHE_LIMIT = 100;
const suggestionCache = new Map();
const pendingSuggestionRequests = new Map();

/**
 * Shape a curated entry like an AniList detail response, so the detail page
 * keeps rendering (sparser) when AniList is unreachable. Returns null when the
 * ID is not in the curated catalog.
 */
function buildCuratedAnimeDetail(animeId) {
  const localAnime = ANIME_DB.find(anime => anime.anilistId === animeId);
  return localAnime ? mapLocalAnimeToAniList(localAnime) : null;
}

/**
 * Region slug for JustWatch availability links, surfaced to the client through
 * /api/site-config. An invalid value falls back to "us" instead of breaking
 * the links: this is presentation configuration, not a security boundary.
 */
function resolveJustWatchRegion(value) {
  const region = String(value || '').trim().toLowerCase();
  if (!region) return 'us';
  if (!/^[a-z]{2,3}(?:-[a-z]{2,3})?$/.test(region)) {
    console.warn('Ignoring invalid JUSTWATCH_REGION; JustWatch links default to "us".');
    return 'us';
  }
  return region;
}

const JUSTWATCH_REGION = resolveJustWatchRegion(process.env.JUSTWATCH_REGION);

/**
 * The browser talks to Supabase directly (auth and the cloud watchlist), so
 * the CSP must allow connecting to the configured project origin. HTTP
 * origins are not eligible: credentials must never cross cleartext.
 */
const supabaseConnectOrigin = (() => {
  const value = process.env.SUPABASE_URL;
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.origin : null;
})();

const CSP_CONNECT_SOURCES = ["'self'", supabaseConnectOrigin].filter(Boolean).join(' ');

// ============================================================
// MIDDLEWARE
// ============================================================

// Restricted CORS — only allow the app's own origin (or configured origins)
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : [`http://localhost:${PORT}`];

if (process.env.NODE_ENV === 'production') {
  const isLocalhost = hostname =>
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.startsWith('127.');
  if (
    !process.env.SITE_URL ||
    configuredSiteUrl.protocol !== 'https:' ||
    configuredSiteUrl.pathname !== '/' ||
    configuredSiteUrl.search ||
    configuredSiteUrl.hash ||
    isLocalhost(configuredSiteUrl.hostname)
  ) {
    throw new Error('Production requires SITE_URL set to the public HTTPS origin without a path, query, or fragment.');
  }
  if (!process.env.CORS_ORIGINS) {
    throw new Error('Production requires CORS_ORIGINS to be explicitly configured.');
  }
  const invalidCorsOrigin = ALLOWED_ORIGINS.some(origin => {
    try {
      const url = new URL(origin);
      return url.protocol !== 'https:' ||
        url.origin !== origin ||
        isLocalhost(url.hostname);
    } catch {
      return true;
    }
  });
  if (invalidCorsOrigin) {
    throw new Error('Production CORS_ORIGINS must contain only valid public HTTPS origins.');
  }
  if (!ALLOWED_ORIGINS.includes(SITE_URL)) {
    throw new Error('Production CORS_ORIGINS must include SITE_URL.');
  }
  for (const variable of ['CONTACT_EMAIL', 'DMCA_EMAIL']) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env[variable] || '')) {
      throw new Error(`Production requires a valid monitored ${variable}.`);
    }
  }
  for (const variable of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!process.env[variable]?.trim()) {
      throw new Error(`Production requires ${variable} to be configured.`);
    }
  }
  let productionSupabaseUrl;
  try {
    productionSupabaseUrl = new URL(process.env.SUPABASE_URL);
  } catch {
    throw new Error('Production requires SUPABASE_URL to be a valid HTTPS project origin.');
  }
  if (
    productionSupabaseUrl.protocol !== 'https:' ||
    productionSupabaseUrl.origin === 'null' ||
    productionSupabaseUrl.username ||
    productionSupabaseUrl.password ||
    productionSupabaseUrl.pathname !== '/' ||
    productionSupabaseUrl.search ||
    productionSupabaseUrl.hash ||
    isLocalhost(productionSupabaseUrl.hostname)
  ) {
    throw new Error('Production requires SUPABASE_URL to be a public HTTPS project origin without a path, query, or fragment.');
  }
  if (process.env.SUPABASE_ANON_KEY === process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Production requires separate public and server-only Supabase keys.');
  }
}

// Security headers are set before every other middleware so that error
// responses - CORS rejections, 404s, 429 rate-limit replies - carry them too.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // The frontend ships no inline scripts (see public/script.js) and uses
  // inline <style> attributes plus Google Fonts, so script-src can stay
  // strict while style-src stays compatible with the current markup.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' https://s4.anilist.co https://placehold.co",
    "connect-src " + CSP_CONNECT_SOURCES,
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests"
  ].join('; '));
  // X-Request-ID for request tracing in production logs
  const requestId = crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);
  // The site is HTTPS-only in production; HSTS keeps it that way for
  // returning browsers. Skipped locally so HTTP development keeps working.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (same-origin, Postman, server-side)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Not allowed by CORS' });
  }
  next(err);
});

// ============================================================
// RATE LIMITING
// ============================================================
//
// Limits are scoped by upstream cost: the AniList proxy endpoints carry the
// highest quota risk (every request forwards to AniList's shared quota), the
// account-deletion endpoint is unauthenticated but expensive and destructive,
// and everything under /api gets a coarse global cap. Pages and static assets
// are not limited. In production, set TRUST_PROXY to the proxy hop count
// (e.g. TRUST_PROXY=1) so clients are counted by their real address instead
// of the proxy's.

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_GLOBAL_MAX = 120;
const RATE_LIMIT_PROXY_MAX = 60;
const RATE_LIMIT_ACCOUNT_MAX = 5;
const STREAM_RATE_LIMIT_MAX = 30;
const AUTOMATED_TEST_MODE = process.env.NODE_ENV === 'test' && process.env.ANIME_HUB_TEST_MODE === '1';

const globalApiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_GLOBAL_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // req.path is mount-relative here (/site-config), so the full originalUrl
  // decides which public config endpoints stay unthrottled.
   skip: req => AUTOMATED_TEST_MODE || req.originalUrl.startsWith('/api/site-config') || req.originalUrl.startsWith('/api/config'),
  handler: (req, res) => {
    console.warn(`Rate limit exceeded (global /api) from ${req.ip}`);
    res.status(429).json({ message: 'Too many requests. Please slow down.' });
  }
});

const proxyLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_PROXY_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => AUTOMATED_TEST_MODE,
  handler: (req, res) => {
    console.warn(`Rate limit exceeded (AniList proxy) from ${req.ip}`);
    res.status(429).json({ message: 'Too many requests. Please slow down.' });
  }
});

const accountDeletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: RATE_LIMIT_ACCOUNT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Count malformed and unauthenticated deletion attempts too; otherwise an
  // attacker can bypass the sensitive-action limiter by omitting the header.
  skip: () => AUTOMATED_TEST_MODE,
  handler: (req, res) => {
    console.warn(`Rate limit exceeded (account deletion) from ${req.ip}`);
    res.status(429).json({ message: 'Too many requests. Please try again later.' });
  }
});

const streamLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: STREAM_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`Rate limit exceeded (stream gateway) from ${req.ip}`);
    res.status(429).json({ message: 'Too many stream requests. Please slow down.' });
  }
});

// Admin moderation endpoints are scoped by a strict, separate rate limit.
const ADMIN_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const ADMIN_RATE_LIMIT_MAX = 30;

const adminLimiter = rateLimit({
  windowMs: ADMIN_RATE_LIMIT_WINDOW_MS,
  limit: ADMIN_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => AUTOMATED_TEST_MODE,
  handler: (req, res) => {
    console.warn(`Rate limit exceeded (admin) from ${req.ip}`);
    res.status(429).json({ message: 'Too many admin requests. Please slow down.' });
  }
});

const rateLimiters = [
  globalApiLimiter,
  proxyLimiter,
  accountDeletionLimiter,
  streamLimiter,
  adminLimiter
];

/**
 * Clear one client's in-memory limiter buckets. This is deliberately exposed
 * only through the test-only reset route below; production has no reset hook.
 */
async function resetRateLimitState(key) {
  await Promise.all(rateLimiters.map(limiter => {
    if (typeof limiter.resetKey !== 'function') return undefined;
    return limiter.resetKey(key);
  }));
}

if (process.env.NODE_ENV === 'test') {
  app.post('/__test/reset-rate-limits', async (req, res) => {
    if (req.get('X-Test-Rate-Limit-Reset') !== '1') {
      return res.status(404).end();
    }
    await resetRateLimitState(req.ip);
    return res.status(204).end();
  });
}

// Admin key guard: requires X-Admin-Key header matching ADMIN_KEY env var.
// Falls back to a dev-only default so the admin panel is usable locally without
// configuration; production must set ADMIN_KEY explicitly.
const ADMIN_KEY = process.env.ADMIN_KEY || 'anime-hub-admin-dev';

function requireAdminKey(req, res, next) {
  const key = req.get('X-Admin-Key');
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ message: 'Admin key required.' });
  }
  next();
}

app.use('/api', globalApiLimiter);
app.use('/api/search', proxyLimiter);
app.use('/api/browse', proxyLimiter);
app.use('/api/recommendations', proxyLimiter);
app.use('/api/anime/:id', proxyLimiter);
app.use(['/api/manga', '/api/manhwa', '/api/manhua'], proxyLimiter);
app.use('/api/account', accountDeletionLimiter);
app.use('/api/admin', adminLimiter);
app.use('/api/stream', streamLimiter);

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

app.use(express.json({ limit: '16kb' }));

// Test-only fault injection for the generic JSON error contract. This route is
// unavailable unless the local test harness explicitly opts in.
if (process.env.NODE_ENV === 'test' && process.env.ANIME_HUB_TEST_ERROR_ROUTE === '1') {
  app.get('/api/test/error-middleware', () => {
    throw new Error('P6.5 test fixture internal detail');
  });
}

const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  res.type('html').send(indexHtml.replaceAll('__SITE_URL__', SITE_URL));
});

// Serve ONLY the public/ directory — not the project root
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  const pages = [
    { path: '', changefreq: 'daily', priority: '1.0' },
    { path: 'privacy.html', changefreq: 'monthly', priority: '0.3' },
    { path: 'terms.html', changefreq: 'monthly', priority: '0.3' },
    { path: 'contact.html', changefreq: 'monthly', priority: '0.5' },
    { path: 'dmca.html', changefreq: 'monthly', priority: '0.3' }
  ];
  const urls = pages.map(p => {
    const loc = p.path ? `${SITE_URL}/${p.path}` : `${SITE_URL}/`;
    return `<url><loc>${loc}</loc><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`;
  }).join('');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  );
});

app.get('/api/site-config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    siteUrl: SITE_URL,
    contactEmail: process.env.CONTACT_EMAIL || '',
    dmcaEmail: process.env.DMCA_EMAIL || '',
    justWatchRegion: JUSTWATCH_REGION
  });
});

app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || ''
  });
});

// ============================================================
// AUTHORIZED STREAM GATEWAY
// ============================================================
// The provider is operator-configured and the returned source URLs are signed
// before the browser can use the local HLS/segment proxy. No catalog endpoint
// is changed by this flow.

app.get('/api/stream/extract', async (req, res) => {
  const animeId = String(req.query.animeId || '').trim();
  const episode = String(req.query.episode || req.query.episodeNum || '').trim();
  if (!/^\d+$/.test(animeId) || Number(animeId) < 1 || !/^\d+$/.test(episode) || Number(episode) < 1) {
    return res.status(400).json({ message: 'animeId and episode must be positive integers.' });
  }

  try {
    const sources = await extractStreamUrl(animeId, episode);
    return res.json({
      animeId: Number(animeId),
      episode: Number(episode),
      expiresInSeconds: 600,
      sources: sources.map(source => {
        const token = createStreamToken(source.url);
        return {
          quality: source.quality,
          type: source.type,
          host: source.host,
          url: proxyUrlForToken(token),
          subtitles: (source.subtitles || []).map(track => ({
            label: track.label,
            language: track.language,
            kind: track.kind,
            format: track.format,
            default: track.default,
            url: subtitleProxyUrlForToken(createStreamToken(track.url))
          })),
          audioTracks: source.audioTracks || []
        };
      })
    });
  } catch (error) {
    if (error.code === 'STREAM_PROVIDER_NOT_CONFIGURED') {
      return res.status(503).json({ message: 'Authorized stream playback is not configured on this server.' });
    }
    if (error.code === 'INVALID_STREAM_REQUEST') {
      return res.status(400).json({ message: error.message });
    }
    if (error.code === 'NO_STREAM_SOURCES') {
      return res.status(404).json({ message: 'No authorized stream source is available for this episode.' });
    }
    console.error(`Stream extraction failed [${req.id || 'no-request-id'}]: ${error.message}`);
    return res.status(502).json({ message: 'Could not retrieve an authorized stream source.' });
  }
});

app.get('/api/stream/proxy', proxyStreamRequest);
app.options('/api/stream/subtitles', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.status(204).end();
});
app.get('/api/stream/subtitles', proxySubtitleRequest);

app.delete('/api/account', async (req, res) => {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match || match[1].length > 8192) {
    return res.status(401).json({ message: 'A valid login session is required.' });
  }

  const supabaseUrlValue = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrlValue || !anonKey || !serviceRoleKey) {
    return res.status(503).json({ message: 'Account deletion is not configured on this server.' });
  }

  let supabaseUrl;
  try {
    supabaseUrl = new URL(supabaseUrlValue);
  } catch {
    console.error('Account deletion is unavailable because SUPABASE_URL is invalid.');
    return res.status(503).json({ message: 'Account deletion is not configured on this server.' });
  }
  if (
    !['https:', 'http:'].includes(supabaseUrl.protocol) ||
    (supabaseUrl.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(supabaseUrl.hostname)) ||
    supabaseUrl.username ||
    supabaseUrl.password
  ) {
    console.error('Account deletion is unavailable because SUPABASE_URL is not a secure origin.');
    return res.status(503).json({ message: 'Account deletion is not configured on this server.' });
  }

  const baseUrl = supabaseUrl.origin;
  const accessToken = match[1];
  let authenticatedUser;
  try {
    const verification = await axios.get(`${baseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`
      },
      timeout: 10000
    });
    authenticatedUser = verification.data;
  } catch (error) {
    // Distinguish authentication failures from upstream/service failures
    if (error.code === 'ECONNABORTED' || error.timeout) {
      return res.status(504).json({ message: 'Supabase session verification timed out. Please try again.' });
    }
    if ([401, 403].includes(error.response?.status)) {
      return res.status(401).json({ message: 'Your login session is invalid or expired.' });
    }
    console.error(`Supabase session verification failed${error.response?.status ? ` (${error.response.status})` : ''}.`);
    return res.status(502).json({ message: 'Could not verify the account session.' });
  }

  const userId = authenticatedUser?.id;
  if (typeof userId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId)) {
    console.error('Supabase session verification returned an invalid user identity.');
    return res.status(502).json({ message: 'Could not verify the account session.' });
  }

  try {
    await axios.delete(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      },
      timeout: 15000
    });
    return res.status(200).json({ message: 'Your account has been deleted.' });
  } catch (error) {
    // Distinguish deletion-specific errors from generic failures
    if (error.code === 'ECONNABORTED' || error.timeout) {
      return res.status(504).json({ message: 'Account deletion request timed out. Please try again.' });
    }
    // Any Admin API failure (including service-role misconfiguration) is a
    // server-side problem: the user's session was already verified above.
    console.error(`Supabase account deletion failed${error.response?.status ? ` (${error.response.status})` : ''}.`);
    return res.status(502).json({ message: 'Account deletion could not be completed. Please try again later.' });
  }
});


// ============================================================
// HELPERS — Sanitize HTML from AniList descriptions
// ============================================================

/**
 * Strip all HTML tags except <br> and escape remaining content
 * to prevent XSS when forwarding AniList data to the client.
 */
function sanitizeDescription(html) {
  if (!html || typeof html !== 'string') return '';
  // Preserve <br> tags, strip all other HTML
  return html
    .replace(/<br\s*\/?>/gi, '\n')    // Convert <br> to newlines
    .replace(/<[^>]*>/g, '')           // Remove all other tags
    .replace(/\n/g, '<br>');           // Restore <br> tags
}

/**
 * Safely extract a nested property, returning fallback if missing.
 */
function safe(obj, path, fallback = null) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] != null ? acc[key] : fallback), obj);
}


// ============================================================
// LOCAL ANIME DATABASE
// ============================================================

const ANIME_DB = [
  {
    anilistId: 113415,
    title: "Jujutsu Kaisen",
    genre: ["Action", "Supernatural", "Shounen"],
    year: 2020,
    rating: 8.6,
    episodes: 24,
    type: "TV",
    studio: "MAPPA",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx113415-LHBAeoZDIsnF.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/113415-jQBSkxWAAk83.jpg",
    description:
      "Yuji Itadori joins a secret organization of Jujutsu Sorcerers after becoming the host of a powerful curse."
  },

  {
    anilistId: 151807,
    title: "Solo Leveling",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2024,
    rating: 8.8,
    episodes: 25,
    type: "TV",
    studio: "A-1 Pictures",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-it355ZgzquUd.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/151807-37yfQA3ym8PA.jpg",
    description:
      "Sung Jin-Woo, the weakest hunter, gains a mysterious ability that allows him to level up."
  },

  {
    anilistId: 21,
    title: "One Piece",
    genre: ["Action", "Adventure", "Fantasy", "Shounen"],
    year: 1999,
    rating: 9.0,
    episodes: 1100,
    type: "TV",
    studio: "Toei Animation",
    language: "Japanese",
    status: "Airing",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx21-ELSYx3yMPcKM.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21-wf37VakJmZqs.jpg",
    description:
      "Monkey D. Luffy and his crew travel across the Grand Line in search of the legendary One Piece."
  },

  {
    anilistId: 101922,
    title: "Demon Slayer",
    genre: ["Action", "Supernatural", "Shounen"],
    year: 2019,
    rating: 8.6,
    episodes: 55,
    type: "TV",
    studio: "ufotable",
    language: "Japanese",
    status: "Airing",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101922-WBsBl0ClmgYL.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101922-33MtJGsUSxga.jpg",
    description:
      "Tanjiro Kamado becomes a demon slayer after his family is attacked and his sister is turned into a demon."
  },

  {
    anilistId: 16498,
    title: "Attack on Titan",
    genre: ["Action", "Drama", "Fantasy"],
    year: 2013,
    rating: 9.0,
    episodes: 89,
    type: "TV",
    studio: "WIT STUDIO",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx16498-buvcRTBx4NSm.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-8jpFCOcDmneX.jpg",
    description:
      "Humanity fights for survival against terrifying Titans that threaten to destroy civilization."
  },

  {
    anilistId: 20,
    title: "Naruto",
    genre: ["Action", "Adventure", "Shounen"],
    year: 2002,
    rating: 8.3,
    episodes: 220,
    type: "TV",
    studio: "Studio Pierrot",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx20-dE6UHbFFg1A5.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/20-HHxhPj5JD13a.jpg",
    description:
      "Naruto Uzumaki dreams of becoming the strongest ninja and earning the respect of his village."
  },

  {
    anilistId: 1535,
    title: "Death Note",
    genre: ["Mystery", "Psychological", "Supernatural"],
    year: 2006,
    rating: 8.6,
    episodes: 37,
    type: "TV",
    studio: "Madhouse",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1535-kUgkcrfOrkUM.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/1535.jpg",
    description:
      "A brilliant student discovers a mysterious notebook that can kill anyone whose name is written inside."
  },

  {
    anilistId: 5114,
    title: "Fullmetal Alchemist: Brotherhood",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2009,
    rating: 9.1,
    episodes: 64,
    type: "TV",
    studio: "Bones",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-nSWCgQlmOMtj.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/5114-q0V5URebphSG.jpg",
    description:
      "Two brothers use alchemy to search for the Philosopher's Stone after a failed human transmutation."
  },

  {
    anilistId: 269,
    title: "Bleach",
    genre: ["Action", "Adventure", "Supernatural"],
    year: 2004,
    rating: 8.2,
    episodes: 366,
    type: "TV",
    studio: "Studio Pierrot",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx269-d2GmRkJbMopq.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/269-08ar2HJOUAuL.jpg",
    description:
      "Ichigo Kurosaki becomes a Soul Reaper and battles supernatural enemies threatening the human world."
  },

  {
    anilistId: 101348,
    title: "Vinland Saga",
    genre: ["Action", "Adventure", "Drama"],
    year: 2019,
    rating: 8.8,
    episodes: 48,
    type: "TV",
    studio: "WIT STUDIO",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101348-2fhDFPCuMNiz.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/101348-pivKKffCAwAY.jpg",
    description:
      "Thorfinn grows up among Vikings while seeking revenge and searching for a land free from war."
  },

  {
    anilistId: 9253,
    title: "Steins;Gate",
    genre: ["Sci-Fi", "Thriller", "Psychological"],
    year: 2011,
    rating: 9.0,
    episodes: 24,
    type: "TV",
    studio: "White Fox",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-tIUXF2gfU8Sg.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-tIUXF2gfU8Sg.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/n9253-JIhmKgBKsWUN.jpg",
    description:
      "A group of friends accidentally discover a method of sending messages through time."
  },

  {
    anilistId: 11061,
    title: "Hunter x Hunter",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2011,
    rating: 9.0,
    episodes: 148,
    type: "TV",
    studio: "Madhouse",
    language: "Japanese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11061-y5gsT1hoHuHw.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx11061-y5gsT1hoHuHw.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/11061-8WkkTZ6duKpq.jpg",
    description:
      "Gon Freecss becomes a Hunter and travels the world while searching for his missing father."
  },

  {
    anilistId: 112117,
    title: "Ne Zha",
    genre: ["Action", "Adventure", "Fantasy"],
    year: 2019,
    rating: 7.9,
    episodes: 1,
    type: "MOVIE",
    studio: "Chengdu Coco Cartoon",
    countryOfOrigin: "CN",
    language: "Chinese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx112117-640Mv5P7b9oZ.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx112117-640Mv5P7b9oZ.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/112117-zK66B9qM3H7k.jpg",
    description:
      "A young boy born from a heavenly pearl must choose between good and evil to overcome his cursed fate."
  },

  {
    anilistId: 98861,
    title: "The King's Avatar",
    genre: ["Action", "Adventure"],
    year: 2017,
    rating: 7.9,
    episodes: 12,
    type: "TV",
    studio: "B.CMAY PICTURES",
    countryOfOrigin: "CN",
    language: "Chinese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx98861-6H5qV5s7a8oK.png",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx98861-6H5qV5s7a8oK.png",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/98861-7H8qV5s7a8oK.jpg",
    description:
      "Ye Xiu, a top-tier player in the online game Glory, is forced to retire and restart from scratch on a new server."
  },

  {
    anilistId: 126403,
    title: "Link Click",
    genre: ["Drama", "Mystery", "Supernatural"],
    year: 2021,
    rating: 8.7,
    episodes: 11,
    type: "TV",
    studio: "LAN Studio",
    countryOfOrigin: "CN",
    language: "Chinese",
    status: "Completed",
    image: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx126403-QpDzkb6b9i4n.jpg",
    poster: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx126403-QpDzkb6b9i4n.jpg",
    banner: "https://s4.anilist.co/file/anilistcdn/media/anime/banner/126403-tUa3Jk0F1Z4M.jpg",
    description:
      "Using superpowers to enter their clientele's photos one by one, Cheng Xiaoshi and Lu Guang take their work seriously at 'Time Photo Studio'."
  }
];


// ============================================================
// HELPER FUNCTIONS
// ============================================================


// ============================================================
// CANONICAL CATALOG & FORMAT FILTERS
// ============================================================
//
// The AniList ID is the only anime identity this server exposes: every catalog
// entry leaves with `id === anilistId`. Curated entries in ANIME_DB therefore
// carry `anilistId` alone, and no hand-assigned local key can collide with a
// real AniList ID.

const CURATED_CATALOG = ANIME_DB.map(withCanonicalId);

// Format groups shared by the catalog endpoints and by genre filtering, so the
// TV Series page can never be served films (and Movies can never be series).
const TYPE_FILTERS = {
  series: { formats: ['TV', 'TV_SHORT'] },
  movies: { formats: ['MOVIE'] }
};

// Every AniList query filters `isAdult: false`, so adult-only genres are never
// offered or served either.
const ADULT_GENRES = new Set(['hentai']);
const MAX_GENRE_LENGTH = 50;

function typeValueOf(anime) {
  return String(anime?.type || anime?.format || '').toUpperCase();
}

function matchesTypeFilter(anime, typeKey) {
  const filter = TYPE_FILTERS[typeKey];
  if (!filter) return true;
  return filter.formats.includes(typeValueOf(anime));
}

function animeMatchesGenre(anime, genre) {
  const wanted = String(genre || '').toLowerCase();
  return (anime?.genre || anime?.genres || []).some(
    value => String(value).toLowerCase() === wanted
  );
}

function curatedCatalogWhere(predicate) {
  return CURATED_CATALOG.filter(predicate);
}

function curatedGenres() {
  const genres = new Set();
  ANIME_DB.forEach(anime => {
    (anime.genre || []).forEach(genre => genres.add(genre));
  });
  return [...genres];
}

// ============================================================
// LIVE CATALOG CACHING
// ============================================================
//
// AniList is the source of truth for every catalog list. Each list is cached in
// memory for ten minutes; a failed refresh serves the last good list, and when
// there has never been one the curated catalog answers instead, so the site
// keeps working with AniList unavailable. Every fallback logs which source
// answered, so a cached or curated list is never mistaken for a live one.

// Catalog list cache TTL. Tests override this to exercise cache-expiry paths
// (the stale fallback when a refresh fails) without waiting out the production
// window; unset or empty keeps the production default. Like TRUST_PROXY, an
// invalid value fails fast at startup instead of silently misbehaving.
const rawCatalogCacheTtl = process.env.CATALOG_CACHE_TTL_MS;
const CATALOG_CACHE_TTL_MS = rawCatalogCacheTtl === undefined || rawCatalogCacheTtl.trim() === ''
  ? 10 * 60 * 1000
  : Number(rawCatalogCacheTtl);
if (!Number.isFinite(CATALOG_CACHE_TTL_MS) || CATALOG_CACHE_TTL_MS < 0) {
  throw new Error('CATALOG_CACHE_TTL_MS must be a finite, non-negative number of milliseconds; leave it unset for the default.');
}
const CATALOG_TIMEOUT_MS = 10000;
const GENRE_CACHE_LIMIT = 30;
const genreCatalogCache = new Map();
const genreListCache = {
  data: null,
  expiresAt: 0,
  pending: null
};

/**
 * Build a catalog query. Sort, per-page and format are server-defined
 * constants; the genre is the only user-supplied value and is always passed as
 * a GraphQL variable rather than interpolated into the document.
 */
function buildCatalogQuery({ perPage, sort, formatIn, genre = false }) {
  const args = ['type: ANIME', `sort: ${sort}`, 'isAdult: false'];
  if (formatIn?.length) args.push(`format_in: [${formatIn.join(', ')}]`);
  if (genre) args.push('genre: $genre');
  const variables = genre ? '($genre: String)' : '';
  return `query${variables} {
  Page(page: 1, perPage: ${perPage}) {
    media(${args.join(', ')}) {
      ${CATALOG_MEDIA_FIELDS}
    }
  }
}`;
}

/**
 * Fetch one AniList media page and sanitize it. An empty list is a legitimate
 * answer for a filtered query, so only a malformed response or a GraphQL error
 * throws here.
 */
async function fetchAniListPage(query, variables = {}) {
  const response = await axios.post(
    ANILIST_GRAPHQL_URL,
    { query, variables },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: CATALOG_TIMEOUT_MS
    }
  );
  if (response.data?.errors) {
    throw new Error(response.data.errors.map(error => error.message).join('; '));
  }

  const page = safe(response, 'data.data.Page', null);
  if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.media)) {
    throw new Error('AniList returned an invalid catalog response.');
  }

  const pageInfo = page.pageInfo;
  if (pageInfo !== null && pageInfo !== undefined
    && (typeof pageInfo !== 'object' || Array.isArray(pageInfo))) {
    throw new Error('AniList returned invalid catalog pagination metadata.');
  }
  return {
    media: page.media.map(anime => ({
      ...anime,
      description: sanitizeDescription(anime.description)
    })),
    pageInfo: pageInfo || null
  };
}

/** Validate the search payload before it can be cached or labelled as live. */
function extractAniListSearchMedia(response) {
  if (response.data?.errors) {
    throw new Error(response.data.errors.map(error => error.message).join('; '));
  }
  const page = safe(response, 'data.data.Page', null);
  if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.media)) {
    throw new Error('AniList returned an invalid search response.');
  }
  return page.media;
}

async function fetchAniListMedia(query, variables = {}) {
  return (await fetchAniListPage(query, variables)).media;
}

/** Fetch one live AniList catalog page, sanitized and merged with curation. */
async function fetchLiveCatalog(query, variables = {}) {
  const sanitizedMedia = await fetchAniListMedia(query, variables);
  if (sanitizedMedia.length === 0) {
    throw new Error('AniList returned no catalog entries.');
  }
  return mergeAniListCatalog(ANIME_DB, sanitizedMedia);
}

/** Wrap one live catalog source in the shared cache/fallback behaviour. */
function createCatalogLoader({ label, query, filter, fallback }) {
  const cache = {
    data: null,
    source: null,
    expiresAt: 0,
    pending: null
  };

  return async function loadCatalog() {
    if (cache.data && Date.now() < cache.expiresAt) {
      return { data: cache.data, source: cache.source || 'anilist' };
    }
    if (cache.pending) return cache.pending;

    const staleCatalog = cache.data;
    cache.pending = (async () => {
      try {
        const liveCatalog = await fetchLiveCatalog(query());
        // The merge appends curated entries that the live list did not cover,
        // so a filtered list re-checks the filter: a films list can neither
        // carry a curated series nor a series list a curated film.
        const catalog = filter ? liveCatalog.filter(filter) : liveCatalog;
        cache.data = catalog;
        cache.source = 'anilist';
        cache.expiresAt = Date.now() + CATALOG_CACHE_TTL_MS;
        return { data: catalog, source: 'anilist' };
      } catch (error) {
        console.warn(`AniList ${label} catalog unavailable; using ${staleCatalog ? 'cached' : 'curated'} catalog: ${error.message}`);
        if (staleCatalog) return { data: staleCatalog, source: 'anilist' };
        return { data: fallback(), source: 'curated' };
      } finally {
        cache.pending = null;
      }
    })();

    return cache.pending;
  };
}

const getPopularCatalog = createCatalogLoader({
  label: 'popular',
  query: () => buildCatalogQuery({ perPage: 50, sort: 'POPULARITY_DESC' }),
  fallback: () => CURATED_CATALOG
});

const getTrendingCatalog = createCatalogLoader({
  label: 'trending',
  query: () => buildCatalogQuery({ perPage: 20, sort: 'TRENDING_DESC' }),
  fallback: () => CURATED_CATALOG
});

const getMoviesCatalog = createCatalogLoader({
  label: 'movie',
  query: () => buildCatalogQuery({ perPage: 50, sort: 'POPULARITY_DESC', formatIn: TYPE_FILTERS.movies.formats }),
  filter: anime => matchesTypeFilter(anime, 'movies'),
  fallback: () => curatedCatalogWhere(anime => matchesTypeFilter(anime, 'movies'))
});

const getSeriesCatalog = createCatalogLoader({
  label: 'TV series',
  query: () => buildCatalogQuery({ perPage: 50, sort: 'POPULARITY_DESC', formatIn: TYPE_FILTERS.series.formats }),
  filter: anime => matchesTypeFilter(anime, 'series'),
  fallback: () => curatedCatalogWhere(anime => matchesTypeFilter(anime, 'series'))
});

/**
 * Genre filtering, live first. AniList defines no "Shounen" genre, for example,
 * while the curated catalog still labels those titles — so a genre AniList
 * cannot serve at all is answered from curation instead of returning nothing.
 */
async function getGenreCatalog(genre, typeKey) {
  const cacheKey = `${genre.toLowerCase()}|${typeKey || 'all'}`;
  const cached = genreCatalogCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { data: cached.data, source: 'anilist' };
  }

  const curatedMatches = () => curatedCatalogWhere(anime =>
    animeMatchesGenre(anime, genre) && (!typeKey || matchesTypeFilter(anime, typeKey))
  );

  const knownGenres = await getGenreList();
  if (!knownGenres.some(name => String(name).toLowerCase() === genre.toLowerCase())) {
    return { data: curatedMatches(), source: 'curated' };
  }

  let liveCatalog;
  try {
    liveCatalog = await fetchLiveCatalog(
      buildCatalogQuery({
        perPage: 30,
        sort: 'POPULARITY_DESC',
        formatIn: typeKey ? TYPE_FILTERS[typeKey].formats : undefined,
        genre: true
      }),
      { genre }
    );
  } catch (error) {
    console.warn(`AniList "${genre}" catalog unavailable; using ${cached ? 'cached' : 'curated'} catalog: ${error.message}`);
    return cached
      ? { data: cached.data, source: 'anilist' }
      : { data: curatedMatches(), source: 'curated' };
  }

  // Curated entries the merge appends only belong in this result when they
  // carry the requested genre — and the requested format, on a typed page.
  const catalog = liveCatalog.filter(anime =>
    animeMatchesGenre(anime, genre) && (!typeKey || matchesTypeFilter(anime, typeKey))
  );

  genreCatalogCache.set(cacheKey, {
    data: catalog,
    expiresAt: Date.now() + CATALOG_CACHE_TTL_MS
  });
  if (genreCatalogCache.size > GENRE_CACHE_LIMIT) {
    genreCatalogCache.delete(genreCatalogCache.keys().next().value);
  }
  return { data: catalog, source: 'anilist' };
}

/** The genres this catalog can filter by: live AniList genres plus curation. */
async function getGenreList() {
  if (genreListCache.data && Date.now() < genreListCache.expiresAt) return genreListCache.data;
  if (genreListCache.pending) return genreListCache.pending;

  const staleGenres = genreListCache.data;
  genreListCache.pending = (async () => {
    try {
      const response = await axios.post(
        ANILIST_GRAPHQL_URL,
        { query: 'query { GenreCollection }' },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: CATALOG_TIMEOUT_MS
        }
      );
      const genres = safe(response, 'data.data.GenreCollection', null);
      if (!Array.isArray(genres) || genres.length === 0) {
        throw new Error('AniList returned no genres.');
      }
      const usableGenres = genres.filter(genre => !ADULT_GENRES.has(String(genre).toLowerCase()));
      genreListCache.data = usableGenres;
      genreListCache.expiresAt = Date.now() + CATALOG_CACHE_TTL_MS;
      return usableGenres;
    } catch (error) {
      console.warn(`AniList genre list unavailable; using ${staleGenres ? 'cached' : 'curated'} genres: ${error.message}`);
      return staleGenres || curatedGenres();
    } finally {
      genreListCache.pending = null;
    }
  })();

  return genreListCache.pending;
}


// ============================================================
// RECOMMENDATIONS — client-owned watchlist signals, AniList-backed
// ============================================================
//
// The client sends only derived genre weights and AniList IDs. This endpoint
// does not read, persist, or authenticate a watchlist; it validates the
// request, binds all values as GraphQL variables, and returns the same
// catalog shape as /api/browse. Live responses are cached briefly and a stale
// response or curated catalog keeps the endpoint useful during an outage.

const RECOMMENDATION_CACHE_LIMIT = 100;
const recommendationCache = new Map();
const pendingRecommendationRequests = new Map();

function recommendationCacheKey(input) {
  return JSON.stringify({
    genres: [...input.genreWeights]
      .map(entry => [String(entry.name).toLowerCase(), Number(entry.weight)])
      .sort((a, b) => a[0].localeCompare(b[0])),
    favoriteIds: [...input.favoriteIds].sort((a, b) => a - b)
  });
}

function recommendationFallback(input) {
  const favoriteIds = new Set(input.favoriteIds);
  const wantedGenres = input.genreWeights.map(entry => entry.name);
  const fallback = filterCatalogLocally(CURATED_CATALOG, {
    genres: wantedGenres,
    sort: 'score'
  });
  const candidates = (wantedGenres.length ? fallback : CURATED_CATALOG)
    .filter(item => !favoriteIds.has(Number(item?.id || item?.anilistId)));
  return candidates.slice(0, RECOMMENDATIONS_MAX_RESULTS);
}

function recommendationScore(item, weights, position) {
  const genres = Array.isArray(item?.genre) ? item.genre : Array.isArray(item?.genres) ? item.genres : [];
  const weightedGenreScore = genres.reduce((sum, genre) => sum + (weights.get(String(genre).toLowerCase()) || 0), 0);
  const rating = Number(item?.rating || 0);
  // Genre affinity dominates; score and provider order only break ties.
  return weightedGenreScore * 1000 + rating * 10 + Math.max(0, 100 - position) / 100;
}

function rankRecommendationMedia(media, input) {
  const favoriteIds = new Set(input.favoriteIds);
  const weights = new Map(input.genreWeights.map(entry => [entry.name.toLowerCase(), entry.weight]));
  const byId = new Map();
  media.forEach((item, position) => {
    const id = Number(item?.id || item?.anilistId);
    if (!Number.isSafeInteger(id) || favoriteIds.has(id) || byId.has(id)) return;
    byId.set(id, { item, score: recommendationScore(item, weights, position) });
  });
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || Number(a.item.id) - Number(b.item.id))
    .map(entry => entry.item)
    .slice(0, RECOMMENDATIONS_MAX_RESULTS);
}

async function fetchRecommendations(input) {
  const { query, variables } = buildRecommendationsGraphQL(input, {
    perPage: RECOMMENDATIONS_MAX_RESULTS
  });
  const response = await axios.post(
    ANILIST_GRAPHQL_URL,
    { query, variables },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: CATALOG_TIMEOUT_MS
    }
  );
  if (response.data?.errors) {
    throw new Error(response.data.errors.map(error => error.message).join('; '));
  }

  const payload = safe(response, 'data.data', null);
  if (!payload || typeof payload !== 'object') {
    throw new Error('AniList returned an invalid recommendations response.');
  }
  const media = [];
  const genrePage = payload.genrePage || payload.Page;
  if (Array.isArray(genrePage?.media)) media.push(...genrePage.media);
  const favoritePage = payload.favoritePage || (!input.genreWeights.length ? payload.Page : null);
  if (Array.isArray(favoritePage?.media)) {
    for (const favorite of favoritePage.media) {
      const edges = favorite?.recommendations?.edges;
      if (!Array.isArray(edges)) continue;
      for (const edge of edges) {
        const recommendation = edge?.node?.mediaRecommendation;
        if (recommendation) media.push(recommendation);
      }
    }
  }
  const sanitized = media.map(item => ({
    ...item,
    description: sanitizeDescription(item?.description)
  }));
  return rankRecommendationMedia(mergeAniListCatalog([], sanitized), input);
}

async function getRecommendations(input) {
  const key = recommendationCacheKey(input);
  const cached = recommendationCache.get(key);
  if (cached?.pending) return cached.pending;
  const inFlight = pendingRecommendationRequests.get(key);
  if (inFlight) return inFlight;
  if (cached && Date.now() < cached.expiresAt) {
    return { data: cached.data, source: 'anilist' };
  }
  const stale = cached?.data || null;
  const pending = (async () => {
    try {
      const data = await fetchRecommendations(input);
      if (!data.length) {
        throw new Error('AniList returned no recommendations.');
      }
      const entry = { data, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS };
      boundedCacheSet(recommendationCache, key, entry, RECOMMENDATION_CACHE_LIMIT);
      return { data, source: 'anilist' };
    } catch (error) {
      console.warn(`AniList recommendations unavailable; using ${stale ? 'cached' : 'curated'} catalog: ${error.message}`);
      return {
        data: stale || recommendationFallback(input),
        source: stale ? 'anilist' : 'curated'
      };
    } finally {
      if (pendingRecommendationRequests.get(key) === pending) {
        pendingRecommendationRequests.delete(key);
      }
    }
  })();
  pendingRecommendationRequests.set(key, pending);
  return pending;
}

app.post('/api/recommendations', async (req, res) => {
  const parsed = parseRecommendationInput(req.body);
  if (parsed.errors.length) {
    return res.status(400).json({ message: parsed.errors[0] });
  }
  const result = await getRecommendations(parsed);
  res.setHeader('X-Catalog-Source', result.source);
  return res.json(result.data);
});


// ============================================================
// TRENDING
// ============================================================

app.get('/api/trending', async (req, res) => {
  const result = await getTrendingCatalog();
  res.setHeader('X-Catalog-Source', result.source);
  return res.json(result.data);
});


// ============================================================
// MOVIES
// ============================================================

app.get('/api/movies', async (req, res) => {
  const result = await getMoviesCatalog();
  res.setHeader('X-Catalog-Source', result.source);
  return res.json(result.data);
});


// ============================================================
// TV SERIES
// ============================================================

app.get('/api/series', async (req, res) => {
  const result = await getSeriesCatalog();
  res.setHeader('X-Catalog-Source', result.source);
  return res.json(result.data);
});


// ============================================================
// POPULAR
// ============================================================

app.get('/api/popular', async (req, res) => {
  const result = await getPopularCatalog();
  res.setHeader('X-Catalog-Source', result.source);
  return res.json(result.data);
});


// ============================================================
// PAGINATION METADATA (shared by /api/browse and its fallback)
// ============================================================

/**
 * Normalize AniList's pageInfo (or a length-only fallback) into the pagination
 * metadata the response headers carry. `maxPage` caps the advertised page
 * window: the browse API never navigates beyond `BROWSE_MAX_PAGE`, so page 50
 * is the last navigable page even when AniList reports more results.
 */
function pageMeta(pageInfo, page, itemCount, fallbackPerPage = CATALOG_PER_PAGE, maxPage = BROWSE_MAX_PAGE, totalCount = null) {
  return normalizeBrowsePageMeta(pageInfo, {
    page,
    perPage: fallbackPerPage,
    itemCount,
    totalCount,
    maxPage
  });
}


// ============================================================
// BROWSE — strict filters + Load more pagination (Task 2A)
// ============================================================
//
// Backs the Popular page's Load more flow: fixed enum allowlists, page 1..50,
// perPage 1..30, repeated params rejected, and a shorter five-minute cache
// (max 100 entries). Validation lives in `catalog-filters.js`; on an AniList
// outage the curated catalog answers with the same semantics, and
// `X-Catalog-Source` keeps naming the answering source.

const BROWSE_CACHE_TTL_MS = 5 * 60 * 1000;
const BROWSE_CACHE_LIMIT = 100;
const browseQueryCache = new Map();

function cacheBrowseQuery(key, entry) {
  // FIFO eviction lives in catalog-filters.js so a unit test can cover the
  // "max 100 entries" guarantee without booting the server.
  boundedCacheSet(browseQueryCache, key, entry, BROWSE_CACHE_LIMIT);
}

/** Resolve one validated browse page as `{ data, source, meta }`. */
async function getBrowsePage(filters, perPage) {
  const key = browseCacheKey(filters, perPage);
  const cached = browseQueryCache.get(key);
  if (cached?.pending) return cached.pending;
  // A warm entry is returned whole, `meta` included — the same crash the
  // catalog cache once had on its fresh-hit path.
  if (cached && Date.now() < cached.expiresAt) {
    return { data: cached.data, source: cached.source, meta: cached.meta };
  }

  const stale = cached && cached.data ? cached : null;
  const pending = (async () => {
    const { query, variables } = buildCatalogGraphQL(filters, { perPage });
    try {
      const { media, pageInfo } = await fetchAniListPage(query, variables);
      // AniList already applied the filters, the sort and the paging; merging
      // with an empty local catalog only normalizes the item shape and the
      // canonical `id === anilistId`, so a page can never exceed perPage or
      // repeat a title. Curated data still answers when AniList is down.
      const catalog = mergeAniListCatalog([], media);
      const entry = {
        data: catalog,
        source: 'anilist',
        meta: pageMeta(pageInfo, filters.page, catalog.length, perPage, BROWSE_MAX_PAGE),
        expiresAt: Date.now() + BROWSE_CACHE_TTL_MS,
        pending: null
      };
      cacheBrowseQuery(key, entry);
      return { data: entry.data, source: entry.source, meta: entry.meta };
    } catch (error) {
      console.warn(`AniList browse unavailable; using ${stale ? 'cached' : 'curated'} catalog: ${error.message}`);
      // Clear the in-flight marker so the next request can retry AniList.
      if (browseQueryCache.get(key)?.pending === pending) browseQueryCache.delete(key);
      if (stale) return { data: stale.data, source: stale.source, meta: stale.meta };
      // The curated fallback pages locally with the requested page size, so
      // Load more keeps honest boundaries while AniList is unavailable.
      const matches = filterCatalogLocally(CURATED_CATALOG, filters);
      const start = (filters.page - 1) * perPage;
      const curatedResults = matches.slice(start, start + perPage);
      // If curated returns nothing, try Kitsu as a final fallback.
      if (curatedResults.length === 0 && process.env.KITSU_ENABLED === '1') {
        const kitsuGenre = filters.genres && filters.genres.length ? filters.genres[0] : '';
        const kitsuResults = await fetchKitsuFallback(kitsuGenre, perPage);
        if (kitsuResults.length > 0) {
          return {
            data: kitsuResults,
            source: 'kitsu',
             meta: pageMeta(null, filters.page, kitsuResults.length, perPage, BROWSE_MAX_PAGE, kitsuResults.length)
          };
        }
      }
      return {
        data: matches.slice(start, start + perPage),
        source: 'curated',
        meta: pageMeta(null, filters.page, curatedResults.length, perPage, BROWSE_MAX_PAGE, matches.length)
      };
    }
  })();

  cacheBrowseQuery(key, { data: null, source: null, meta: null, expiresAt: 0, pending });
  return pending;
}

app.get('/api/browse', async (req, res) => {
  // Phase 1: structural validation only — no upstream provider call. Malformed
  // or out-of-range parameters, repeated parameters, and malformed/too-long
  // genre values are rejected here without touching AniList. The genre
  // allowlist is deliberately not loaded yet.
  const structural = parseBrowseFilters(req.query, {
    knownGenres: undefined,
    skipGenreMembership: true,
    maxYear: new Date().getFullYear() + 1
  });

  if (structural.errors.length) {
    return res.status(400).json({ message: structural.errors[0] });
  }

  // Phase 2: load the genre allowlist only when a syntactically-valid genre
  // was provided, so unknown-genre membership can be confirmed. This is the
  // only path that calls the provider, and only for structurally-valid genre
  // requests. Without a genre parameter curated genres suffice and no provider
  // call is made.
  let filters;
  let perPage;
  if (structural.filters.genres && structural.filters.genres.length) {
    const knownGenres = new Set([...(await getGenreList()), ...curatedGenres()]);
    const validated = parseBrowseFilters(req.query, {
      knownGenres,
      maxYear: new Date().getFullYear() + 1
    });
    if (validated.errors.length) {
      return res.status(400).json({ message: validated.errors[0] });
    }
    filters = validated.filters;
    perPage = validated.perPage;
  } else {
    filters = structural.filters;
    perPage = structural.perPage;
  }

  const { data, source, meta } = await getBrowsePage(filters, perPage);
  res.setHeader('X-Catalog-Source', source);
  // Pagination metadata travels in headers so the response body stays a plain
  // list, exactly like every other catalog endpoint. `X-Catalog-Page` is
  // AniList's `pageInfo.currentPage` and `X-Catalog-Has-Next` its
  // `pageInfo.hasNextPage` (or the curated fallback's local arithmetic).
  res.setHeader('X-Catalog-Page', String(meta.page));
  res.setHeader('X-Catalog-Per-Page', String(meta.perPage));
  res.setHeader('X-Catalog-Total-Pages', String(meta.totalPages));
  res.setHeader('X-Catalog-Has-Next', meta.hasNext ? 'true' : 'false');
  if (meta.total !== null) res.setHeader('X-Catalog-Total', String(meta.total));
  if (source === 'kitsu') res.setHeader('X-Catalog-Provider', 'kitsu');
  res.json(data);
});


// ============================================================
// MANGA / MANHWA / MANHUA (isolated AniList content pipeline)
// ============================================================

const MANGA_CACHE_TTL_MS = 5 * 60 * 1000;
const MANGA_CACHE_LIMIT = 100;
const mangaContentCache = new Map();

function cacheMangaContent(key, value) {
  if (mangaContentCache.size >= MANGA_CACHE_LIMIT && !mangaContentCache.has(key)) {
    mangaContentCache.delete(mangaContentCache.keys().next().value);
  }
  mangaContentCache.set(key, value);
}

function mangaMeta(pageInfo, page, perPage, count, rawCount = count) {
  const hasNext = page < 50 && (typeof pageInfo?.hasNextPage === 'boolean' ? pageInfo.hasNextPage : rawCount >= perPage);
  // Provider totals describe the unfiltered page. Once malformed or
  // misclassified records are removed, do not expose a misleading total.
  const pageInfoMatchesRequest = Number.isSafeInteger(pageInfo?.currentPage)
    && pageInfo.currentPage === page
    && Number.isSafeInteger(pageInfo?.perPage)
    && pageInfo.perPage === perPage;
  const total = rawCount === count && pageInfoMatchesRequest && Number.isSafeInteger(pageInfo?.total) && pageInfo.total >= 0
    ? pageInfo.total
    : null;
  // A provider lastPage beyond our supported navigation window is not an
  // exact total for this API. Never relabel the page-50 cap as total pages.
  const totalPages = rawCount === count && pageInfoMatchesRequest
    && Number.isSafeInteger(pageInfo?.lastPage)
    && pageInfo.lastPage >= page
    && pageInfo.lastPage <= 50
    ? pageInfo.lastPage
    : null;
  return { page, perPage, total, totalPages, hasNext };
}

async function fetchMangaPage(options) {
  const { query, variables } = buildMangaGraphQL(options);
  const response = await axios.post(ANILIST_GRAPHQL_URL, { query, variables }, {
    headers: { 'Content-Type': 'application/json' }, timeout: CATALOG_TIMEOUT_MS
  });
  if (response.data?.errors) throw new Error(response.data.errors.map(error => error.message).join('; '));
  const page = safe(response, 'data.data.Page', null);
  if (!page || !Array.isArray(page.media)) throw new Error('AniList returned an invalid manga response.');
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
      const value = { data, meta: mangaMeta(result.pageInfo, options.page, options.perPage, data.length, result.media.length), source: 'anilist' };
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
  const routeKind = req.path.split('/')[2];
  return CONTENT_KINDS.has(routeKind) ? routeKind : normalizeContentKind(req.query.type, 'manga');
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

for (const route of ['/api/manga', '/api/manhwa', '/api/manhua', '/api/manga/discover', '/api/manhwa/discover', '/api/manhua/discover']) app.get(route, handleMangaDiscovery);

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

for (const route of ['/api/manga/search', '/api/manhwa/search', '/api/manhua/search']) app.get(route, handleMangaSearch);

async function handleMangaDetail(req, res) {
  const kind = routeContentKind(req);
  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id)) || Number(req.params.id) < 1 || Number(req.params.id) > 2147483647) {
    return res.status(400).json({ message: 'Invalid manga ID.' });
  }
  const id = Number(req.params.id);
  const key = mangaCacheKey({ kind, id });
  const cached = mangaContentCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return res.json(cached.value);
  try {
    const { query, variables } = buildMangaGraphQL({ kind, detail: true, id });
    const response = await axios.post(ANILIST_GRAPHQL_URL, { query, variables }, { headers: { 'Content-Type': 'application/json' }, timeout: CATALOG_TIMEOUT_MS });
    if (response.data?.errors) throw new Error(response.data.errors.map(error => error.message).join('; '));
    const media = safe(response, 'data.data.Media', null);
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

for (const route of ['/api/manga/:id', '/api/manhwa/:id', '/api/manhua/:id']) app.get(route, handleMangaDetail);


// ============================================================
// SEARCH (AniList first, local fallback)
// ============================================================

function mapMediaToSuggestion(media) {
  const id = media.id || media.anilistId;
  const poster = media.coverImage?.extraLarge || media.coverImage?.large || media.poster || media.image || null;
  return {
    id,
    anilistId: id,
    title: media.title,
    coverImage: { large: poster },
    bannerImage: media.bannerImage || media.banner || null,
    format: media.format || media.type || null,
    season: media.season || null,
    seasonYear: media.seasonYear || media.year || null,
    averageScore: media.averageScore || (media.rating ? Math.round(media.rating * 10) : null)
  };
}

async function fetchAniListSuggestions(query) {
  const graphqlQuery = `
    query ($search: String) {
      Page(perPage: 10) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          id
          title {
            romaji
            english
            native
          }
          coverImage {
            large
          }
          bannerImage
          averageScore
          season
          seasonYear
          format
        }
      }
    }
  `;
  const response = await axios.post(
    ANILIST_GRAPHQL_URL,
    { query: graphqlQuery, variables: { search: query } },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    }
  );

  if (response.data.errors) {
    throw new Error(response.data.errors.map(error => error.message).join('; '));
  }

  const media = safe(response, 'data.data.Page.media', []);
  if (!Array.isArray(media)) {
    throw new Error('AniList returned an invalid suggestions response.');
  }

  let results = rankAnimeSuggestions(deduplicateMediaList(media), query);
  if (query.length <= 3 || !results.some(anime => suggestionMatchRank(anime, query) >= 2)) {
    const localMatches = query.length <= 3
      ? ANIME_DB.map(mapLocalAnimeToAniList)
        .filter(anime => suggestionMatchRank(anime, query) >= 2)
      : searchAnimeLocalFuzzy(ANIME_DB, query).map(mapLocalAnimeToAniList);
    results = rankAnimeSuggestions(deduplicateMediaList([...localMatches, ...results]), query);
  }

  return results.slice(0, 10).map(mapMediaToSuggestion);
}

function getLocalSuggestions(query) {
  const exactAndPartialMatches = searchAnimeLocal(ANIME_DB, query);
  const typoMatches = searchAnimeLocalFuzzy(ANIME_DB, query);
  const candidates = deduplicateMediaList(
    [...exactAndPartialMatches, ...typoMatches].map(mapLocalAnimeToAniList)
  );
  return rankAnimeSuggestions(candidates, query)
    .filter(anime => suggestionMatchRank(anime, query) > 0)
    .slice(0, 10)
    .map(mapMediaToSuggestion);
}

app.get('/api/search/suggestions', async (req, res) => {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q : '';

  // Reject control characters on the raw input before any normalization.
  const hasControlCharacter = [...rawQuery].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint < 0x20 || codePoint === 0x7F;
  });
  if (hasControlCharacter) {
    return res.status(400).json({
      message: 'Search query contains characters that are not allowed.'
    });
  }

  const query = rawQuery.trim().replace(/\s+/g, ' ');

  if (query.length < 2 || query.length > 100) {
    return res.status(400).json({
      message: 'Enter an anime name of 2 to 100 characters.'
    });
  }

  const cacheKey = query.toLowerCase();
  const cached = suggestionCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    suggestionCache.delete(cacheKey);
    suggestionCache.set(cacheKey, cached);
    return res.json(cached.results);
  }
  if (cached) suggestionCache.delete(cacheKey);

  let pending = pendingSuggestionRequests.get(cacheKey);
  if (!pending) {
    pending = fetchAniListSuggestions(query);
    pendingSuggestionRequests.set(cacheKey, pending);
  }

  try {
    const results = await pending;
    if (pendingSuggestionRequests.get(cacheKey) === pending) {
      pendingSuggestionRequests.delete(cacheKey);
    }
    if (suggestionCache.size >= SUGGESTION_CACHE_LIMIT) {
      suggestionCache.delete(suggestionCache.keys().next().value);
    }
    suggestionCache.set(cacheKey, {
      expiresAt: Date.now() + SUGGESTION_CACHE_TTL_MS,
      results
    });
    res.json(results);
  } catch (error) {
    if (pendingSuggestionRequests.get(cacheKey) === pending) {
      pendingSuggestionRequests.delete(cacheKey);
    }
    console.warn(`AniList suggestions unavailable; using local catalog fallback: ${error.message}`);
    const localResults = getLocalSuggestions(query);
    if (localResults.length) return res.json(localResults);
    res.status(502).json({ message: 'Suggestions are temporarily unavailable.' });
  }
});

// SEARCH & DETAIL CACHING (Task P5.2)
// ============================================================
// /api/search and /api/anime/:id are the last AniList-backed routes without a
// server-side cache: every repeat search or detail view paid the full upstream
// latency and spent one of the 60/min rate-limit tokens. They now share the
// catalog cache conventions — the same env-overridable TTL, single-flight
// deduplication, a bounded FIFO cache, and the stale-beats-curated fallback.
// A fallback (curated or local) is never cached, so the next request always
// retries AniList.

const SEARCH_CACHE_LIMIT = 100;
const searchCache = new Map();
const pendingSearchRequests = new Map();
const DETAIL_CACHE_LIMIT = 100;
const detailCache = new Map();
const pendingDetailRequests = new Map();

app.get('/api/search', async (req, res) => {

  const rawQuery = typeof req.query.q === 'string' ? req.query.q : '';

  // Reject control characters before trim() can normalize away tabs/newlines
  // at the beginning or end of an otherwise valid-looking query.
  const hasControlCharacter = [...rawQuery].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint < 0x20 || codePoint === 0x7F;
  });
  if (hasControlCharacter) {
    return res.status(400).json({
      message: "Search query contains characters that are not allowed."
    });
  }

  const query = rawQuery.trim();

  if (!query || query.length > 100) {
    return res.status(400).json({
      message: "Enter an anime name of 1 to 100 characters."
    });
  }

  // Fresh cache hit (case-insensitive key, like the suggestions cache) is
  // served without touching AniList; the entry is re-inserted so hot queries
  // age out last.
  const cacheKey = query.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    searchCache.delete(cacheKey);
    searchCache.set(cacheKey, cached);
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json(cached.results);
  }
  const staleResults = cached ? cached.results : null;

  // Single-flight: concurrent identical queries share one upstream call.
  let pendingSearch = pendingSearchRequests.get(cacheKey);
  if (!pendingSearch) {
    pendingSearch = (async () => {
      const graphqlQuery = `
      query ($search: String) {
        Page(perPage: 10) {
          media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
            id
            title {
              romaji
              english
              native
            }
            coverImage {
              large
            }
            description
            episodes
            status
            averageScore
            genres
            season
            seasonYear
            format
            countryOfOrigin
            studios(isMain: true) {
              nodes {
                name
              }
            }
          }
        }
      }
    `;

      const response = await axios.post(
        ANILIST_GRAPHQL_URL,
        {
          query: graphqlQuery,
          variables: {
            search: query
          }
        },
        {
          headers: {
            "Content-Type": "application/json"
          },
          timeout: 15000
        }
      );

      const mediaList = extractAniListSearchMedia(response);
      // Deduplicate and sanitize descriptions before caching and sending
      return deduplicateMediaList(mediaList).map(anime => ({
        ...anime,
        description: sanitizeDescription(anime.description)
      }));
    })();
    pendingSearchRequests.set(cacheKey, pendingSearch);
  }

  try {
    const sanitized = await pendingSearch;
    if (pendingSearchRequests.get(cacheKey) === pendingSearch) {
      pendingSearchRequests.delete(cacheKey);
    }
    boundedCacheSet(
      searchCache,
      cacheKey,
      { results: sanitized, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS },
      SEARCH_CACHE_LIMIT
    );
    res.setHeader('X-Catalog-Source', 'anilist');
    res.json(sanitized);
  } catch (error) {
    if (pendingSearchRequests.get(cacheKey) === pendingSearch) {
      pendingSearchRequests.delete(cacheKey);
    }
    // The last good answer outranks the curated fallback; the failure itself
    // is never cached.
    if (staleResults) {
      console.warn(`AniList search unavailable; using cached results: ${error.message}`);
      res.setHeader('X-Catalog-Source', 'anilist');
      return res.json(staleResults);
    }
    console.warn('AniList search unavailable; using local catalog fallback.');
    const results = searchAnimeLocal(ANIME_DB, query).map(mapLocalAnimeToAniList);
    if (results.length === 0 && process.env.KITSU_ENABLED === '1') {
      // Final fallback: try Kitsu provider.
      const kitsuResults = await fetchKitsuFallback(query, 10);
      if (kitsuResults.length > 0) {
        res.setHeader('X-Catalog-Source', 'kitsu');
        res.setHeader('X-Catalog-Provider', 'kitsu');
        return res.json(deduplicateMediaList(kitsuResults));
      }
    }
    res.setHeader('X-Catalog-Source', 'local');
    res.json(deduplicateMediaList(results));
  }

});


// ============================================================
// LOCAL SEARCH HELPER
// ============================================================

// ============================================================
// GENRE SEARCH
// ============================================================

app.get('/api/genre/:genre', async (req, res) => {

  const genre = typeof req.params.genre === 'string' ? req.params.genre.trim() : '';

  if (!genre || genre.length > MAX_GENRE_LENGTH) {

    return res.status(400).json({
      message: `Enter a genre name of 1 to ${MAX_GENRE_LENGTH} characters.`
    });

  }

  // Strict input validation: only allow letters, numbers, and basic punctuation
  const allowedGenrePattern = /^[\p{L}\p{N}\s'.-]+$/u;
  if (!allowedGenrePattern.test(genre)) {
    return res.status(400).json({
      message: "Genre contains invalid characters. Use letters, numbers, and .'-."
    });
  }

  if (Array.isArray(req.query.type)) {
    return res.status(400).json({ message: 'Genre type must be provided once.' });
  }
  if (req.query.type !== undefined && typeof req.query.type !== 'string') {
    return res.status(400).json({ message: 'Genre type must be a string.' });
  }
  if (req.query.type && !Object.hasOwn(TYPE_FILTERS, req.query.type)) {
    return res.status(400).json({ message: 'Genre type must be one of: series, movies.' });
  }

  if (ADULT_GENRES.has(genre.toLowerCase())) {

    res.setHeader('X-Catalog-Source', 'curated');
    return res.json([]);

  }

  // `?type=series|movies` keeps a page's genre filter inside its own format
  // group, so filtering by genre can never reintroduce the wrong type.
  const typeKey = req.query.type || null;

  const { data, source } = await getGenreCatalog(genre, typeKey);
  res.setHeader('X-Catalog-Source', source);
  return res.json(data);

});


// ============================================================
// ANIME DETAILS
// ============================================================

app.get('/api/detail/:id', (req, res) => {

  // Retired route. It used to answer from the hand-assigned local id space,
  // which collided with AniList IDs: `/api/detail/1` returned Jujutsu Kaisen
  // while `/api/anime/1` returned Cowboy Bebop. It now permanently redirects
  // to the canonical AniList-id route, so old links resolve to the same anime.
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id < 1) {

    return res.status(404).json({
      message: "Anime not found."
    });

  }

  res.redirect(308, `/api/anime/${id}`);

});


// ============================================================
// GENRES
// ============================================================

app.get('/api/genres', async (req, res) => {

  const genres = new Set(await getGenreList());

  // Curated-only genres stay filterable, so they are listed too — AniList
  // defines no "Shounen" genre, yet the curated catalog labels titles with it.
  curatedGenres().forEach(genre => {

    if (!ADULT_GENRES.has(String(genre).toLowerCase())) genres.add(genre);

  });

  res.json([...genres].sort((a, b) => a.localeCompare(b)));

});


// ============================================================
// ANILIST API DETAILS
// ============================================================

app.get('/api/anime/:id', async (req, res) => {
  const animeId = Number(req.params.id);

  if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(animeId)) {
    return res.status(400).json({ message: "Invalid Anime ID." });
  }

  if (animeId < 1 || animeId > 2147483647) {
    return res.status(400).json({ message: "Anime ID is out of valid range." });
  }

  // Fresh cache hit: the same conventions as the search cache — re-inserted
  // on access so hot titles age out last, and answered as AniList data.
  const cacheKey = String(animeId);
  const cached = detailCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    detailCache.delete(cacheKey);
    detailCache.set(cacheKey, cached);
    res.setHeader('X-Catalog-Source', 'anilist');
    return res.json(cached.data);
  }
  const staleDetail = cached ? cached.data : null;

  const graphqlQuery = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title {
          romaji
          english
          native
        }
        coverImage {
          extraLarge
          large
        }
        bannerImage
        description
        episodes
        status
        averageScore
        genres
        season
        seasonYear
        format
        startDate {
          year
          month
          day
        }
        duration
        source
        countryOfOrigin
        studios(isMain: true) {
          nodes {
            name
          }
        }
        staff(page: 1, perPage: 6, sort: [RELEVANCE]) {
          edges {
            role
            node {
              name {
                full
              }
            }
          }
        }
        characters(page: 1, perPage: 6, sort: [ROLE]) {
          edges {
            role
            node {
              name {
                full
              }
            }
            voiceActors(language: JAPANESE, sort: [RELEVANCE]) {
              name {
                full
              }
              languageV2
            }
          }
        }
        trailer {
          id
          site
        }
        relations {
          edges {
            relationType
            node {
              id
              type
              title {
                romaji
                english
              }
              coverImage {
                large
              }
              bannerImage
              seasonYear
              averageScore
              format
              status
            }
          }
        }
        recommendations(sort: RATING_DESC, perPage: 6) {
          edges {
            node {
              mediaRecommendation {
                id
                title {
                  romaji
                  english
                }
                coverImage {
                  large
                }
                bannerImage
                seasonYear
                averageScore
                format
                status
              }
            }
          }
        }
      }
    }
  `;

  // Single-flight: concurrent views of the same title share one upstream call.
  let pendingDetail = pendingDetailRequests.get(cacheKey);
  if (!pendingDetail) {
    pendingDetail = (async () => {
      const response = await axios.post(
        ANILIST_GRAPHQL_URL,
        {
          query: graphqlQuery,
          variables: { id: animeId }
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 15000
        }
      );

      if (response.data.errors) {
        const error = new Error(response.data.errors.map(entry => entry.message).join('; '));
        error.graphQLErrors = response.data.errors;
        throw error;
      }

      return safe(response, 'data.data.Media', null);
    })();
    pendingDetailRequests.set(cacheKey, pendingDetail);
  }

  try {
    const anime = await pendingDetail;
    if (pendingDetailRequests.get(cacheKey) === pendingDetail) {
      pendingDetailRequests.delete(cacheKey);
    }

    if (!anime) {
      // AniList definitively answered "no such media": that is not a failure,
      // so it is neither masked by stale data nor cached.
      const curated = buildCuratedAnimeDetail(animeId);
      if (curated) {
        console.warn(`AniList returned no entry; serving curated details for ID ${animeId}.`);
        curated.anilistId = curated.id;
        curated.contentKind = 'anime';
        res.setHeader('X-Catalog-Source', 'curated');
        return res.status(200).json(curated);
      }
      return res.status(404).json({ message: "Anime not found on AniList nor in curated catalog." });
    }

    // Sanitize description before sending to client
    anime.description = sanitizeDescription(anime.description);

    // Merge with local catalog data for fields that AniList may not provide
    // (e.g., episode count for ongoing series)
    const localAnime = ANIME_DB.find(a => a.anilistId === animeId);
    if (localAnime) {
      // Use local catalog episode count if AniList doesn't have it
      if ((anime.episodes === null || anime.episodes === 0) && localAnime.episodes && localAnime.episodes > 0) {
        anime.episodes = localAnime.episodes;
      }
      // Also ensure totalEpisodes is available for the client
      if (!anime.totalEpisodes && localAnime.episodes && localAnime.episodes > 0) {
        anime.totalEpisodes = localAnime.episodes;
      }
    }

    anime.anilistId = anime.id;
    anime.contentKind = 'anime';
    boundedCacheSet(
      detailCache,
      cacheKey,
      { data: anime, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS },
      DETAIL_CACHE_LIMIT
    );
    res.setHeader('X-Catalog-Source', 'anilist');
    res.json(anime);

  } catch (error) {
    if (pendingDetailRequests.get(cacheKey) === pendingDetail) {
      pendingDetailRequests.delete(cacheKey);
    }
    if (error.graphQLErrors) {
      console.error("❌ AniList GraphQL Error:", error.graphQLErrors);
    } else {
      console.error("❌ AniList API Error");
      if (error.response) {
        console.error("Status:", error.response.status);
      } else {
        console.error("Message:", error.message);
      }
    }
    // The last good detail outranks the curated fallback; the failure itself
    // is never cached, so the next view retries AniList.
    if (staleDetail) {
      console.warn(`AniList detail refresh failed; serving cached details for ID ${animeId}.`);
      res.setHeader('X-Catalog-Source', 'anilist');
      return res.json(staleDetail);
    }
    // Degraded mode: a curated entry keeps the detail page usable while
    // AniList is down; unknown IDs keep the verified error contract.
    const curated = buildCuratedAnimeDetail(animeId);
    if (curated) {
      console.warn(`AniList unavailable; serving curated details for ID ${animeId}.`);
      curated.anilistId = curated.id;
      curated.contentKind = 'anime';
      res.setHeader('X-Catalog-Source', 'curated');
      return res.status(200).json(curated);
    }
    if (error.graphQLErrors) {
      return res.status(500).json({
        message: "AniList returned an error."
      });
    }
    res.status(500).json({
      message: "Could not connect to AniList API."
    });
  }
});

// ============================================================
// ADMIN & MODERATION (Phase 6)
// ============================================================================
//
// Admin endpoints for content moderation: reports, DMCA takedowns, and system
// stats. Protected by X-Admin-Key header matching ADMIN_KEY env var.
//
// In-memory moderation stores persist only for the server process lifetime;
// reports and takedown requests are seeded with deterministic demo data so the
// admin UI is immediately usable without a backend database.
//

let reports = [];
let dmcaRequests = [];

// Seed demo data so the admin UI is immediately usable.
function seedAdminData() {
  const now = Date.now();
  reports = [
    {
      id: 'r-1',
      type: 'review',
      targetId: '900021',
      targetTitle: 'One Piece',
      reason: 'Contains spoilers without warning tags.',
      reporter: 'viewer_42',
      reportedAt: new Date(now - 3 * 86400000).toISOString(),
      status: 'pending',
      adminNotes: null
    },
    {
      id: 'r-2',
      type: 'comment',
      targetId: '900050',
      targetTitle: 'Ne Zha',
      reason: 'Off-topic promotional link.',
      reporter: 'viewer_17',
      reportedAt: new Date(now - 2 * 86400000).toISOString(),
      status: 'pending',
      adminNotes: null
    },
    {
      id: 'r-3',
      type: 'review',
      targetId: '900051',
      targetTitle: 'The Kings Avatar',
      reason: 'Duplicate of an existing review.',
      reporter: 'viewer_88',
      reportedAt: new Date(now - 1 * 86400000).toISOString(),
      status: 'resolved',
      adminNotes: 'Removed duplicate; kept original review.'
    }
  ];

  dmcaRequests = [
    {
      id: 'dmca-1',
      artworkId: 'gallery-001',
      artworkTitle: 'Jujutsu Kaisen — Key Visual',
      claimantName: 'MAPPA Legal',
      claimantEmail: 'legal@mappa.co.jp',
      claimUrl: 'https://example.com/dmca/1',
      reason: 'Unauthorized use of key visual artwork.',
      submittedAt: new Date(now - 5 * 86400000).toISOString(),
      status: 'pending',
      adminNotes: null
    },
    {
      id: 'dmca-2',
      artworkId: 'gallery-003',
      artworkTitle: 'Demon Slayer — Kimetsu no Yaiba Official Poster',
      claimantName: 'ufotable Inc.',
      claimantEmail: 'rights@ufotable.com',
      claimUrl: 'https://example.com/dmca/2',
      reason: 'Copyright infringement: poster used without license.',
      submittedAt: new Date(now - 4 * 86400000).toISOString(),
      status: 'approved',
      adminNotes: 'Image removed; replacement sourced from official press kit.'
    },
    {
      id: 'dmca-3',
      artworkId: 'gallery-008',
      artworkTitle: 'Fan Art — Gojo Satoru Interpretation',
      claimantName: 'Community Moderator',
      claimantEmail: 'mods@animehub.example',
      claimUrl: 'https://example.com/dmca/3',
      reason: 'Misclassified as official art; relabeled as fan art.',
      submittedAt: new Date(now - 3 * 86400000).toISOString(),
      status: 'dismissed',
      adminNotes: 'Reclassified to Fan Art category; no takedown needed.'
    }
  ];
}

seedAdminData();

// GET /api/admin/reports — list all moderation reports
app.get('/api/admin/reports', requireAdminKey, (req, res) => {
  const { status, type } = req.query;
  let filtered = reports;
  if (status) filtered = filtered.filter(r => r.status === status);
  if (type) filtered = filtered.filter(r => r.type === type);
  filtered = [...filtered].sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt));
  res.json({ reports: filtered, count: filtered.length });
});

// POST /api/admin/reports/:id — update report status
app.post('/api/admin/reports/:id', requireAdminKey, express.json({ limit: '16kb' }), (req, res) => {
  const { status, adminNotes } = req.body;
  if (!status || !['pending', 'resolved', 'dismissed'].includes(status)) {
    return res.status(400).json({ message: 'Valid status (pending, resolved, dismissed) required.' });
  }
  const report = reports.find(r => r.id === req.params.id);
  if (!report) {
    return res.status(404).json({ message: 'Report not found.' });
  }
  report.status = status;
  if (adminNotes !== undefined) report.adminNotes = String(adminNotes);
  res.json({ report });
});

// GET /api/admin/dmca — list all DMCA takedown requests
app.get('/api/admin/dmca', requireAdminKey, (req, res) => {
  const { status } = req.query;
  let filtered = dmcaRequests;
  if (status) filtered = filtered.filter(d => d.status === status);
  filtered = [...filtered].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  res.json({ requests: filtered, count: filtered.length });
});

// POST /api/admin/dmca/:id — process/dismiss DMCA request
app.post('/api/admin/dmca/:id', requireAdminKey, express.json({ limit: '16kb' }), (req, res) => {
  const { status, adminNotes } = req.body;
  if (!status || !['pending', 'approved', 'dismissed'].includes(status)) {
    return res.status(400).json({ message: 'Valid status (pending, approved, dismissed) required.' });
  }
  const request = dmcaRequests.find(d => d.id === req.params.id);
  if (!request) {
    return res.status(404).json({ message: 'DMCA request not found.' });
  }
  request.status = status;
  if (adminNotes !== undefined) request.adminNotes = String(adminNotes);
  res.json({ request });
});

// GET /api/admin/stats — system health, cache status, and metrics
app.get('/api/admin/stats', requireAdminKey, (req, res) => {
  const pendingReports = reports.filter(r => r.status === 'pending').length;
  const pendingDmca = dmcaRequests.filter(d => d.status === 'pending').length;
  const totalReports = reports.length;
  const totalDmca = dmcaRequests.length;

  const browseCacheSize = browseQueryCache.size;
  const genreCacheSize = genreCatalogCache.size;
  const searchCacheSize = searchCache.size;
  const detailCacheSize = detailCache.size;
  const recommendationCacheSize = recommendationCache.size;
  const mangaCacheSize = mangaContentCache.size;

  const providerStatus = {
    anilist: 'healthy',
    kitsu: 'healthy'
  };

  const mem = process.memoryUsage();

  res.json({
    providerStatus,
    caches: {
      browse: browseCacheSize,
      genre: genreCacheSize,
      search: searchCacheSize,
      detail: detailCacheSize,
      recommendation: recommendationCacheSize,
      manga: mangaCacheSize,
      total: browseCacheSize + genreCacheSize + searchCacheSize + detailCacheSize + recommendationCacheSize + mangaCacheSize
    },
    memory: {
      rssMB: (mem.rss / 1024 / 1024).toFixed(2),
      heapUsedMB: (mem.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(2),
      externalMB: (mem.external / 1024 / 1024).toFixed(2)
    },
    moderation: {
      totalReports,
      pendingReports,
      resolvedReports: reports.filter(r => r.status === 'resolved').length,
      dismissedReports: reports.filter(r => r.status === 'dismissed').length,
      totalDmcaRequests: totalDmca,
      pendingDmcaRequests: pendingDmca,
      approvedDmca: dmcaRequests.filter(d => d.status === 'approved').length,
      dismissedDmca: dmcaRequests.filter(d => d.status === 'dismissed').length
    },
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version
  });
});

// Unknown routes answer with JSON for API paths, or serve public/404.html for browser pages.
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path === '/api') {
    return res.status(404).json({ message: 'Not found.' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.message === 'Not allowed by CORS'
    ? 403
    : [400, 413].includes(error.status)
      ? error.status
      : 500;

  console.error(`Request failed (${status}) [${req.id || 'no-request-id'}]: ${error.message}`);
  res.status(status).json({
    message: status === 413
      ? 'Request body is too large.'
      : status === 400
        ? 'Invalid request.'
        : status === 403
          ? 'This origin is not allowed.'
          : 'An internal server error occurred.'
  });
});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`AnimeHub server listening on port ${PORT}.`);
});
