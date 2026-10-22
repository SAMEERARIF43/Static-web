const http = require('http');

function jsonResponse(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function createAniListMock({ port, handleRequest }) {
  if (!Number.isInteger(port) || typeof handleRequest !== 'function') {
    throw new TypeError('createAniListMock requires an integer port and request handler.');
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      jsonResponse(res, { error: 'Method not allowed' }, 405);
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = { __invalid_json: true };
      }

      Promise.resolve(handleRequest({ req, res, payload, jsonResponse }))
        .catch(error => {
          if (!res.headersSent) jsonResponse(res, { error: error.message }, 500);
        });
    });
  });

  return {
    server,
    url: `http://127.0.0.1:${port}`,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    },
    close() {
      return new Promise(resolve => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
  };
}

module.exports = { createAniListMock };
