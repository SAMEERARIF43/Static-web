// Backend tests for content-reports admin endpoints (GET/PUT).
// Uses the genuine Express router and the genuine Supabase SDK client.
// Mocks axios for Supabase Auth verification and global.fetch for RPC HTTP.
// Does NOT contact a live Supabase project.

const http = require('http');
const express = require('express');

jest.mock('axios', () => {
  const actualAxios = jest.requireActual('axios');
  return {
    ...actualAxios,
    get: jest.fn(),
  };
});

const axios = require('axios');

// Mock global.fetch to intercept the SDK's RPC HTTP requests
const fetchMock = jest.fn();
global.fetch = fetchMock;

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../routes/admin'));
  return app;
}

function makeRequest(port, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    };
    if (body) {
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (body) req.write(body);
    req.end();
  });
}

describe('Admin content-reports endpoints', () => {
  let app;
  let server;
  let port;

  beforeEach(() => {
    // Reset all mocks between tests
    jest.resetAllMocks();
    fetchMock.mockReset();

    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.ADMIN_KEY = 'test-admin-key-12345';

    app = createTestApp();
    server = app.listen(0);
    port = server.address().port;
  });

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  describe('GET /api/admin/content-reports', () => {
    it('Missing Bearer token — returns 401', async () => {
      const res = await makeRequest(port, 'GET', '/api/admin/content-reports', {});
      expect(res.statusCode).toBe(401);
    });

    it('Invalid Bearer token — returns 401', async () => {
      axios.get.mockRejectedValueOnce({ response: { status: 401 } });

      const res = await makeRequest(
        port,
        'GET',
        '/api/admin/content-reports',
        { Authorization: 'Bearer invalid-token' }
      );
      expect(res.statusCode).toBe(401);
    });

    it('Ordinary user token — returns 403', async () => {
      axios.get.mockResolvedValueOnce({ data: { id: 'ordinary-user-id' } });
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify(false),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await makeRequest(
        port,
        'GET',
        '/api/admin/content-reports',
        { Authorization: 'Bearer ordinary-user-token' }
      );
      expect(res.statusCode).toBe(403);
    });

    it('Administrator Bearer token — returns 200 with empty reports array', async () => {
      axios.get.mockResolvedValueOnce({ data: { id: 'admin-user-id' } });
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify(true),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify([]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await makeRequest(
        port,
        'GET',
        '/api/admin/content-reports',
        { Authorization: 'Bearer admin-token' }
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.reports).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.message).toBe('Content reports retrieved successfully');
    });
  });

  describe('PUT /api/admin/content-reports/:id', () => {
    it('Missing Bearer token — returns 401', async () => {
      const res = await makeRequest(
        port,
        'PUT',
        '/api/admin/content-reports/some-uuid',
        {}
      );
      expect(res.statusCode).toBe(401);
    });

    it('Invalid Bearer token — returns 401', async () => {
      axios.get.mockRejectedValueOnce({ response: { status: 401 } });

      const res = await makeRequest(
        port,
        'PUT',
        '/api/admin/content-reports/some-uuid',
        { Authorization: 'Bearer invalid-token' },
        JSON.stringify({ status: 'resolved' })
      );
      expect(res.statusCode).toBe(401);
    });

    it('Ordinary user token — returns 403', async () => {
      axios.get.mockResolvedValueOnce({ data: { id: 'ordinary-user-id' } });
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify(false),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await makeRequest(
        port,
        'PUT',
        '/api/admin/content-reports/some-uuid',
        { Authorization: 'Bearer ordinary-user-token' },
        JSON.stringify({ status: 'resolved' })
      );
      expect(res.statusCode).toBe(403);
    });

    it('Administrator Bearer token — returns 200 on successful update', async () => {
      axios.get.mockResolvedValueOnce({ data: { id: 'admin-user-id' } });
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify(true),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'some-uuid', status: 'resolved' }],
            error: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await makeRequest(
        port,
        'PUT',
        '/api/admin/content-reports/some-uuid',
        { Authorization: 'Bearer admin-token' },
        JSON.stringify({
          status: 'resolved',
          adminNotes: 'Resolved by moderator',
          resolvedAt: '2026-10-31T00:00:00Z',
          // A caller must not be able to attribute moderation to someone else.
          resolvedBy: 'spoofed-admin-id',
        })
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.acknowledged).toBe(true);
      expect(body.message).toBe('Content report updated successfully');

      const updateCall = fetchMock.mock.calls[1];
      const patch = JSON.parse(updateCall[1].body);
      expect(patch.resolved_by).toBe('admin-user-id');
    });

    it('Database error — returns 500', async () => {
      axios.get.mockResolvedValueOnce({ data: { id: 'admin-user-id' } });
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify(true),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: null, error: { message: 'Database error' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const res = await makeRequest(
        port,
        'PUT',
        '/api/admin/content-reports/some-uuid',
        { Authorization: 'Bearer admin-token' },
        JSON.stringify({ status: 'resolved' })
      );
      expect(res.statusCode).toBe(500);
    });
  });
});
