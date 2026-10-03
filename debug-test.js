const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/api/action') {
    // Read the updated server.js and test manually
    const ANIME_DB = require('./server.js').ANIME_DB || [];
    const filterByGenre = (genre) => {
      if (!genre || genre === 'All') return ANIME_DB;
      const lowerGenre = genre.toLowerCase();
      return ANIME_DB.filter(a => a.genres.some(g => g.toLowerCase() === lowerGenre));
    };
    const results = filterByGenre('action');
    res.end(JSON.stringify({ count: results.length, titles: results.map(a => a.title) }));
  } else {
    res.end('not found');
  }
});

server.listen(3001, () => {
  console.log('Test server on 3001');
  http.get('http://localhost:3001/api/action', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const result = JSON.parse(data);
      console.log('Count:', result.count);
      console.log('Titles:', result.titles);
      server.close();
    });
  });
});