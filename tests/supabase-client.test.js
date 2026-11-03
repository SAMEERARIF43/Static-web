// Unit tests for supabase/client.js - tests module initialization
// without spawning a server process.

const path = require('path');

// Test 1: Module loads without crashing when env vars are missing
describe('supabase/client.js initialization', () => {
  it('module exports getSupabase and isConfigured functions', () => {
    // Clear require cache to get fresh module state
    delete require.cache[require.resolve('../supabase/client.js')];
    
    // Temporarily remove env vars to test unconfigured state
    const origUrl = process.env.SUPABASE_URL;
    const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    try {
      const client = require('../supabase/client.js');
      expect(typeof client.getSupabase).toBe('function');
      expect(typeof client.isConfigured).toBe('function');
      expect(client.isConfigured()).toBe(false);
    } finally {
      // Restore env vars
      if (origUrl) process.env.SUPABASE_URL = origUrl;
      else delete process.env.SUPABASE_URL;
      if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
      else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      
      // Clear cache again for other tests
      delete require.cache[require.resolve('../supabase/client.js')];
    }
  });

  it('getSupabase throws when not configured', () => {
    delete require.cache[require.resolve('../supabase/client.js')];
    
    const origUrl = process.env.SUPABASE_URL;
    const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    try {
      const client = require('../supabase/client.js');
      expect(() => client.getSupabase()).toThrow();
    } finally {
      if (origUrl) process.env.SUPABASE_URL = origUrl;
      else delete process.env.SUPABASE_URL;
      if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
      else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      
      delete require.cache[require.resolve('../supabase/client.js')];
    }
  });

  it('isConfigured returns false when env vars missing', () => {
    delete require.cache[require.resolve('../supabase/client.js')];
    
    const origUrl = process.env.SUPABASE_URL;
    const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    try {
      const client = require('../supabase/client.js');
      expect(client.isConfigured()).toBe(false);
    } finally {
      if (origUrl) process.env.SUPABASE_URL = origUrl;
      else delete process.env.SUPABASE_URL;
      if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey;
      else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      
      delete require.cache[require.resolve('../supabase/client.js')];
    }
  });
});
