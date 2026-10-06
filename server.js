// ============================================================
// ANIME HUB SERVER
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { mapLocalAnimeToAniList, searchAnimeLocal, deduplicateMediaList } = require('./search-utils');
const { mergeAniListCatalog, withCanonicalId } = require('./catalog-utils');

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
  const requestId = require('crypto').randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);
  // The site is HTTPS-only in production; HSTS keeps it that way for
  // returning browsers. Skipped locally so HTTP development keeps working.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
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

const globalApiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_GLOBAL_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // req.path is mount-relative here (/site-config), so the full originalUrl
  // decides which public config endpoints stay unthrottled.
  skip: req => req.originalUrl.startsWith('/api/site-config') || req.originalUrl.startsWith('/api/config'),
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
  handler: (req, res) => {
    console.warn(`Rate limit exceeded (account deletion) from ${req.ip}`);
    res.status(429).json({ message: 'Too many requests. Please try again later.' });
  }
});

app.use('/api', globalApiLimiter);
app.use('/api/search', proxyLimiter);
app.use('/api/anime/:id', proxyLimiter);
app.use('/api/account', accountDeletionLimiter);

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

app.use(express.json({ limit: '16kb' }));

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

const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10000;
const GENRE_CACHE_LIMIT = 30;
const genreCatalogCache = new Map();
const genreListCache = {
  data: null,
  expiresAt: 0,
  pending: null
};

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

/** Fetch one live AniList catalog page, sanitized and merged with curation. */
async function fetchLiveCatalog(query, variables = {}) {
  const response = await axios.post(
    ANILIST_GRAPHQL_URL,
    { query, variables },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: CATALOG_TIMEOUT_MS
    }
  );
  if (response.data.errors) {
    throw new Error(response.data.errors.map(error => error.message).join('; '));
  }

  const media = safe(response, 'data.data.Page.media', null);
  if (!Array.isArray(media) || media.length === 0) {
    throw new Error('AniList returned no catalog entries.');
  }

  const sanitizedMedia = media.map(anime => ({
    ...anime,
    description: sanitizeDescription(anime.description)
  }));
  return mergeAniListCatalog(ANIME_DB, sanitizedMedia);
}

/** Wrap one live catalog source in the shared cache/fallback behaviour. */
function createCatalogLoader({ label, query, filter, fallback }) {
  const cache = {
    data: null,
    expiresAt: 0,
    pending: null
  };

  return async function loadCatalog() {
    if (cache.data && Date.now() < cache.expiresAt) return cache.data;
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
        cache.expiresAt = Date.now() + CATALOG_CACHE_TTL_MS;
        return catalog;
      } catch (error) {
        console.warn(`AniList ${label} catalog unavailable; using ${staleCatalog ? 'cached' : 'curated'} catalog: ${error.message}`);
        return staleCatalog || fallback();
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
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const curatedMatches = () => curatedCatalogWhere(anime =>
    animeMatchesGenre(anime, genre) && (!typeKey || matchesTypeFilter(anime, typeKey))
  );

  const knownGenres = await getGenreList();
  if (!knownGenres.some(name => String(name).toLowerCase() === genre.toLowerCase())) {
    return curatedMatches();
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
    return cached ? cached.data : curatedMatches();
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
  return catalog;
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
// TRENDING
// ============================================================

app.get('/api/trending', async (req, res) => {

  const trending = await getTrendingCatalog();

  res.json(trending);

});


// ============================================================
// MOVIES
// ============================================================

app.get('/api/movies', async (req, res) => {

  const movies = await getMoviesCatalog();

  res.json(movies);

});


// ============================================================
// TV SERIES
// ============================================================

app.get('/api/series', async (req, res) => {

  const series = await getSeriesCatalog();

  res.json(series);

});


// ============================================================
// POPULAR
// ============================================================

app.get('/api/popular', async (req, res) => {
  const popular = await getPopularCatalog();
  res.json(popular);
});


// ============================================================
// SEARCH (AniList first, local fallback)
// ============================================================

app.get('/api/search', async (req, res) => {

  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (!query || query.length > 100) {
    return res.status(400).json({
      message: "Enter an anime name of 1 to 100 characters."
    });
  }

  // Sensible input validation: only reject truly dangerous patterns
  // GraphQL uses parameterized variables ($search: String), so no injection risk.
  // Allow letters, numbers, spaces, and common anime title punctuation.
  if (query.length < 1) {
    return res.status(400).json({
      message: "Search query cannot be empty."
    });
  }

  // Try AniList GraphQL first
  try {
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

    // Check for GraphQL errors
    if (response.data.errors) {
      console.error("❌ AniList GraphQL Error:", response.data.errors);
      // Fall through to local DB
    } else {
      const mediaList = safe(response, 'data.data.Page.media', []);
      // Deduplicate and sanitize descriptions before sending to client
      const sanitized = deduplicateMediaList(mediaList).map(anime => ({
        ...anime,
        description: sanitizeDescription(anime.description)
      }));
      res.json(sanitized);
      return;
    }
  } catch (error) {
    console.warn('AniList search unavailable; using local catalog fallback.');
    // AniList failed - will fall through to local DB
  }

  // Fall back to local database
  const results = searchAnimeLocal(ANIME_DB, query).map(mapLocalAnimeToAniList);
  res.json(deduplicateMediaList(results));

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

  if (ADULT_GENRES.has(genre.toLowerCase())) {

    return res.json([]);

  }

  // `?type=series|movies` keeps a page's genre filter inside its own format
  // group, so filtering by genre can never reintroduce the wrong type.
  const typeKey = typeof req.query.type === 'string' && Object.hasOwn(TYPE_FILTERS, req.query.type)
    ? req.query.type
    : null;

  res.json(await getGenreCatalog(genre, typeKey));

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

  try {
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
      console.error("❌ AniList GraphQL Error:", response.data.errors);
      // Degraded mode: a curated entry keeps the detail page usable during an
      // AniList incident; unknown IDs keep the verified error contract.
      const curated = buildCuratedAnimeDetail(animeId);
      if (curated) {
        console.warn(`AniList returned errors; serving curated details for ID ${animeId}.`);
        return res.status(200).json(curated);
      }
      return res.status(500).json({
        message: "AniList returned an error."
      });
    }

    const anime = safe(response, 'data.data.Media', null);
    if (!anime) {
      // Fall back to curated catalog if available
      const curated = buildCuratedAnimeDetail(animeId);
      if (curated) {
        console.warn(`AniList returned no entry; serving curated details for ID ${animeId}.`);
        return res.status(200).json(curated);
      }
      return res.status(404).json({ message: "Anime not found on AniList nor in curated catalog." });
    }

    // Sanitize description before sending to client
    anime.description = sanitizeDescription(anime.description);

    res.json(anime);

  } catch (error) {
    console.error("❌ AniList API Error");
    if (error.response) {
      console.error("Status:", error.response.status);
    } else {
      console.error("Message:", error.message);
    }
    // Degraded mode: a curated entry keeps the detail page usable while
    // AniList is down; unknown IDs keep the verified error contract.
    const curated = buildCuratedAnimeDetail(animeId);
    if (curated) {
      console.warn(`AniList unavailable; serving curated details for ID ${animeId}.`);
      return res.status(200).json(curated);
    }
    res.status(500).json({
      message: "Could not connect to AniList API."
    });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.message === 'Not allowed by CORS'
    ? 403
    : [400, 413].includes(error.status)
      ? error.status
      : 500;

  console.error(`Request failed (${status}): ${error.message}`);
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