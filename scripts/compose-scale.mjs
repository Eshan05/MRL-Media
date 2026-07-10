import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const shouldDown = args.includes('--down');
const positional = args.filter((arg) => !arg.startsWith('--'));
const replicas = Number(positional[0] ?? 12);
const rate = Number(positional[1] ?? 50);
const durationS = Number(positional[2] ?? 20);
const compose = ['compose', '-p', 'srl-scale', '-f', 'docker-compose.scale.yml'];
const base = 'http://127.0.0.1:3210';
const generatedDir = resolve('.scale-tmp');
const nginxConf = resolve(generatedDir, `nginx-${replicas}.conf`);

if (!Number.isInteger(replicas) || replicas < 1 || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(durationS) || durationS <= 0) {
  console.error('usage: node scripts/compose-scale.mjs [replicas=12] [rate=50] [durationS=20] [--down]');
  process.exit(2);
}

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: false, ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} failed with exit ${res.status ?? 1}`);
  }
}

function writeNginxConfig() {
  mkdirSync(generatedDir, { recursive: true });
  const servers = Array.from({ length: replicas }, (_, i) => `    server srl-scale-api-${i + 1}:3000;`).join('\n');
  writeFileSync(
    nginxConf,
    `events {}

http {
  upstream api_pool {
${servers}
  }

  server {
    listen 80;

    location / {
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_pass http://api_pool;
    }
  }
}
`,
  );
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { headers: { 'x-forwarded-for': '10.90.0.1' } });
      if (res.status === 200) return;
    } catch {
      // stack still booting
    }
    await sleep(500);
  }
  throw new Error('compose scale stack did not become healthy within 60s');
}

async function sampleInstances() {
  const seen = new Set();
  for (let i = 0; i < Math.max(50, replicas * 8); i++) {
    const res = await fetch(`${base}/health`, {
      headers: { 'x-forwarded-for': `10.91.${Math.floor(i / 250)}.${(i % 250) + 1}` },
    });
    const id = res.headers.get('x-api-instance');
    if (id) seen.add(id);
  }
  return seen;
}

async function waitForInstances() {
  const seen = new Set();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && seen.size < replicas) {
    for (const id of await sampleInstances()) seen.add(id);
    if (seen.size < replicas) await sleep(500);
  }
  return seen;
}

let failed = false;

try {
  console.log(`compose scale: api replicas=${replicas}, rate=${rate}/s, duration=${durationS}s`);
  writeNginxConfig();
  run('docker', [...compose, 'up', '-d', '--build', '--scale', `api=${replicas}`], {
    env: { ...process.env, NGINX_SCALE_CONF: nginxConf },
  });
  await waitForHealth();

  const instances = await waitForInstances();
  console.log(`load balancer reached ${instances.size}/${replicas} API instances`);
  console.log([...instances].sort().join('\n'));
  if (instances.size !== replicas) {
    throw new Error('load balancer did not reach every API instance');
  }

  run(process.execPath, ['scripts/local-scale.mjs', base, String(rate), String(durationS), '2000']);
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : err);
} finally {
  if (shouldDown) {
    try {
      run('docker', [...compose, 'down', '-v']);
    } catch (err) {
      failed = true;
      console.error(err instanceof Error ? err.message : err);
    }
  }
}

process.exit(failed ? 1 : 0);
