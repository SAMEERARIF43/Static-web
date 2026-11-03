// Supabase SDK RPC HTTP verification test.
// Uses the genuine @supabase/supabase-js client and intercepts HTTP at the
// fetch() boundary. Does NOT contact a live Supabase project.
//
// public.is_admin(user_id UUID) is declared `RETURNS BOOLEAN`, so PostgREST
// answers with a bare JSON scalar (`true` / `false`), and the SDK exposes that
// scalar directly as `result.data`. These assertions pin that contract: they
// would fail if the mock (or the SDK) started returning an { is_admin } envelope.

const { createClient } = require('@supabase/supabase-js');

// Mock global.fetch to intercept the SDK's HTTP requests
const fetchMock = jest.fn();
global.fetch = fetchMock;

function makeMockResponse(body, status = 200, statusText = 'OK') {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Supabase SDK RPC HTTP verification', () => {
  let supabase;

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends RPC request to correct endpoint with correct function name and params', async () => {
    fetchMock.mockResolvedValueOnce(makeMockResponse(true));

    await supabase.rpc('is_admin', { user_id: 'test-user-id' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/rpc/is_admin');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ user_id: 'test-user-id' });
  });

  it('returns the scalar boolean directly as data for an administrator', async () => {
    fetchMock.mockResolvedValueOnce(makeMockResponse(true));

    const result = await supabase.rpc('is_admin', { user_id: 'admin-user' });
    expect(result.error).toBeNull();
    expect(result.data).toBe(true);
  });

  it('returns the scalar boolean directly as data for a non-administrator', async () => {
    fetchMock.mockResolvedValueOnce(makeMockResponse(false));

    const result = await supabase.rpc('is_admin', { user_id: 'ordinary-user' });
    expect(result.error).toBeNull();
    expect(result.data).toBe(false);
    // A false result is a valid answer, not a missing one.
    expect(result.data).not.toBeNull();
  });

  it('returns null data with an error for a PostgREST error status', async () => {
    fetchMock.mockResolvedValueOnce(
      makeMockResponse(
        { code: 'PGRST202', message: 'Could not find the function public.is_admin' },
        404,
        'Not Found'
      )
    );

    const result = await supabase.rpc('is_admin', { user_id: 'user' });
    expect(result.error).toBeDefined();
    expect(result.data).toBeNull();
  });

  it('handles network errors safely', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const result = await supabase.rpc('is_admin', { user_id: 'user' });
    expect(result.error).toBeDefined();
    expect(result.data).toBeNull();
  });

  it('handles malformed response safely', async () => {
    fetchMock.mockResolvedValueOnce(makeMockResponse('invalid json'));

    const result = await supabase.rpc('is_admin', { user_id: 'user' });
    expect(result.error).toBeDefined();
    expect(result.data).toBeNull();
  });
});
