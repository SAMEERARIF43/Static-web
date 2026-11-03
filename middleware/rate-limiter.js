// Rate limiting middleware — used by server.js
// Rate limits are scoped by upstream cost: the AniList proxy endpoints carry the
// highest quota risk (every request forwards to AniList's shared quota), the
// account-deletion endpoint is unauthenticated but expensive and destructive,
// and everything under /api gets a coarse global cap. Pages and static assets
// are not limited. In production, set TRUST_PROXY to the proxy hop count
// (e.g. TRUST_PROXY=1) so clients are counted by their real address instead
// of the proxy's.

const rateLimit = require('express-rate-limit');

// Environment-configurable limits
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const RATE_LIMIT_GLOBAL_MAX = 120;
const RATE_LIMIT_PROXY_MAX = 60;
const RATE_LIMIT_ACCOUNT_MAX = 5;
const STREAM_RATE_LIMIT_MAX = 30;
const ADMIN_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const ADMIN_RATE_LIMIT_MAX = 30;

// Detect test mode to skip rate limiting during automated tests
const AUTOMATED_TEST_MODE = process.env.NODE_ENV === 'test' && process.env.ANIME_HUB_TEST_MODE === '1';

// Global API rate limiter
const globalApiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_GLOBAL_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Skip unthrottled config endpoints
  skip: req => AUTOMATED_TEST_MODE || req.originalUrl.startsWith('/api/site-config') || req.originalUrl.startsWith('/api/config'),
  handler: (req, res) => {
    console.warn(`Rate limit exceeded (global /api) from ${req.ip}`);
    res.status(429).json({ message: 'Too many requests. Please slow down.' });
  }
});

// AniList proxy rate limiter
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

// Account deletion rate limiter (more conservative)
const accountDeletionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: RATE_LIMIT_ACCOUNT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Count unauthenticated deletion attempts too
  skip: () => AUTOMATED_TEST_MODE,
  handler: (req, res) => {
    console.warn(`Rate limit exceeded (account deletion) from ${req.ip}`);
    res.status(429).json({ message: 'Too many requests. Please try again later.' });
  }
});

// Stream rate limiter
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

// Admin moderation rate limiter
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

// Export all rate limiters as a configured array
module.exports = {
  globalApiLimiter,
  proxyLimiter,
  accountDeletionLimiter,
  streamLimiter,
  adminLimiter,
  rateLimiters: [globalApiLimiter, proxyLimiter, accountDeletionLimiter, streamLimiter, adminLimiter]
};