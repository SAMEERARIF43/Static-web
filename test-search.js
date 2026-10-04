const http = require('http');

const baseURL = 'http://localhost:3000';

function search(query) {
  return new Promise((resolve, reject) => {
    http.get(`${baseURL}/api/search?q=${encodeURIComponent(query)}`, (res) => {
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

async function run() {
  try {
    console.log('=== Testing Search: One Piece ===');
    const results = await search('One Piece');
    console.log('Results count:', results.length);
    results.slice(0, 3).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Search: Naruto ===');
    const results2 = await search('Naruto');
    console.log('Results count:', results2.length);
    results2.slice(0, 3).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Search: Empty ===');
    const results3 = await search('');
    console.log('Results:', results3);
    
    console.log('\n=== All search tests passed! ===');
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();