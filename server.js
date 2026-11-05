// ============================================================
// ANIME HUB SERVER — Modular Entry Point
// ============================================================
// Optionally load an external env file (e.g. to keep secrets outside a
// synced folder) via ANIME_HUB_ENV_FILE, followed by the local .env file.
// Real process env vars retain precedence over file values.
if (process.env.ANIME_HUB_ENV_FILE) {
  require('dotenv').config({ path: process.env.ANIME_HUB_ENV_FILE });
}
require('dotenv').config();

// Core dependencies
const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY || typeof ADMIN_KEY !== 'string' || ADMIN_KEY.trim().length === 0) {
  throw new Error('FATAL: ADMIN_KEY environment variable is required.');
}

// Import modular middleware
const { securityHeaders, corsMiddleware } = require('./middleware/security');
const {
  globalApiLimiter,
  proxyLimiter,
  accountDeletionLimiter,
  streamLimiter,
  adminLimiter,
  rateLimiters
} = require('./middleware/rate-limiter');
const { errorHandler } = require('./middleware/error-handler');
const { resolveAnilistGraphqlUrl } = require('./anilist-endpoint');

// Import modular route routers
const searchRoutes = require('./routes/search');
const browseRoutes = require('./routes/browse');
const mangaRoutes = require('./routes/manga');
const seriesRoutes = require('./routes/series');
const catalogRoutes = require('./routes/catalog');
const animeRoutes = require('./routes/anime');
const adminRoutes = require('./routes/admin');
const proxyRoutes = require('./routes/proxy');
const recommendationsRoutes = require('./routes/recommendations');

// App initialization
const app = express();
const PORT = process.env.PORT && Number(process.env.PORT) || 3000;
const configuredSiteUrl = new URL(process.env.SITE_URL || `http://localhost:${PORT}`);
if (
  !['http:', 'https:'].includes(configuredSiteUrl.protocol) ||
  configuredSiteUrl.origin === 'null' ||
  configuredSiteUrl.username || configuredSiteUrl.password
) {
  throw new Error('SITE_URL must be an HTTP or HTTPS site origin.');
}
const SITE_URL = configuredSiteUrl.origin;

// Fail fast on a malformed ANILIST_GRAPHQL_URL. Every catalog router resolves
// the upstream through ./anilist-endpoint, so none of them can bypass this.
resolveAnilistGraphqlUrl(process.env.ANILIST_GRAPHQL_URL);
const _SUGGESTION_CACHE_TTL_MS = 60 * 1000;
const _SUGGESTION_CACHE_LIMIT = 100;
const _suggestionCache = new Map();
const _pendingSuggestionRequests = new Map();

// ============================================================
// MIDDLEWARE
// ============================================================

// Security headers — set before every other middleware so that error
// responses carry them too
app.use(securityHeaders);

// CORS — restricted to allowed origins
const isDev = process.env.NODE_ENV !== 'production';
const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : isDev ? true : [`http://localhost:${PORT}`];
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
}
app.use(corsMiddleware(ALLOWED_ORIGINS));
app.use(express.json({ limit: '16kb' }));

if (process.env.NODE_ENV === 'test') {
  app.post('/__test/reset-rate-limits', (req, res) => {
    if (req.get('X-Test-Rate-Limit-Reset') !== '1') return res.sendStatus(404);
    for (const limiter of rateLimiters) {
      if (typeof limiter.resetKey === 'function') limiter.resetKey(req.ip);
    }
    return res.status(204).end();
  });
}

// Rate limiting
app.use('/api', globalApiLimiter);
app.use('/api/search', proxyLimiter);
app.use('/api/browse', proxyLimiter);
app.use('/api/recommendations', recommendationsRoutes);
app.use('/api/anime/:id', proxyLimiter);
app.use(['/api/manga', '/api/manhwa', '/api/manhua'], proxyLimiter);
app.use('/api/account', accountDeletionLimiter);
app.use('/api/admin', adminLimiter);
app.use('/api/stream', streamLimiter);


// ============================================================
// ROUTES
// ============================================================

// Health check
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

// API routes — mounted on express routers
app.use('/api/search', searchRoutes);
app.use('/api', browseRoutes);
app.use('/api/manga', mangaRoutes);
app.use('/api/manhwa', mangaRoutes);
app.use('/api/manhua', mangaRoutes);
app.use('/api/series', seriesRoutes);
app.use('/api', catalogRoutes);
app.use('/api', animeRoutes);
// Per-user admin status check — uses the caller's own bearer token,
// not the shared admin key. Mounted before the data-bearing admin routes.
app.use('/api/admin/me', adminRoutes);
// Every data-bearing route in routes/admin applies requireAdmin itself, so the
// router is mounted without a second guard here. A mount-level copy would only
// repeat the same Auth verification and is_admin RPC for every request.
app.use('/api/admin', adminRoutes);
app.use('/api/stream', proxyRoutes);

// Static asset serving
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  res.type('html').send(indexHtml.replaceAll('__SITE_URL__', SITE_URL));
});

app.get('/api/site-config', (_req, res) => res.json({ siteUrl: SITE_URL }));

app.get('/api/config', (_req, res) => {
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
    // Authentication failures belong to the caller; every other failure —
    // including timeouts — is reported without leaking upstream details.
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
    // The session was already verified: any Admin API failure is a server-side
    // problem and must not disclose the upstream response.
    console.error(`Supabase account deletion failed${error.response?.status ? ` (${error.response.status})` : ''}.`);
    return res.status(502).json({ message: 'Account deletion could not be completed. Please try again later.' });
  }
});
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

// Favicon and robots/sitemap
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(`User-agent: *\nDisallow: /admin/\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  res.set('Content-Type', 'application/xml');
  const pages = ['', 'privacy.html', 'terms.html', 'contact.html', 'dmca.html'];
  const urls = pages.map(page => `<url><loc>${SITE_URL}/${page}</loc></url>`).join('');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});

// API test route (development only)
if (process.env.NODE_ENV === 'test' && process.env.ANIME_HUB_TEST_ERROR_ROUTE === '1') {
  app.get('/api/test/error-middleware', () => {
    throw new Error('Test error for middleware verification');
  });
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ message: 'Not found.' });
  return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ============================================================
// ERROR HANDLING
// ============================================================

// General error handler — must be placed after all other middleware
app.use(errorHandler);

// ============================================================
// SERVER LISTENER
// ============================================================

const server = app.listen(PORT, () => {
  console.log(`Anime Hub API listening on ${SITE_URL}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = { app, server };

// Graceful shutdown support
if (require.main === module) {
  process.on('SIGTERM', () => {
    console.log('SIGTERM received → shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
    });
  });
  process.on('SIGINT', () => {
    console.log('SIGINT received → shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
    });
  });
}
