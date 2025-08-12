// Volume soak — sustained concurrent traffic through the full limiter
// stack, watching for latency drift and error creep. This is a laptop-scale
// smoke of "does it degrade", not a production capacity test: single
// client process, loopback network, single redis.
//
//   node scripts/soak.mjs [baseUrl] [users=150] [reqsPerUser=40]

import { adminUsers } from './_helpers.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3211';
const USERS = Number(process.argv[3] ?? 150);
const REQS = Number(process.argv[4] ?? 40);

/** @type {{ms: number, status: number, at: number}[]} */
const samples = [];

function form() {
  const fd = new FormData();
  fd.append('file', new File(['soak'], 's.txt', { type: 'text/plain' }));
  return fd;
}

console.log(`minting ${USERS} users via admin api...`);
const minted = await adminUsers(BASE, USERS, { name: 'soak' });

async function user(i) {
  const headers = {
    authorization: `Bearer ${minted[i].apiKey}`,
    'x-forwarded-for': `10.40.${Math.floor(i / 250)}.${(i % 250) + 1}`,
  };
  for (let k = 0; k < REQS; k++) {
    const isUpload = k % 20 === 0; // 2 uploads per user, rest health checks
    const t0 = performance.now();
    try {
      const res = await fetch(
        `${BASE}${isUpload ? '/upload' : '/health'}`,
        isUpload ? { method: 'POST', headers, body: form() } : { headers },
      );
      await res.arrayBuffer();
      samples.push({ ms: performance.now() - t0, status: res.status, at: Date.now() });
    } catch {
      samples.push({ ms: performance.now() - t0, status: 0, at: Date.now() });
    }
  }
}

console.log(`soak: ${USERS} concurrent users x ${REQS} requests -> ${BASE}`);
const t0 = performance.now();
await Promise.all(Array.from({ length: USERS }, (_, i) => user(i)));
const wallS = (performance.now() - t0) / 1000;

const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
const stats = (xs) => {
  const s = xs.map((r) => r.ms).sort((a, b) => a - b);
  return `p50=${pct(s, 50).toFixed(1)}ms p95=${pct(s, 95).toFixed(1)}ms p99=${pct(s, 99).toFixed(1)}ms max=${pct(s, 100).toFixed(0)}ms`;
};

const n = samples.length;
const fifth = Math.floor(n / 5);
const sorted = [...samples].sort((a, b) => a.at - b.at);
const early = sorted.slice(0, fifth);
const late = sorted.slice(-fifth);

const ok = samples.filter((s) => s.status >= 200 && s.status < 300).length;
const s429 = samples.filter((s) => s.status === 429).length;
const s5xx = samples.filter((s) => s.status >= 500).length;
const errors = samples.filter((s) => s.status === 0).length;

console.log(`\n${n} requests in ${wallS.toFixed(1)}s = ${(n / wallS).toFixed(0)} req/s sustained`);
console.log(`outcomes: ${ok} ok, ${s429} rate-limited, ${s5xx} 5xx, ${errors} network errors`);
console.log(`overall latency: ${stats(samples)}`);
console.log(`first 20%:      ${stats(early)}`);
console.log(`last 20%:       ${stats(late)}`);

const earlyP95 = pct(early.map((r) => r.ms).sort((a, b) => a - b), 95);
const lateP95 = pct(late.map((r) => r.ms).sort((a, b) => a - b), 95);
const drift = lateP95 / earlyP95;

let failed = 0;
const invariant = (name, cond, detail) => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};
console.log('');
invariant('no 5xx under sustained load', s5xx === 0, `${s5xx}`);
invariant('no network errors', errors === 0, `${errors}`);
invariant('p95 does not degrade over the run (<2x drift)', drift < 2, `${earlyP95.toFixed(1)}ms -> ${lateP95.toFixed(1)}ms (${drift.toFixed(2)}x)`);

process.exit(failed > 0 ? 1 : 0);
