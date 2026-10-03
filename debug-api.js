const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const workdir = 'C:\\Users\\samee\\OneDrive\\Documents\\Default Project\\Static-web';

console.log('Starting server...');

const server = spawn('node', ['server.js'], {
  cwd: workdir,
  stdio: ['pipe', 'pipe', 'pipe']
});

let serverReady = false;

server.stdout.on('data', (data) => {
  const output = data.toString();
  if (output.includes('running at') && !serverReady) {
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

function waitForServer() {
  return new Promise(resolve => {
    const check = setInterval(() => {
      if (serverReady) {
        clearInterval(check);
        resolve();
      }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 5000);
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
    await waitForServer();
    
    // Test the genre endpoint with raw output
    console.log('\n=== Testing Genre (action) ===');
    const genre = await testAPI('/api/action');
    console.log('Full response:', JSON.stringify(genre, null, 2).substring(0, 500));
    
    console.log('\n=== Testing Genres List ===');
    const genres = await testAPI('/api/genres');
    console.log('Genres:', genres);
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    server.kill();
    process.exit(0);
  }
}

runTests();