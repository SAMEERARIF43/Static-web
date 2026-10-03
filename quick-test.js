const { spawn } = require('child_process');
const http = require('http');

console.log('Starting server...');

const server = spawn('node', ['server.js'], {
  cwd: 'C:\\Users\\samee\\OneDrive\\Documents\\Default Project\\Static-web',
  stdio: ['pipe', 'pipe', 'pipe']
});

let serverReady = false;
let readyResolve;

server.stdout.on('data', (data) => {
  const output = data.toString();
  if (!serverReady && output.includes('running at')) {
    serverReady = true;
    console.log('Server started!');
  }
  process.stdout.write(output);
});

server.stderr.on('data', (data) => {
  process.stderr.write(data);
});

server.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Wait for server to be ready
function waitForServer() {
  return new Promise(resolve => {
    if (serverReady) return resolve();
    
    const check = setInterval(() => {
      if (serverReady) {
        clearInterval(check);
        resolve();
      }
    }, 200);
    
    setTimeout(() => {
      clearInterval(check);
      resolve(); // Continue anyway
    }, 5000);
  });
}

async function testAPI(path) {
  await waitForServer();
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:3000${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function runTests() {
  try {
    console.log('\n=== Testing Trending ===');
    const trending = await testAPI('/api/trending');
    console.log('Trending count:', trending.length);
    trending.slice(0, 2).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Popular ===');
    const popular = await testAPI('/api/popular');
    console.log('Popular count:', popular.length);
    popular.slice(0, 2).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Search ===');
    const search = await testAPI('/api/search?q=One+Piece');
    console.log('Search results:', search.length);
    search.slice(0, 2).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Genre ===');
    const genre = await testAPI('/api/action');
    console.log('Action genre count:', genre.length);
    genre.slice(0, 2).forEach(a => console.log('-', a.title));
    
    console.log('\n=== Testing Detail ===');
    const detail = await testAPI('/api/detail/1');
    console.log('Detail:', detail.title);
    
    console.log('\n=== Testing Episodes ===');
    const episodes = await testAPI('/api/episodes/1');
    console.log('Episodes count:', episodes.length);
    
    console.log('\n=== Testing Genres List ===');
    const genres = await testAPI('/api/genres');
    console.log('All genres:', genres);
    
    console.log('\n=== All tests passed! ===');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    server.kill();
    process.exit(0);
  }
}

runTests();