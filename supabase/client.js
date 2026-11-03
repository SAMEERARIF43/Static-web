// Supabase server-side client for admin operations.
// Uses the service-role key, which must never be exposed to frontend code.
const { createClient } = require('@supabase/supabase-js');

let supabaseClient = null;
let initError = null;

function initializeClient() {
  if (supabaseClient !== null || initError !== null) {
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    initError = new Error(
      'Supabase server-side client not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'
    );
    return;
  }

  try {
    // Server-side only: there is no browser session to persist or restore, and
    // `persistSession` is the only auth option this client needs.
    supabaseClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
      },
    });
  } catch (err) {
    initError = err;
  }
}

function getSupabase() {
  initializeClient();
  if (initError) {
    throw initError;
  }
  if (!supabaseClient) {
    throw new Error('Supabase client failed to initialize.');
  }
  return supabaseClient;
}

function isConfigured() {
  initializeClient();
  return supabaseClient !== null && initError === null;
}

module.exports = {
  getSupabase,
  isConfigured,
  get supabase() {
    return getSupabase();
  },
};
