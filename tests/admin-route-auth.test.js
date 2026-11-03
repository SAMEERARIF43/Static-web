// Route-level authorization tests for routes/admin.js.
// Uses the genuine Express router mounted on a real Express app.
// Mocks axios for Supabase Auth verification and global.fetch for
// the Supabase SDK RPC HTTP calls. Does NOT contact a live Supabase project.

jest.mock('axios', () => {
  const actualAxios = jest.requireActual('axios')
  return {
    ...actualAxios,
    get: jest.fn(),
  }
})

const axios = require('axios')
const express = require('express')

// Mock global.fetch to intercept the SDK's RPC HTTP requests
const fetchMock = jest.fn()
global.fetch = fetchMock

function createTestApp() {
  const app = express()
  app.use(express.json())
  // Mount the real router exactly as server.js does.
  // /api/admin/me is mounted without requireAdminKey (bearer-only).
  // /api/admin/* is mounted with requireAdminKey (admin key).
  app.use('/api/admin/me', require('../routes/admin'))
  app.use('/api/admin', requireAdminKeyMiddleware(), require('../routes/admin'))
  return app
}

function requireAdminKeyMiddleware() {
  return (req, res, next) => {
    const key = process.env.ADMIN_KEY
    if (!key) {
      return res.status(500).json({ message: 'Server is not configured for admin access.' })
    }
    const provided = req.get('X-Admin-Key')
    if (!provided || provided !== key) {
      return res.status(401).json({ message: 'Admin key required.' })
    }
    next()
  }
}

function makeRequest(app, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0)
    const port = server.address().port
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }
    if (body) {
      reqOptions.headers['Content-Type'] = 'application/json'
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body)
    }
    const req = http.request(reqOptions, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        server.close()
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data })
      })
    })
    req.on('error', (err) => {
      server.close()
      reject(err)
    })
    req.setTimeout(5000, () => {
      req.destroy()
      server.close()
      reject(new Error('Request timed out'))
    })
    if (body) req.write(body)
    req.end()
  })
}

const http = require('http')

describe('Admin route authorization — /api/admin/me (bearer token)', () => {
  let app

  beforeEach(() => {
    // resetAllMocks clears mock implementations including mockResolvedValueOnce queues
    jest.resetAllMocks()
    fetchMock.mockReset()

    process.env.SUPABASE_URL = 'http://127.0.0.1:54321'
    process.env.SUPABASE_ANON_KEY = 'test-anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'

    app = createTestApp()
  })

  it('rejects missing bearer token → 401', async () => {
    const res = await makeRequest(app, 'GET', '/api/admin/me', {})
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('no_token')
  })

  it('rejects malformed authorization header → 401', async () => {
    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'InvalidToken',
    })
    expect(res.statusCode).toBe(401)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('no_token')
  })

  it('rejects invalid bearer token → 401', async () => {
    axios.get.mockRejectedValueOnce({
      response: { status: 401 },
    })

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer invalid-token',
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects when Supabase Auth verification fails (non-401 error) → 502', async () => {
    axios.get.mockRejectedValueOnce(new Error('network down'))

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer some-token',
    })
    expect(res.statusCode).toBe(502)
  })

  it('returns isAdmin: false when RPC returns false', async () => {
    axios.get.mockResolvedValueOnce({
      data: { id: 'user-123' },
    })
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(false),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer valid-token',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.isAdmin).toBe(false)
  })

  it('returns isAdmin: true when RPC returns true', async () => {
    axios.get.mockResolvedValueOnce({
      data: { id: 'admin-123' },
    })
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(true),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer valid-token',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.isAdmin).toBe(true)
  })

  it('denies access when RPC errors → 500', async () => {
    axios.get.mockResolvedValueOnce({
      data: { id: 'user-123' },
    })
    fetchMock.mockRejectedValueOnce(new Error('RPC failure'))

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer valid-token',
    })
    expect(res.statusCode).toBe(500)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('Admin authorization check failed.')
  })

  it('denies access when RPC returns malformed response → 500', async () => {
    axios.get.mockResolvedValueOnce({
      data: { id: 'user-123' },
    })
    fetchMock.mockResolvedValueOnce(
      new Response('invalid json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer valid-token',
    })
    expect(res.statusCode).toBe(500)
  })

  it('returns isAdmin: false when RPC data is null', async () => {
    // public.is_admin() is RETURNS BOOLEAN, so PostgREST answers with a bare
    // JSON scalar: a null body arrives as `data === null`, which is not an
    // administrator.
    axios.get.mockResolvedValueOnce({
      data: { id: 'user-123' },
    })
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(null),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer valid-token',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.isAdmin).toBe(false)
  })

  it('returns isAdmin: false when the RPC payload is not a boolean', async () => {
    axios.get.mockResolvedValueOnce({
      data: { id: 'user-123' },
    })
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ is_admin: true }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer valid-token',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.isAdmin).toBe(false)
  })

  it('denies access when PostgREST returns an error status', async () => {
    axios.get.mockResolvedValueOnce({
      data: { id: 'user-123' },
    })
    // A failing RPC is a non-2xx PostgREST response, which the SDK surfaces as
    // `{ data: null, error }`. That must be denied, never trusted.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.is_admin' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer valid-token',
    })
    expect(res.statusCode).toBe(500)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('Admin authorization check failed.')
  })

  it('returns 503 when Supabase is not configured', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_ANON_KEY

    const res = await makeRequest(app, 'GET', '/api/admin/me', {
      authorization: 'Bearer valid-token',
    })
    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('not_configured')
  })
})

