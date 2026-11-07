import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const frontendDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(frontendDir, '..');

// Start Express backend on port 3000
const express = spawn(process.execPath, ['server.js'], {
  cwd: rootDir,
  env: {
    ...process.env,
    PORT: '3000',
    NODE_ENV: 'test',
    ADMIN_KEY: process.env.ADMIN_KEY || 'playwright-test-only-admin-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

express.stdout.pipe(process.stdout);
express.stderr.pipe(process.stderr);

// Start Vite dev server on port 5173
const viteBin = path.resolve(frontendDir, 'node_modules', '.bin', 'vite');
const vite = spawn(`"${viteBin}" --port 5173`, {
  cwd: frontendDir,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});

vite.stdout.pipe(process.stdout);
vite.stderr.pipe(process.stderr);

// Keep process alive
const keepAlive = setInterval(() => {}, 10000);

process.on('SIGINT', () => {
  clearInterval(keepAlive);
  vite.kill();
  express.kill();
  process.exit(0);
});
process.on('SIGTERM', () => {
  clearInterval(keepAlive);
  vite.kill();
  express.kill();
  process.exit(0);
});
