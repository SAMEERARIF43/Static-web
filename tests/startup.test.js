// Real Express server startup regression test.
// Launches server.js as a separate child process and verifies it boots
// and responds to /api/health with HTTP 200.

const { spawn } = require('child_process')
const http = require('http')

const TEST_PORT = 34567
const STARTUP_TIMEOUT_MS = 20000

function waitForHealth(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        if (res.statusCode === 200) {
          resolve()
          return
        }
        res.resume()
        retry()
      })
      req.on('error', () => {
        retry()
      })
      req.setTimeout(2000, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Server did not become healthy within ${timeoutMs}ms`))
        return
      }
      setTimeout(poll, 200)
    }
    poll()
  })
}

describe('Express server startup', () => {
  let serverProcess = null

  afterEach(() => {
    if (serverProcess) {
      try {
        serverProcess.kill('SIGTERM')
      } catch (_) {
        // Ignore kill errors
      }
      serverProcess = null
    }
  })

  afterAll(() => {
    // No process.exit() — rely on Jest's natural teardown to close
    // handles and terminate the child process via afterEach kill.
  })

  it('starts successfully and responds to /api/health', async () => {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(TEST_PORT),
      SITE_URL: 'http://127.0.0.1:' + TEST_PORT,
      CORS_ORIGINS: 'http://127.0.0.1:' + TEST_PORT,
      ADMIN_KEY: 'test-admin-key-' + Date.now(),
      ANILIST_GRAPHQL_URL: 'http://127.0.0.1:9', // Closed port; not needed for /api/health
      TRUST_PROXY: '',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      CONTACT_EMAIL: '',
      DMCA_EMAIL: '',
    }

    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderrOutput = ''
    serverProcess.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString()
    })

    // Wait for the server to become healthy
    await waitForHealth(TEST_PORT, STARTUP_TIMEOUT_MS)

    // Verify a real health request
    const res = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${TEST_PORT}/api/health`, (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data })
        })
      })
      req.on('error', reject)
      req.setTimeout(5000, () => {
        req.destroy()
        reject(new Error('Health request timed out'))
      })
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ok')

    // Verify no startup crash in stderr
    if (stderrOutput.includes('FATAL') || stderrOutput.includes('SyntaxError')) {
      throw new Error('Server emitted startup errors: ' + stderrOutput)
    }
  })
})
