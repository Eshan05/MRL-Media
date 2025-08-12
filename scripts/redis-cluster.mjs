import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = new Set(process.argv.slice(2));
const down = args.has('--down');
const ports = [7000, 7001, 7002, 7003, 7004, 7005];
const network = 'srl-redis-cluster';
const dir = resolve('.scale-tmp/redis-cluster');
const announceHost = process.env.REDIS_CLUSTER_ANNOUNCE_HOST ?? 'host.docker.internal';
const clientHost = process.env.REDIS_CLUSTER_CLIENT_HOST ?? '127.0.0.1';

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} failed with exit ${res.status ?? 1}`);
  }
  return res;
}

function nodeName(port) {
  return `srl-redis-cluster-${port}`;
}

function removeCluster() {
  for (const port of ports) {
    run('docker', ['rm', '-f', nodeName(port)], { allowFail: true });
  }
  run('docker', ['network', 'rm', network], { allowFail: true });
}

if (down) {
  removeCluster();
  process.exit(0);
}

removeCluster();
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
run('docker', ['network', 'create', network]);

for (const port of ports) {
  const nodeDir = resolve(dir, String(port));
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(
    resolve(nodeDir, 'redis.conf'),
    [
      `port ${port}`,
      'bind 0.0.0.0',
      'protected-mode no',
      'appendonly no',
      'cluster-enabled yes',
      'cluster-config-file nodes.conf',
      'cluster-node-timeout 5000',
      `cluster-announce-ip ${announceHost}`,
      `cluster-announce-port ${port}`,
      `cluster-announce-bus-port ${port + 10000}`,
      '',
    ].join('\n'),
  );
  run('docker', [
    'run',
    '-d',
    '--name',
    nodeName(port),
    '--network',
    network,
    '-p',
    `${port}:${port}`,
    '-p',
    `${port + 10000}:${port + 10000}`,
    '-v',
    `${nodeDir}:/usr/local/etc/redis`,
    'redis:8-alpine',
    'redis-server',
    '/usr/local/etc/redis/redis.conf',
  ]);
}

const deadline = Date.now() + 30_000;
for (const port of ports) {
  while (Date.now() < deadline) {
    const ping = run('docker', ['exec', nodeName(port), 'redis-cli', '-p', String(port), 'ping'], {
      capture: true,
      allowFail: true,
    });
    if (ping.stdout.trim() === 'PONG') break;
    await sleep(300);
  }
}

run('docker', [
  'exec',
  nodeName(7000),
  'redis-cli',
  '--cluster',
  'create',
  ...ports.map((port) => `${announceHost}:${port}`),
  '--cluster-replicas',
  '1',
  '--cluster-yes',
]);

while (Date.now() < deadline + 15_000) {
  const info = run('docker', ['exec', nodeName(7000), 'redis-cli', '-p', '7000', 'cluster', 'info'], {
    capture: true,
    allowFail: true,
  });
  if (info.stdout.includes('cluster_state:ok')) {
    console.log(`REDIS_CLUSTER_NODES=${ports.map((port) => `${clientHost}:${port}`).join(',')}`);
    console.log(
      `REDIS_CLUSTER_NAT_MAP=${ports.map((port) => `${announceHost}:${port}=${clientHost}:${port}`).join(',')}`,
    );
    process.exit(0);
  }
  await sleep(500);
}

throw new Error('redis cluster did not reach cluster_state:ok');
