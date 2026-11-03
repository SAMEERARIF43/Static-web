// Backend tests for Bearer-token admin authorization.
// Tests requireAdmin middleware directly with mock req/res objects.
// Mocks axios for Supabase Auth verification and global.fetch for RPC HTTP.
// Does NOT contact a live Supabase project.

const axios = require('axios');

jest.mock('axios', () => {
  const actualAxios = jest.requireActual('axios');
  return {
    ...actualAxios,
    get: jest.fn(),
  };
});

// Mock global.fetch to intercept the SDK's RPC HTTP requests
const fetchMock = jest.fn();
global.fetch = fetchMock;

// Mock req/res helpers
function createMockReq(headers = {}) {
  const lowerHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    lowerHeaders[key.toLowerCase()] = value;
  }
  return {
    get: (name) => lowerHeaders[name.toLowerCase()] || undefined,
  };
}

function createMockRes() {
  let statusCode = 200;
  let body = null;
  const res = {
    status: (code) => {
      statusCode = code;
      return res;
    },
    json: (data) => {
      body = data;
      return res;
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  };
  return res;
}

function mockAuth(admin = true) {
  axios.get.mockResolvedValue({ data: { id: admin ? 'admin-user-id' : 'ordinary-user-id' } });
  // public.is_admin() is RETURNS BOOLEAN, so PostgREST's HTTP body is a bare
  // JSON scalar (never an { is_admin } envelope) and the SDK returns it as
  // `data`. The mock must reproduce that shape, not the shape the old
  // application code assumed.
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(admin), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

describe('requireAdmin middleware (Bearer-token admin authorization)', () => {
  let requireAdmin;

  beforeEach(() => {
    axios.get.mockReset();
    fetchMock.mockReset();

    // Clear require cache to get fresh module state
    delete require.cache[require.resolve('../middleware/security')];
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

    const securityModule = require('../middleware/security');
    requireAdmin = securityModule.requireAdmin;
  });

  afterEach(() => {
    delete require.cache[require.resolve('../middleware/security')];
  });

  describe('Valid Bearer token for administrator', () => {
    it('calls next() with valid admin token', async () => {
      mockAuth(true);

      const req = createMockReq({ Authorization: 'Bearer admin-token' });
      const res = createMockRes();
      const next = jest.fn();

      await requireAdmin(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.getStatusCode()).toBe(200);
    });

    it('does not require X-Admin-Key header', async () => {
      mockAuth(true);

      const req = createMockReq({ Authorization: 'Bearer admin-token' });
      // Intentionally no X-Admin-Key
      const res = createMockRes();
      const next = jest.fn();

      await requireAdmin(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('Invalid Bearer token', () => {
    it('returns 401 with invalid token', async () => {
      axios.get.mockRejectedValueOnce({ response: { status: 401 } });

      const req = createMockReq({ Authorization: 'Bearer invalid-token' });
      const res = createMockRes();
      const next = jest.fn();

      await requireAdmin(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.getStatusCode()).toBe(401);
      expect(res.getBody().message).toBe('Invalid or expired admin token.');
    });
  });

  describe('Missing Bearer token', () => {
    it('returns 401 with no Authorization header', async () => {
      const req = createMockReq({});
      const res = createMockRes();
      const next = jest.fn();

      await requireAdmin(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.getStatusCode()).toBe(401);
      expect(res.getBody().message).toBe('Admin authentication required.');
    });

    it('returns 401 with malformed header', async () => {
      const req = createMockReq({ Authorization: 'InvalidHeader no-bearer' });
      const res = createMockRes();
      const next = jest.fn();

      await requireAdmin(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.getStatusCode()).toBe(401);
    });
  });

  describe('Valid user token without administrator privileges', () => {
    it('returns 403 for ordinary user', async () => {
      mockAuth(false);

      const req = createMockReq({ Authorization: 'Bearer ordinary-user-token' });
      const res = createMockRes();
      const next = jest.fn();

      await requireAdmin(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.getStatusCode()).toBe(403);
      expect(res.getBody().message).toBe('Administrator authorization required.');
    });
  });

  describe('Missing Supabase configuration', () => {
    it('returns 503 when SUPABASE_URL is not set', async () => {
      mockAuth(true);

      delete process.env.SUPABASE_URL;

      const req = createMockReq({ Authorization: 'Bearer admin-token' });
      const res = createMockRes();
      const next = jest.fn();

      await requireAdmin(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.getStatusCode()).toBe(503);
    });
  });
});
