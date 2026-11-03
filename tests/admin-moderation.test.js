/* eslint-env jest */
// Regression tests for the admin moderation write paths.
//
// Covers two defects that the previous handler shape hid:
//  1. POST /api/admin/reports/:id used to INSERT a new pending report instead of
//     updating the report named in the path, so moderation created data.
//  2. resolved_by was copied from the request body, letting any holder of the
//     shared admin key attribute a resolution to an arbitrary user id.
//
// Mounts the genuine router and intercepts the Supabase SDK's HTTP calls at the
// fetch() boundary. Does NOT contact a live Supabase project.

jest.mock('axios', () => {
  const actualAxios = jest.requireActual('axios');
  return { ...actualAxios, get: jest.fn() };
});

const express = require('express');
const http = require('http');

const fetchMock = jest.fn();
global.fetch = fetchMock;

const ADMIN_KEY = 'test-admin-key-12345';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', require('../routes/admin'));
  return app;
}

function makeRequest(app, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    const port = server.address().port;
    const payload = body === null ? null : JSON.stringify(body);
    const headers = { 'X-Admin-Key': ADMIN_KEY };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        server.close();
        resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : null });
      });
    });
    req.on('error', (err) => {
      server.close();
      reject(err);
    });
    req.setTimeout(5000, () => {
      req.destroy();
      server.close();
      reject(new Error('Request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function okRow(row) {
  return new Response(JSON.stringify(row), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function lastSupabaseCall() {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  const [url, options = {}] = call;
  return {
    url: String(url),
    method: options.method,
    body: options.body ? JSON.parse(options.body) : null,
  };
}

describe('Admin moderation writes', () => {
  let app;

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    app = createTestApp();
  });

  it('POST /api/admin/reports/:id updates the addressed report instead of inserting one', async () => {
    fetchMock.mockResolvedValueOnce(okRow({ id: 'report-1', status: 'resolved' }));

    const res = await makeRequest(app, 'POST', '/api/admin/reports/report-1', {
      status: 'resolved',
      adminNotes: 'handled',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.acknowledged).toBe(true);
    expect(res.body.message).toBe('Admin report updated successfully');

    const call = lastSupabaseCall();
    expect(call.method).toBe('PATCH');
    expect(call.url).toContain('/rest/v1/dmca_reports');
    expect(call.url).toContain('id=eq.report-1');
    // Nothing about the write may look like a fresh row.
    expect(call.url).not.toContain('reporter_id');
    expect(call.body).toEqual({ status: 'resolved', admin_notes: 'handled' });
  });

  it('POST /api/admin/reports/:id rejects a request without a status', async () => {
    const res = await makeRequest(app, 'POST', '/api/admin/reports/report-1', {
      adminNotes: 'no status',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('A report status is required.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/admin/dmca/:id ignores a client-supplied resolvedBy', async () => {
    fetchMock.mockResolvedValueOnce(okRow({ id: 'dmca-1', status: 'resolved' }));

    const res = await makeRequest(app, 'POST', '/api/admin/dmca/dmca-1', {
      status: 'resolved',
      resolvedBy: '00000000-0000-4000-8000-000000000000',
      resolvedAt: '2026-11-01T00:00:00Z',
    });

    expect(res.statusCode).toBe(200);

    const call = lastSupabaseCall();
    expect(call.method).toBe('PATCH');
    expect(call.url).toContain('id=eq.dmca-1');
    expect(call.body.status).toBe('resolved');
    expect(call.body.resolved_at).toBe('2026-11-01T00:00:00Z');
    // The audit trail must not be settable by the caller.
    expect(call.body).not.toHaveProperty('resolved_by');
  });

  it('POST /api/admin/dmca/:id rejects a request without a status', async () => {
    const res = await makeRequest(app, 'POST', '/api/admin/dmca/dmca-1', {
      resolvedBy: '00000000-0000-4000-8000-000000000000',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toBe('A DMCA status is required.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/admin/reports/:id surfaces a database failure as 500', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: '23503', message: 'insert or update violates foreign key' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const res = await makeRequest(app, 'POST', '/api/admin/reports/report-1', { status: 'resolved' });

    expect(res.statusCode).toBe(500);
    expect(res.body.message).toBe('Failed to update admin report. Please try again.');
  });
});
