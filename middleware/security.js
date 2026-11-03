// Security headers & CORS — used by server.js
// Security headers are set before every other middleware so that error
// responses - CORS rejections, 404s, 429 rate-limit replies - carry them too.
// CSP connect sources are configured in server.js based on SUPABASE_URL.
const crypto = require('node:crypto');
const axios = require('axios');
const { getSupabase } = require('../supabase/client');

function configuredSupabaseOrigin() {
  try {
    const parsed = new URL(process.env.SUPABASE_URL || '');
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.origin;
  } catch {
    // The server's environment validation owns configuration errors.
  }
  return '';
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // The frontend ships no inline scripts (see public/script.js) and uses
  // inline <style> attributes plus Google Fonts, so script-src can stay
  // strict while style-src stays compatible with the current markup.
  const connectSources = ["'self'", configuredSupabaseOrigin()].filter(Boolean).join(' ');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' https://s4.anilist.co https://placehold.co",
    `connect-src ${connectSources}`,
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
}

// CORS middleware — restricted to allowed origins
function corsMiddleware(allowedOrigins = []) {
  const origins = new Set(Array.isArray(allowedOrigins)
    ? allowedOrigins
    : typeof allowedOrigins === 'string' ? [allowedOrigins] : []);
  const allowAll = allowedOrigins === true || origins.has('*');
  return function cors(req, res, next) {
    const origin = req.get('origin');
    // Responses depend on Origin; do not share reflected headers across origins.
    res.vary('Origin');
    // Allow requests with no origin (same-origin, Postman, server-side)
    if (!origin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
      return next();
    }
    if (allowAll || origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
      return next();
    }
    return res.status(403).json({ message: 'Not allowed by CORS.' });
  };
}

function requireAdminKey(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) {
    return res.status(500).json({ message: 'Server is not configured for admin access.' });
  }
  const provided = req.get('X-Admin-Key');
  if (!provided || provided !== key) {
    return res.status(401).json({ message: 'Admin key required.' });
  }
  next();
}

// Verifies a Supabase Bearer token and checks administrator authorization
// using the server-side is_admin function. Rejects unauthenticated and
// non-admin callers. Never trusts frontend roles or user-supplied admin flags.
async function requireAdmin(req, res, next) {
  // The shared admin key stays a supported operator credential, checked in
  // constant time. Bearer-token authorization below is the primary path for
  // signed-in administrators; a present-but-wrong key never falls through.
  const configuredKey = process.env.ADMIN_KEY;
  const providedKey = req.get('X-Admin-Key');
  if (providedKey) {
    if (!configuredKey) {
      return res.status(500).json({ message: 'Server is not configured for admin access.' });
    }
    const provided = Buffer.from(providedKey);
    const expected = Buffer.from(configuredKey);
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
      return next();
    }
    return res.status(401).json({ message: 'Admin key required.' });
  }

  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return res.status(401).json({ message: 'Admin authentication required.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return res.status(503).json({ message: 'Server is not configured for admin access.' });
  }

  let baseUrl;
  try {
    baseUrl = new URL(supabaseUrl).origin;
  } catch {
    return res.status(503).json({ message: 'Invalid Supabase configuration.' });
  }

  let userId;
  try {
    const verification = await axios.get(`${baseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${match[1]}`,
      },
      timeout: 10000,
    });
    userId = verification.data?.id;
  } catch (error) {
    if ([401, 403].includes(error.response?.status)) {
      return res.status(401).json({ message: 'Invalid or expired admin token.' });
    }
    return res.status(502).json({ message: 'Could not verify admin session.' });
  }

  if (!userId || typeof userId !== 'string') {
    return res.status(502).json({ message: 'Could not verify user identity.' });
  }

  try {
    const { data, error: rpcError } = await getSupabase().rpc('is_admin', {
      user_id: userId,
    });

    if (rpcError) {
      console.error('Admin authorization RPC error:', rpcError);
      return res.status(500).json({ message: 'Admin authorization check failed.' });
    }

    // public.is_admin() is declared RETURNS BOOLEAN, so PostgREST answers with
    // a bare JSON scalar and the SDK's `data` *is* the function result — there
    // is no { is_admin } envelope to unwrap. Only a literal `true` grants
    // access; false, null, a malformed object, or an SDK error all fail closed.
    if (data !== true) {
      return res.status(403).json({ message: 'Administrator authorization required.' });
    }

    // Downstream handlers may attribute audit fields to this verified actor.
    // Requests authorized by the shared key carry no user identity.
    req.adminUserId = userId;
    next();
  } catch (err) {
    console.error('Admin authorization error:', err);
    return res.status(500).json({ message: 'Admin authorization check failed.' });
  }
}

module.exports = {
  securityHeaders,
  corsMiddleware,
  requireAdminKey,
  requireAdmin
};
