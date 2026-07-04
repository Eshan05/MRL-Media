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
const DATABASE_URL =
  process.env.CHAOS_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/mrl_media';
const STORAGE_DRIVER = process.env.CHAOS_STORAGE_DRIVER ?? 'database';
const logDir = resolve('.scale-tmp/chaos');
const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
const drizzleCli = resolve('node_modules/drizzle-kit/bin.cjs');
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
  run('docker', ['compose', 'up', '-d', 'redis', 'postgres']);
  run(process.execPath, [drizzleCli, 'push', '--force'], { env: { ...process.env, DATABASE_URL } });
  run('docker', ['exec', 'srl-redis', 'redis-cli', '-n', '15', 'FLUSHDB']);
  start('api', ['src/api/server.ts'], {
    REDIS_URL,
    DATABASE_URL,
    STORAGE_DRIVER,
    PORT: String(PORT),
    TRUST_PROXY: '1',
    ADMIN_KEY: 'dev-admin',
    WEBHOOK_ALLOW_PRIVATE: '1',
    BETTER_AUTH_URL: BASE,
  });
  let worker = start('worker', ['src/worker/index.ts'], { REDIS_URL, DATABASE_URL, STORAGE_DRIVER, WEBHOOK_ALLOW_PRIVATE: '1' });

  await waitHealth((_status, json) => json.worker?.alive === true);
  report('worker heartbeat comes alive', true, BASE);

  worker.kill('SIGKILL');
  await waitHealth((_status, json) => json.worker?.alive === false, 25_000);
  report('worker death is visible in /health', true, 'heartbeat expired');

  worker = start('worker', ['src/worker/index.ts'], { REDIS_URL, DATABASE_URL, STORAGE_DRIVER, WEBHOOK_ALLOW_PRIVATE: '1' });
  await waitHealth((_status, json) => json.worker?.alive === true);
  report('worker restart restores heartbeat', true, 'alive=true');

  const { apiKey } = await adminUser(BASE, { name: `chaos-${Date.now()}` });
  const fd = new FormData();
  fd.append(
    'file',
    new File(
      ['<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#38bdf8"/></svg>'],
      'chaos.svg',
      { type: 'image/svg+xml' },
    ),
  );
  const upload = await fetch(`${BASE}/upload`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: fd });
  const uploaded = await upload.json().catch(() => null);
  report('post-restart upload works', upload.status === 201, `status=${upload.status}`);
  let job = null;
  for (let i = 0; uploaded?.statusUrl && i < 15; i++) {
    const res = await fetch(`${BASE}${uploaded.statusUrl}`, { headers: { authorization: `Bearer ${apiKey}` } });
    job = await res.json();
    if (job.state === 'completed' || job.state === 'failed') break;
    await sleep(500);
  }
  report(
    'split worker reads/writes shared object storage',
    job?.state === 'completed' && job.outputs?.length === 2,
    `state=${job?.state ?? 'missing'}`,
  );

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
