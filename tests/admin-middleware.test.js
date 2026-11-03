// Unit tests for middleware/security.js - tests requireAdminKey function
// without spawning a server process.

const http = require('http');

// Test requireAdminKey middleware function directly
describe('requireAdminKey middleware', () => {
  let requireAdminKey;

  beforeEach(() => {
    // Clear require cache to get fresh module state
    delete require.cache[require.resolve('../middleware/security.js')];
    
    // Set ADMIN_KEY for testing
    process.env.ADMIN_KEY = 'test-admin-key-12345';
    
    const securityModule = require('../middleware/security.js');
    requireAdminKey = securityModule.requireAdminKey;
  });

  afterEach(() => {
    delete require.cache[require.resolve('../middleware/security.js')];
    delete process.env.ADMIN_KEY;
  });

  function createMockReq(headers = {}) {
    return {
      get: (name) => headers[name] || headers[name.toLowerCase()] || undefined,
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

  it('allows request with valid admin key', () => {
    const req = createMockReq({ 'X-Admin-Key': 'test-admin-key-12345' });
    const res = createMockRes();
    const next = jest.fn();

    requireAdminKey(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.getStatusCode()).toBe(200);
  });

  it('rejects request with missing admin key', () => {
    const req = createMockReq({});
    const res = createMockRes();
    const next = jest.fn();

    requireAdminKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(401);
    expect(res.getBody().message).toBe('Admin key required.');
  });

  it('rejects request with invalid admin key', () => {
    const req = createMockReq({ 'X-Admin-Key': 'wrong-key' });
    const res = createMockRes();
    const next = jest.fn();

    requireAdminKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(401);
    expect(res.getBody().message).toBe('Admin key required.');
  });

  it('returns 500 when ADMIN_KEY is not configured', () => {
    // Need fresh module without ADMIN_KEY
    delete require.cache[require.resolve('../middleware/security.js')];
    delete process.env.ADMIN_KEY;
    
    const securityModule = require('../middleware/security.js');
    const reqAdminKey = securityModule.requireAdminKey;
    
    const req = createMockReq({ 'X-Admin-Key': 'anything' });
    const res = createMockRes();
    const next = jest.fn();

    reqAdminKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.getStatusCode()).toBe(500);
    expect(res.getBody().message).toBe('Server is not configured for admin access.');
    
    // Restore
    process.env.ADMIN_KEY = 'test-admin-key-12345';
    delete require.cache[require.resolve('../middleware/security.js')];
  });
});
