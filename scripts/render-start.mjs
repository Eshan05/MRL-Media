import { spawn } from 'node:child_process';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const children = new Set();
let shuttingDown = false;

function start(name, args) {
  const child = spawn(pnpm, args, {
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('error', (err) => {
    console.error(`[${name}] failed to start: ${err.message}`);
  });
  return child;
}

function runOnce(name, args) {
  return new Promise((resolve, reject) => {
    const child = start(name, args);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with ${code ?? signal}`));
    });
  });
}

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill(signal);
}

process.once('SIGTERM', () => stopAll('SIGTERM'));
process.once('SIGINT', () => stopAll('SIGINT'));

await runOnce('db:push', ['db:push', '--force']);

const api = start('api', ['exec', 'tsx', 'src/api/server.ts']);
if (process.env.RUN_WORKER !== '0') start('worker', ['exec', 'tsx', 'src/worker/index.ts']);

const code = await new Promise((resolve) => {
  api.once('exit', (exitCode) => resolve(exitCode ?? 1));
});
stopAll();
process.exitCode = code;
