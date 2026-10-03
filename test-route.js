const { spawn } = require('child_process');
const http = require('http');

const workdir = 'C:\\Users\\samee\\OneDrive\\Documents\\Default Project\\Static-web';

console.log('Starting server...');

const server = spawn('node', ['server.js'], { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'] });

let serverReady = false;
server.stdout.on('data', d => { if(d.toString().includes('running at') && !serverReady) { serverReady = true; console.log('Server started!'); } });
server.stderr.on('data', d => process.stderr.write(d));

function waitForServer() {
  return new Promise(resolve => {
    const check = setInterval(() => { if(serverReady) { clearInterval(check); resolve(); } }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 5000);
  });
}

async function test(path) {
  await waitForServer();
  return new Promise(resolve => {
    http.get(`http://localhost:3000${path}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', e => resolve(e));
  });
}

async function run() {
  await waitForServer();
  console.log('/api/genre/Action:', await test('/api/genre/Action'));
  console.log('/api/genre/All:', await test('/api/genre/All'));
  console.log('/api/trending:', (await test('/api/trending')).length, 'anime');
  console.log('/api/popular:', (await test('/api/popular')).length, 'anime');
  console.log('/api/genres:', (await test('/api/genres')).length, 'genres');
  server.kill(); process.exit(0);
}

run().catch(e => { console.error(e); server.kill(); process.exit(1); });