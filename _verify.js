// Temporary end-to-end verification helper (Phase 13/15). Not part of the app.
const BASE = process.argv[2] || 'http://localhost:3002';

async function hit(path, opts = {}) {
  try {
    const res = await fetch(BASE + path, opts);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, headers: res.headers, bytes: text.length };
  } catch (e) {
    return { status: 'ERR', body: e.message, bytes: 0 };
  }
}

const results = [];
function check(label, actual, expected) {
  const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  results.push({ ok, label, actual, expected: Array.isArray(expected) ? expected.join('|') : expected });
}

(async () => {
  const home = await hit('/');
  check('GET /', home.status, 200);
  check('/ has <title>AnimeHub', home.body.includes('<title>AnimeHub'), true);
  check('/ has og:image social-preview.jpg', home.body.includes('content="/social-preview.jpg"'), true);
  check('/ no data.js script tag', home.body.includes('src="data.js"'), false);
  check('/ favicon.svg linked', home.body.includes('favicon.svg'), true);
  check('/ has JSON-LD', home.body.includes('application/ld+json'), true);

  const search = await hit('/api/search?q=naruto');
  check('/api/search?q=naruto', search.status, 200);
  check('/api/search returns array', Array.isArray(search.body), true);
  check('/api/search has results', search.body.length > 0, true);

  check('/api/search empty query 400', (await hit('/api/search?q=')).status, 400);
  check('/api/search oversized 400', (await hit('/api/search?q=' + 'x'.repeat(101))).status, 400);

  check('CORS rejects foreign origin', (await hit('/api/trending', { headers: { Origin: 'https://evil.example' } })).status, 403);
  check('CORS allows own origin', (await hit('/api/trending', { headers: { Origin: new URL(BASE).origin } })).status, 200);

  check('/api/popular', (await hit('/api/popular')).status, 200);
  check('/api/trending', (await hit('/api/trending')).status, 200);
  check('/api/genres', (await hit('/api/genres')).status, 200);
  check('/api/genre/Action', (await hit('/api/genre/Action')).status, 200);
  check('/api/detail/3', (await hit('/api/detail/3')).status, 200);
  check('/api/detail/999999 404', (await hit('/api/detail/999999')).status, 404);
  check('/api/anime/21', (await hit('/api/anime/21')).status, 200);
  check('/api/site-config', (await hit('/api/site-config')).status, 200);
  check('/api/config keys', Object.keys((await hit('/api/config')).body).sort().join(','), 'SUPABASE_ANON_KEY,SUPABASE_URL');

  check('DELETE /api/account unauthenticated 401', (await hit('/api/account', { method: 'DELETE' })).status, 401);
  check('CORS error handler still 403', (await hit('/api/site-config', { headers: { Origin: 'https://nope.example' } })).status, 403);

  // static exposure
  for (const p of ['/server.js', '/.env', '/catalog-utils.js', '/test-search.js', '/package.json', '/data.js', '/%2e%2e/server.js']) {
    check('source not served: ' + p, (await hit(p)).status, 404);
  }

  // assets
  check('favicon.svg', (await hit('/favicon.svg')).status, 200);
  check('social-preview.jpg', (await hit('/social-preview.jpg')).status, 200);
  const img = await hit('/social-preview.jpg');
  check('social preview under 300KB', img.bytes < 300 * 1024, true);

  // legal pages
  for (const p of ['/privacy.html', '/terms.html', '/contact.html', '/dmca.html']) {
    const r = await hit(p);
    check(p + ' 200', r.status, 200);
    check(p + ' states non-hosting', r.body.includes('does not host') || r.body.includes('discovery catalog'), true);
    check(p + ' og:image', r.body.includes('/social-preview.jpg'), true);
  }

  // robots / sitemap
  check('/robots.txt', (await hit('/robots.txt')).status, 200);
  check('/sitemap.xml', (await hit('/sitemap.xml')).status, 200);

  // security headers
  check('X-Content-Type-Options', home.headers.get('x-content-type-options'), 'nosniff');
  check('X-Frame-Options', home.headers.get('x-frame-options'), 'DENY');

  // report
  let failed = 0;
  for (const r of results) {
    if (!r.ok) {
      failed++;
      console.log('FAIL  ' + r.label + '  -> got ' + JSON.stringify(r.actual) + ' expected ' + JSON.stringify(r.expected));
    }
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed` + (failed ? `  (${failed} FAILED)` : ''));
  console.log('social-preview.jpg size: ' + img.bytes + ' bytes');
  process.exit(failed ? 1 : 0);
})();
