// Admin routes — used by server.js
// Handles admin moderation endpoints requiring admin key authentication
// Now uses Supabase database queries for persistence across server restarts

const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabaseModule = require('../supabase/client'); // Import supabase client module

function getSupabase() {
  return supabaseModule.getSupabase();
}
const requireAdmin = require('../middleware/security').requireAdmin;

// Verify a bearer token with Supabase Auth and return the authenticated user id.
async function verifyBearerToken(authorization) {
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) return { error: 'no_token', status: 401 };

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return { error: 'not_configured', status: 503 };

  let baseUrl;
  try {
    baseUrl = new URL(supabaseUrl).origin;
  } catch {
    return { error: 'invalid_url', status: 503 };
  }

  try {
    const verification = await axios.get(`${baseUrl}/auth/v1/user`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${match[1]}`,
      },
      timeout: 10000,
    });
    return { user: verification.data, error: null };
  } catch (error) {
    if ([401, 403].includes(error.response?.status)) {
      return { error: 'invalid_token', status: 401 };
    }
    return { error: 'verification_failed', status: 502 };
  }
}

// Build the update payload for a moderation action from request input.
// `resolved_by` is deliberately never copied from the request body: the shared
// admin key carries no user identity and the service-role client bypasses RLS,
// so trusting a client-supplied UUID here would let any key holder forge the
// audit trail. The field is left untouched until an identity is available.
function buildModerationPatch(body) {
  const source = body && typeof body === 'object' ? body : {};
  const patch = {};
  if (typeof source.status === 'string' && source.status.trim()) {
    patch.status = source.status.trim();
  }
  if (typeof source.adminNotes === 'string') {
    patch.admin_notes = source.adminNotes;
  }
  if (typeof source.resolvedAt === 'string' && source.resolvedAt) {
    patch.resolved_at = source.resolvedAt;
  }
  return patch;
}

// Admin status check handler — shared by router.get('/') and router.get('/me').
// Mounted at /api/admin/me (Express strips the prefix, leaving empty path for
// GET /api/admin/me). Uses Bearer token authentication — no X-Admin-Key required.
async function handleAdminMe(req, res) {
  const authorization = req.get('authorization') || '';
  const { user, error, status } = await verifyBearerToken(authorization);
  if (error) {
    return res.status(status).json({ message: error });
  }

  const userId = user?.id;
  if (!userId || typeof userId !== 'string') {
    return res.status(502).json({ message: 'Could not verify user identity.' });
  }

  try {
    const { data, error: rpcError } = await getSupabase()
      .rpc('is_admin', { user_id: userId });

    if (rpcError) {
      console.error('Admin check RPC error:', rpcError);
      return res.status(500).json({ message: 'Admin authorization check failed.' });
    }

    // Same scalar contract as middleware/security.js: public.is_admin() is
    // RETURNS BOOLEAN, so the SDK's `data` is the result itself and only a
    // literal `true` reports an administrator.
    res.json({ isAdmin: data === true });
  } catch (err) {
    console.error('Admin check error:', err);
    res.status(500).json({ message: 'Admin authorization check failed.' });
  }
}

// Admin status check — Bearer token authentication (no X-Admin-Key required).
// Mounted at both GET /api/admin/me (empty remaining path matches router.get('/'))
// and GET /api/admin/me/me (matches router.get('/me')).
router.get('/', handleAdminMe);
router.get('/me', handleAdminMe);

// Admin reports GET endpoint — protected by shared admin key.
router.get('/reports', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('dmca_reports')
      .select('*')
      .order('reported_at', { ascending: false });

    if (error) {
      console.error('Admin reports DB error:', error);
      return res.status(500).json({ message: 'Failed to fetch admin reports. Please try again.' });
    }

    res.json({
      reports: data || [],
      total: (data || []).length,
      message: 'Admin reports retrieved successfully'
    });
  } catch (error) {
    console.error('Admin reports error:', error);
    res.status(500).json({ message: 'Failed to fetch admin reports. Please try again.' });
  }
});

// Admin reports POST endpoint — moderation update for the report named in the
// path. The shipped admin UI posts `{ status }` to /api/admin/reports/:id for
// the row it is acting on, so this route updates that row; it must never insert
// a new pending report as a side effect of a moderation action.
router.post('/reports/:id', requireAdmin, express.json({ limit: '16kb' }), async (req, res) => {
  const { id } = req.params;
  const patch = buildModerationPatch(req.body);
  if (!patch.status) {
    return res.status(400).json({ message: 'A report status is required.' });
  }

  try {
    const { data, error } = await getSupabase()
      .from('dmca_reports')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Admin report update DB error:', error);
      return res.status(500).json({ message: 'Failed to update admin report. Please try again.' });
    }

    res.status(200).json({
      id: data.id,
      acknowledged: true,
      message: 'Admin report updated successfully'
    });
  } catch (error) {
    console.error('Admin report update error:', error);
    res.status(500).json({ message: 'Failed to update admin report. Please try again.' });
  }
});

// Admin DMCA GET endpoint
router.get('/dmca', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('dmca_reports')
      .select('*')
      .order('reported_at', { ascending: false });

    if (error) {
      console.error('Admin DMCA DB error:', error);
      return res.status(500).json({ message: 'Failed to fetch DMCA info. Please try again.' });
    }

    res.json({
      requests: data || [],
      message: 'Admin DMCA retrieved successfully'
    });
  } catch (error) {
    console.error('Admin DMCA error:', error);
    res.status(500).json({ message: 'Failed to fetch DMCA info. Please try again.' });
  }
});

// Admin DMCA POST endpoint
router.post('/dmca/:id', requireAdmin, express.json({ limit: '16kb' }), async (req, res) => {
  const { id } = req.params;
  const patch = buildModerationPatch(req.body);
  if (!patch.status) {
    return res.status(400).json({ message: 'A DMCA status is required.' });
  }

  try {
    const { data, error } = await getSupabase()
      .from('dmca_reports')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Admin DMCA submission DB error:', error);
      return res.status(500).json({ message: 'Failed to submit DMCA takedown. Please try again.' });
    }

    res.status(200).json({
      id: data.id,
      acknowledged: true,
      message: 'Admin DMCA submission successful'
    });
  } catch (error) {
    console.error('Admin DMCA submission error:', error);
    res.status(500).json({ message: 'Failed to submit DMCA takedown. Please try again.' });
  }
});

// Admin content reports GET endpoint
router.get('/content-reports', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('content_reports')
      .select('*')
      .order('reported_at', { ascending: false });

    if (error) {
      console.error('Admin content reports DB error:', error);
      return res.status(500).json({ message: 'Failed to fetch content reports. Please try again.' });
    }

    res.json({
      reports: data || [],
      total: (data || []).length,
      message: 'Content reports retrieved successfully'
    });
  } catch (error) {
    console.error('Admin content reports error:', error);
    res.status(500).json({ message: 'Failed to fetch content reports. Please try again.' });
  }
});

// Admin content reports PUT (moderation) endpoint
router.put('/content-reports/:id', requireAdmin, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { id } = req.params;
    const reportData = req.body;

    // resolved_by is never taken from the request body: only the identity that
    // passed bearer authorization may be recorded, and key-only callers leave
    // the audit field untouched.
    const patch = {
      status: reportData.status,
      admin_notes: reportData.adminNotes,
      resolved_at: reportData.resolvedAt
    };
    if (req.adminUserId) {
      patch.resolved_by = req.adminUserId;
    }

    const { data, error } = await getSupabase()
      .from('content_reports')
      .update(patch)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Admin content report update DB error:', error);
      return res.status(500).json({ message: 'Failed to update content report. Please try again.' });
    }

    res.status(200).json({
      id: data.id,
      acknowledged: true,
      message: 'Content report updated successfully'
    });
  } catch (error) {
    console.error('Admin content report update error:', error);
    res.status(500).json({ message: 'Failed to update content report. Please try again.' });
  }
});

// Admin stats GET endpoint
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from('site_stats')
      .select('key_name, key_value');

    if (error) {
      console.error('Admin stats DB error:', error);
      return res.status(500).json({ message: 'Failed to fetch admin stats. Please try again.' });
    }

    // Transform into object
    const stats = {};
    (data || []).forEach(row => {
      stats[row.key_name] = row.key_value;
    });

    res.json({
      stats,
      message: 'Admin stats retrieved successfully'
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ message: 'Failed to fetch admin stats. Please try again.' });
  }
});

// Admin stats POST endpoint - upsert statistics
router.post('/stats', requireAdmin, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { keyName, keyValue, updatedBy } = req.body;

    const { data, error } = await getSupabase()
      .from('site_stats')
      .upsert({
        key_name: keyName,
        key_value: keyValue,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy
      }, { onConflict: 'key_name' })
      .select()
      .single();

    if (error) {
      console.error('Admin stats upsert DB error:', error);
      return res.status(500).json({ message: 'Failed to update admin stats. Please try again.' });
    }

    res.json({
      id: data.id,
      keyName: data.key_name,
      keyValue: data.key_value,
      message: 'Admin stats updated successfully'
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ message: 'Failed to update admin stats. Please try again.' });
  }
});

module.exports = router;