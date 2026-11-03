// Backend authorization tests for routes/admin.js middleware and
// supabase/client.js. Uses the genuine supabase client module.
// Tests the requireAdminKey middleware directly with mock req/res objects
// instead of spawning a child process.

// Set Supabase env vars in the Jest process so that
// supabase/client.js can initialize without throwing.
process.env.SUPABASE_URL = 'http://127.0.0.1:54321'
process.env.SUPABASE_ANON_KEY = 'test-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'

const http = require('http')

jest.mock('axios', () => {
  const actualAxios = jest.requireActual('axios')
  return {
    ...actualAxios,
    get: jest.fn(),
  }
})

const axios = require('axios')

// Reset axios mock between tests
beforeEach(() => {
  jest.clearAllMocks()
})

// Helper: create mock req/res objects
function createMockReq(headers = {}) {
  return {
    get: (name) => headers[name] || headers[name.toLowerCase()] || undefined,
  }
}

function createMockRes() {
  let statusCode = 200
  let body = null
  const res = {
    status: (code) => {
      statusCode = code
      return res
    },
    json: (data) => {
      body = data
      return res
    },
    getStatusCode: () => statusCode,
    getBody: () => body,
  }
  return res
}

describe('Admin authorization (routes/admin.js)', () => {
  describe('requireAdminKey middleware', () => {
    let requireAdminKey

    beforeEach(() => {
      // Clear require cache to get fresh module state
      delete require.cache[require.resolve('../middleware/security.js')]
      process.env.ADMIN_KEY = 'test-admin-key-12345'
      const securityModule = require('../middleware/security.js')
      requireAdminKey = securityModule.requireAdminKey
    })

    afterEach(() => {
      delete require.cache[require.resolve('../middleware/security.js')]
      delete process.env.ADMIN_KEY
    })

    it('allows request with valid admin key', () => {
      const req = createMockReq({ 'X-Admin-Key': 'test-admin-key-12345' })
      const res = createMockRes()
      const next = jest.fn()

      requireAdminKey(req, res, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(res.getStatusCode()).toBe(200)
    })

    it('rejects request with missing admin key', () => {
      const req = createMockReq({})
      const res = createMockRes()
      const next = jest.fn()

      requireAdminKey(req, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.getStatusCode()).toBe(401)
      expect(res.getBody().message).toBe('Admin key required.')
    })

    it('rejects request with invalid admin key', () => {
      const req = createMockReq({ 'X-Admin-Key': 'wrong-key' })
      const res = createMockRes()
      const next = jest.fn()

      requireAdminKey(req, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.getStatusCode()).toBe(401)
      expect(res.getBody().message).toBe('Admin key required.')
    })

    it('returns 500 when ADMIN_KEY is not configured', () => {
      // Fresh module without ADMIN_KEY
      delete require.cache[require.resolve('../middleware/security.js')]
      delete process.env.ADMIN_KEY

      const securityModule = require('../middleware/security.js')
      const reqAdminKey = securityModule.requireAdminKey

      const req = createMockReq({ 'X-Admin-Key': 'anything' })
      const res = createMockRes()
      const next = jest.fn()

      reqAdminKey(req, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.getStatusCode()).toBe(500)
      expect(res.getBody().message).toBe('Server is not configured for admin access.')

      // Restore
      process.env.ADMIN_KEY = 'test-admin-key-12345'
      delete require.cache[require.resolve('../middleware/security.js')]
    })
  })

  describe('Supabase client initialization', () => {
    it('module exports getSupabase and isConfigured functions', () => {
      delete require.cache[require.resolve('../supabase/client.js')]

      const origUrl = process.env.SUPABASE_URL
      const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_ROLE_KEY

      try {
        const client = require('../supabase/client.js')
        expect(typeof client.getSupabase).toBe('function')
        expect(typeof client.isConfigured).toBe('function')
        expect(client.isConfigured()).toBe(false)
      } finally {
        if (origUrl) process.env.SUPABASE_URL = origUrl
        else delete process.env.SUPABASE_URL
        if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey
        else delete process.env.SUPABASE_SERVICE_ROLE_KEY
        delete require.cache[require.resolve('../supabase/client.js')]
      }
    })

    it('getSupabase throws when not configured', () => {
      delete require.cache[require.resolve('../supabase/client.js')]

      const origUrl = process.env.SUPABASE_URL
      const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_ROLE_KEY

      try {
        const client = require('../supabase/client.js')
        expect(() => client.getSupabase()).toThrow()
      } finally {
        if (origUrl) process.env.SUPABASE_URL = origUrl
        else delete process.env.SUPABASE_URL
        if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey
        else delete process.env.SUPABASE_SERVICE_ROLE_KEY
        delete require.cache[require.resolve('../supabase/client.js')]
      }
    })

    it('isConfigured returns false when env vars missing', () => {
      delete require.cache[require.resolve('../supabase/client.js')]

      const origUrl = process.env.SUPABASE_URL
      const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      delete process.env.SUPABASE_URL
      delete process.env.SUPABASE_SERVICE_ROLE_KEY

      try {
        const client = require('../supabase/client.js')
        expect(client.isConfigured()).toBe(false)
      } finally {
        if (origUrl) process.env.SUPABASE_URL = origUrl
        else delete process.env.SUPABASE_URL
        if (origKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey
        else delete process.env.SUPABASE_SERVICE_ROLE_KEY
        delete require.cache[require.resolve('../supabase/client.js')]
      }
    })
  })

  describe('Axios mock verification', () => {
    it('axios.get is mocked', () => {
      expect(typeof axios.get).toBe('function')
      expect(axios.get).toBeDefined()
    })
  })
})