describe('Admin route authorization — /api/admin/* (X-Admin-Key)', () => {
  let app

  beforeEach(() => {
    jest.resetAllMocks()
    fetchMock.mockReset()

    process.env.ADMIN_KEY = 'test-admin-key-12345'
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321'
    process.env.SUPABASE_ANON_KEY = 'test-anon-key'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'

    app = createTestApp()
  })

  it('rejects missing X-Admin-Key → 401', async () => {
    const res = await makeRequest(app, 'GET', '/api/admin/reports', {})
    expect(res.statusCode).toBe(401)
  })

  it('rejects invalid X-Admin-Key → 401', async () => {
    const res = await makeRequest(app, 'GET', '/api/admin/reports', {
      'X-Admin-Key': 'wrong-key',
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects missing X-Admin-Key on POST → 401', async () => {
    const res = await makeRequest(app, 'POST', '/api/admin/dmca/some-id', {}, '{}')
    expect(res.statusCode).toBe(401)
  })

  it('rejects invalid X-Admin-Key on PUT → 401', async () => {
    const res = await makeRequest(
      app,
      'PUT',
      '/api/admin/content-reports/some-id',
      { 'X-Admin-Key': 'wrong-key' },
      '{}'
    )
    expect(res.statusCode).toBe(401)
  })

  it('valid X-Admin-Key reaches handler → 200', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify([]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const res = await makeRequest(
      app,
      'GET',
      '/api/admin/reports',
      { 'X-Admin-Key': 'test-admin-key-12345' }
    )
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.reports).toEqual([])
  })

  it('valid X-Admin-Key on POST updates the report named in the path → 200', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: 'some-id', status: 'resolved' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )

    const res = await makeRequest(
      app,
      'POST',
      '/api/admin/reports/some-id',
      { 'X-Admin-Key': 'test-admin-key-12345' },
      JSON.stringify({ status: 'resolved', adminNotes: 'test' })
    )
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.acknowledged).toBe(true)
    expect(body.message).toBe('Admin report updated successfully')
  })

  it('valid X-Admin-Key on POST without a status → 400', async () => {
    const res = await makeRequest(
      app,
      'POST',
      '/api/admin/reports/some-id',
      { 'X-Admin-Key': 'test-admin-key-12345' },
      JSON.stringify({ adminNotes: 'no status supplied' })
    )
    expect(res.statusCode).toBe(400)
  })

  it('unauthorized requests do not execute protected handlers', async () => {
    // If the handler were reached, axios would be called for Supabase queries.
    // With no admin key, the request is rejected before any handler logic runs.
    const res = await makeRequest(app, 'GET', '/api/admin/stats', {})
    expect(res.statusCode).toBe(401)
    // Verify no Supabase RPC or query was attempted (fetchMock should not be called)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 500 when ADMIN_KEY is not configured', async () => {
    delete process.env.ADMIN_KEY

    const res = await makeRequest(app, 'GET', '/api/admin/reports', {
      'X-Admin-Key': 'anything',
    })
    expect(res.statusCode).toBe(500)
  })
})
