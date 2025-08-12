// Automated local chaos check. Starts API + worker, proves worker liveness,
// kills/restarts the worker, and briefly pauses Redis to verify fail-closed.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { adminUser } from './_helpers.mjs';

const PORT = Number(process.env.CHAOS_PORT ?? 3299);
const BASE = `http://127.0.0.1:${PORT}`;
const REDIS_URL = process.env.CHAOS_REDIS_URL ?? 'redis://localhost:6379/15';
const logDir = resolve('.scale-tmp/chaos');
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
mkdirSync(logDir, { recursive: true });
const children = [];
const results = [];

function report(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

function run(cmd, args, opts = {}) {
  const stdio = opts.capture ? 'pipe' : opts.allowFail ? 'ignore' : 'inherit';
  const res = spawnSync(cmd, args, { stdio, encoding: 'utf8', ...opts });
  if (res.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed`);
  return res;
}

function start(name, args, env) {
  const child = spawn(process.execPath, [tsxCli, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

async function waitHealth(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, {
        headers: { 'x-forwarded-for': '10.222.0.1' },
        signal: AbortSignal.timeout(1000),
      });
      const json = await res.json();
      if (predicate(res.status, json)) return { res, json };
    } catch {
      // still booting
    }
    await sleep(500);
  }
  throw new Error('health condition timed out');
}

try {
  run('docker', ['compose', 'up', '-d', 'redis']);
  run('docker', ['exec', 'srl-redis', 'redis-cli', '-n', '15', 'FLUSHDB']);
  start('api', ['src/api/server.ts'], {
    REDIS_URL,
    PORT: String(PORT),
    TRUST_PROXY: '1',
    ADMIN_KEY: 'dev-admin',
    WEBHOOK_ALLOW_PRIVATE: '1',
    BETTER_AUTH_URL: BASE,
  });
  let worker = start('worker', ['src/worker/index.ts'], { REDIS_URL, WEBHOOK_ALLOW_PRIVATE: '1' });

  await waitHealth((_status, json) => json.worker?.alive === true);
  report('worker heartbeat comes alive', true, BASE);

  worker.kill('SIGKILL');
  await waitHealth((_status, json) => json.worker?.alive === false, 25_000);
  report('worker death is visible in /health', true, 'heartbeat expired');

  worker = start('worker', ['src/worker/index.ts'], { REDIS_URL, WEBHOOK_ALLOW_PRIVATE: '1' });
  await waitHealth((_status, json) => json.worker?.alive === true);
  report('worker restart restores heartbeat', true, 'alive=true');

  const { apiKey } = await adminUser(BASE, { name: `chaos-${Date.now()}` });
  const fd = new FormData();
  fd.append('file', new File(['chaos'], 'chaos.txt', { type: 'text/plain' }));
  const upload = await fetch(`${BASE}/upload`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: fd });
  report('post-restart upload works', upload.status === 201, `status=${upload.status}`);

  run('docker', ['pause', 'srl-redis'], { allowFail: true });
  const failClosed = await fetch(`${BASE}/health`, {
    headers: { 'x-forwarded-for': '10.222.0.2' },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  report('redis pause does not return false 200', failClosed === null || failClosed.status >= 500, `status=${failClosed?.status ?? 'network'}`);
  run('docker', ['unpause', 'srl-redis'], { allowFail: true });
  await waitHealth((status) => status === 200);
  report('redis unpause recovers health', true, 'status=200');
} finally {
  run('docker', ['unpause', 'srl-redis'], { allowFail: true });
  for (const child of children) child.kill('SIGTERM');
}

process.exit(results.every(Boolean) ? 0 : 1);
