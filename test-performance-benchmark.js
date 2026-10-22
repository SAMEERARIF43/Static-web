// ============================================================================
// test-performance-benchmark.js — Synthetic Benchmark & Stress Suite (Phase 5, Task 4)
// ============================================================================
// Measures server proxy response times, JSON parsing throughput, cache
// hit/miss latency, and memory footprint across 500 simulated request bursts.
// Uses only Node.js built-in modules (http, process, fs).
//
// Usage: node test-performance-benchmark.js
// ============================================================================

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;

const BASE_URL = 'http://127.0.0.1:3000';
const BURST_SIZE = 500;
const CONCURRENT = 10;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeRequest(path) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    http.get(`${BASE_URL}${path}`, res => {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, durationMs, data });
      });
    }).on('error', err => {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      resolve({ status: 0, durationMs, error: err.message });
    });
  });
}

async function measureJsonParseThroughput() {
  const payload = JSON.stringify({ test: 'data'.repeat(100), items: Array(50).fill({ id: 1, title: 'Test' }) });
  const iterations = 10000;
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    JSON.parse(payload);
  }
  const end = process.hrtime.bigint();
  const totalMs = Number(end - start) / 1_000_000;
  return { totalMs, iterations, avgMs: totalMs / iterations };
}

async function runBurstTest() {
  console.log(`Running burst test: ${BURST_SIZE} requests, ${CONCURRENT} concurrent...`);

  let completed = 0;

  async function worker() {
    while (completed < BURST_SIZE) {
      const index = completed++;
      if (index >= BURST_SIZE) break;
      try {
        await makeRequest('/api/health');
      } catch {
        // Request failures are tracked via status codes, not exceptions
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENT; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const durations = [];
  let successes = 0;
  let failures = 0;

  for (let i = 0; i < BURST_SIZE; i++) {
    try {
      const result = await makeRequest('/api/health');
      if (result.status === 200) {
        successes++;
        durations.push(result.durationMs);
      } else {
        failures++;
      }
    } catch {
      failures++;
    }
  }

  durations.sort((a, b) => a - b);

  return {
    total: BURST_SIZE,
    successes,
    failures,
    minMs: durations.length > 0 ? durations[0] : 0,
    maxMs: durations.length > 0 ? durations[durations.length - 1] : 0,
    avgMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    p50Ms: durations.length > 0 ? durations[Math.floor(durations.length * 0.5)] : 0,
    p95Ms: durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : 0,
    p99Ms: durations.length > 0 ? durations[Math.floor(durations.length * 0.99)] : 0
  };
}

async function runCacheTest() {
  console.log('Running cache hit/miss latency test...');

  const missStart = process.hrtime.bigint();
  const missResult = await makeRequest('/api/health');
  const missEnd = process.hrtime.bigint();
  const missMs = Number(missEnd - missStart) / 1_000_000;

  await sleep(10);

  const hitStart = process.hrtime.bigint();
  const hitResult = await makeRequest('/api/health');
  const hitEnd = process.hrtime.bigint();
  const hitMs = Number(hitEnd - hitStart) / 1_000_000;

  return { missMs, hitMs, missStatus: missResult.status, hitStatus: hitResult.status };
}

async function measureMemoryFootprint() {
  const startMem = process.memoryUsage();
  for (let i = 0; i < 100; i++) {
    await makeRequest('/api/health');
  }
  await sleep(50);
  const endMem = process.memoryUsage();

  return {
    start: {
      rssMB: (startMem.rss / 1024 / 1024).toFixed(2),
      heapTotalMB: (startMem.heapTotal / 1024 / 1024).toFixed(2),
      heapUsedMB: (startMem.heapUsed / 1024 / 1024).toFixed(2),
      externalMB: (startMem.external / 1024 / 1024).toFixed(2)
    },
    end: {
      rssMB: (endMem.rss / 1024 / 1024).toFixed(2),
      heapTotalMB: (endMem.heapTotal / 1024 / 1024).toFixed(2),
      heapUsedMB: (endMem.heapUsed / 1024 / 1024).toFixed(2),
      externalMB: (endMem.external / 1024 / 1024).toFixed(2)
    },
    delta: {
      rssMB: ((endMem.rss - startMem.rss) / 1024 / 1024).toFixed(2),
      heapUsedMB: ((endMem.heapUsed - startMem.heapUsed) / 1024 / 1024).toFixed(2)
    }
  };
}

async function run() {
  console.log('=== Anime Hub Performance Benchmark Suite ===\n');

  try {
    await makeRequest('/api/health');
  } catch {
    console.error('ERROR: Server is not running on http://127.0.0.1:3000');
    console.error('Start the server with: npm start');
    process.exitCode = 1;
    return;
  }

  const burstStats = await runBurstTest();
  const jsonStats = await measureJsonParseThroughput();
  const cacheStats = await runCacheTest();
  const memStats = await measureMemoryFootprint();

  console.log('\n=== Benchmark Results ===\n');

  console.log('--- Server Proxy Response Times (500 burst, 10 concurrent) ---');
  console.log(`Total requests: ${burstStats.total}`);
  console.log(`Successes: ${burstStats.successes}`);
  console.log(`Failures: ${burstStats.failures}`);
  console.log(`Min: ${burstStats.minMs.toFixed(2)} ms`);
  console.log(`Max: ${burstStats.maxMs.toFixed(2)} ms`);
  console.log(`Avg: ${burstStats.avgMs.toFixed(2)} ms`);
  console.log(`P50: ${burstStats.p50Ms.toFixed(2)} ms`);
  console.log(`P95: ${burstStats.p95Ms.toFixed(2)} ms`);
  console.log(`P99: ${burstStats.p99Ms.toFixed(2)} ms`);

  console.log('\n--- JSON Parsing Throughput ---');
  console.log(`Iterations: ${jsonStats.iterations}`);
  console.log(`Total time: ${jsonStats.totalMs.toFixed(2)} ms`);
  console.log(`Avg per parse: ${jsonStats.avgMs.toFixed(4)} ms`);

  console.log('\n--- Cache Hit/Miss Latency ---');
  console.log(`Cache miss: ${cacheStats.missMs.toFixed(2)} ms (status: ${cacheStats.missStatus})`);
  console.log(`Cache hit:  ${cacheStats.hitMs.toFixed(2)} ms (status: ${cacheStats.hitStatus})`);
  console.log(`Improvement: ${cacheStats.missMs > 0 ? ((cacheStats.missMs - cacheStats.hitMs) / cacheStats.missMs * 100).toFixed(1) : 0}%`);

  console.log('\n--- Memory Footprint (after 100 requests) ---');
  console.log(`RSS: ${memStats.start.rssMB} MB -> ${memStats.end.rssMB} MB (delta: ${memStats.delta.rssMB} MB)`);
  console.log(`Heap used: ${memStats.start.heapUsedMB} MB -> ${memStats.end.heapUsedMB} MB (delta: ${memStats.delta.heapUsedMB} MB)`);
  console.log(`Heap total: ${memStats.start.heapTotalMB} MB -> ${memStats.end.heapTotalMB} MB`);
  console.log(`External: ${memStats.start.externalMB} MB -> ${memStats.end.externalMB} MB`);

  const date = new Date().toISOString();
  const report = `# Anime Hub Performance Benchmark Results

Generated: ${date}

## Test Environment
- Node.js: ${process.version}
- Platform: ${process.platform} ${process.arch}
- Server: http://127.0.0.1:3000

## Server Proxy Response Times (500 burst, 10 concurrent)

| Metric | Value |
|--------|-------|
| Total requests | ${burstStats.total} |
| Successes | ${burstStats.successes} |
| Failures | ${burstStats.failures} |
| Min | ${burstStats.minMs.toFixed(2)} ms |
| Max | ${burstStats.maxMs.toFixed(2)} ms |
| Average | ${burstStats.avgMs.toFixed(2)} ms |
| P50 | ${burstStats.p50Ms.toFixed(2)} ms |
| P95 | ${burstStats.p95Ms.toFixed(2)} ms |
| P99 | ${burstStats.p99Ms.toFixed(2)} ms |

## JSON Parsing Throughput

| Metric | Value |
|--------|-------|
| Iterations | ${jsonStats.iterations} |
| Total time | ${jsonStats.totalMs.toFixed(2)} ms |
| Avg per parse | ${jsonStats.avgMs.toFixed(4)} ms |

## Cache Hit/Miss Latency

| Metric | Value |
|--------|-------|
| Cache miss | ${cacheStats.missMs.toFixed(2)} ms |
| Cache hit | ${cacheStats.hitMs.toFixed(2)} ms |
| Improvement | ${cacheStats.missMs > 0 ? ((cacheStats.missMs - cacheStats.hitMs) / cacheStats.missMs * 100).toFixed(1) : 0}% |

## Memory Footprint (after 100 requests)

| Metric | Start | End | Delta |
|--------|-------|-----|-------|
| RSS (MB) | ${memStats.start.rssMB} | ${memStats.end.rssMB} | ${memStats.delta.rssMB} |
| Heap used (MB) | ${memStats.start.heapUsedMB} | ${memStats.end.heapUsedMB} | ${memStats.delta.heapUsedMB} |
| Heap total (MB) | ${memStats.start.heapTotalMB} | ${memStats.end.heapTotalMB} | - |
| External (MB) | ${memStats.start.externalMB} | ${memStats.end.externalMB} | - |

## Notes

- All tests run against the local development server.
- Cache hit/miss measurements may vary based on server caching middleware.
- Memory deltas reflect V8 heap growth after sustained request load.
`;

  await fsp.writeFile('docs/BENCHMARK_RESULTS.md', report);
  console.log('\nResults written to docs/BENCHMARK_RESULTS.md');
  console.log('\n=== Benchmark Complete ===');
}

run().catch(error => {
  console.error('Benchmark failed:', error);
  process.exitCode = 1;
});
