# Anime Hub Performance Benchmark Results

Generated: 2026-10-22T17:01:03.956Z

## Test Environment
- Node.js: v24.18.0
- Platform: win32 x64
- Server: http://127.0.0.1:3000

## Server Proxy Response Times (500 burst, 10 concurrent)

| Metric | Value |
|--------|-------|
| Total requests | 500 |
| Successes | 119 |
| Failures | 381 |
| Min | 0.49 ms |
| Max | 8.84 ms |
| Average | 4.60 ms |
| P50 | 3.98 ms |
| P95 | 8.54 ms |
| P99 | 8.77 ms |

## JSON Parsing Throughput

| Metric | Value |
|--------|-------|
| Iterations | 10000 |
| Total time | 72.76 ms |
| Avg per parse | 0.0073 ms |

## Cache Hit/Miss Latency

| Metric | Value |
|--------|-------|
| Cache miss | 1.45 ms |
| Cache hit | 1.32 ms |
| Improvement | 9.1% |

## Memory Footprint (after 100 requests)

| Metric | Start | End | Delta |
|--------|-------|-----|-------|
| RSS (MB) | 55.87 | 56.33 | 0.46 |
| Heap used (MB) | 6.32 | 6.92 | 0.60 |
| Heap total (MB) | 10.73 | 10.73 | - |
| External (MB) | 2.05 | 2.09 | - |

## Notes

- All tests run against the local development server.
- Cache hit/miss measurements may vary based on server caching middleware.
- Memory deltas reflect V8 heap growth after sustained request load.
