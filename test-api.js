const http = require('http');

function fetchAPI(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function test() {
  try {
    console.log('=== Testing Trending ===');
    const trending = await fetchAPI('/api/trending');
    console.log('Trending count:', trending.length);
    trending.slice(0, 2).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Popular ===');
    const popular = await fetchAPI('/api/popular');
    console.log('Popular count:', popular.length);
    popular.slice(0, 2).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Search ===');
    const search = await fetchAPI('/api/search?q=One+Piece');
    console.log('Search results:', search.length);
    search.slice(0, 2).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Genre ===');
    const genre = await fetchAPI('/api/action');
    console.log('Action genre count:', genre.length);
    genre.slice(0, 2).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Detail ===');
    const detail = await fetchAPI('/api/detail/1');
    console.log('Detail:', detail.title);
    
    console.log('\n=== Testing Episodes ===');
    const episodes = await fetchAPI('/api/episodes/1');
    console.log('Episodes count:', episodes.length);
    
    console.log('\n=== Testing Genres List ===');
    const genres = await fetchAPI('/api/genres');
    console.log('All genres:', genres);
    
    console.log('\n=== All tests passed! ===');
  } catch (err) {
    console.error('Error:', err.message);
  }
}

test();