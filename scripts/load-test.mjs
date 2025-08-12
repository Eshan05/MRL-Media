// Load test — LEARNING.md wiring step 6, the victory lap.
// Simulates ~100 users in four personas and checks that every limiter
// layer fires for the abusers and never for the polite majority.
//
// Requires an API started with TRUST_PROXY=1 + ADMIN_KEY (so simulated
// users can be minted at age 30d → trust 1.0), the worker, and redis:
//   TRUST_PROXY=1 ADMIN_KEY=dev-admin PORT=3210 tsx src/api/server.ts
//   node scripts/load-test.mjs http://localhost:3210

import { adminUsers } from './_helpers.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3210';

const POLITE = 85;
const AGGRESSIVE = 10;
const BURST = 3;
const BOTNET = 5;

/** @type {{persona: string, status: number, layer?: string, ms: number}[]} */
const results = [];
const trustFinal = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileForm(content = 'load-test payload') {
  const fd = new FormData();
  fd.append('file', new File([content], 'load.txt', { type: 'text/plain' }));
  return fd;
}

async function hit(persona, path, { method = 'GET', headers = {}, body } = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, { method, headers, body });
    let json = {};
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      json = await res.json().catch(() => ({}));
    } else {
      await res.arrayBuffer(); // drain
    }
    const entry = {
      persona,
      status: res.status,
      layer: json.layer,
      trust: res.headers.get('x-rl-trust'),
      ms: performance.now() - t0,
    };
    results.push(entry);
    return entry;
  } catch {
    results.push({ persona, status: 0, layer: 'network-error', ms: performance.now() - t0 });
    return { status: 0 };
  }
}

// mint all simulated users up front (age 30d → deterministic trust 1.0)
console.log(`minting ${POLITE + AGGRESSIVE + BURST} users via admin api...`);
const politeUsers = await adminUsers(BASE, POLITE, { name: 'polite' });
const aggressiveUsers = await adminUsers(BASE, AGGRESSIVE, { name: 'aggressive' });
const burstUsers = await adminUsers(BASE, BURST, { name: 'burst' });

// ---- personas -------------------------------------------------------------

/** stays well inside every limit; must never see a 429 */
async function polite(i) {
  const headers = {
    authorization: `Bearer ${politeUsers[i].apiKey}`,
    'x-forwarded-for': `10.1.${Math.floor(i / 250)}.${(i % 250) + 1}`,
  };
  await sleep(Math.random() * 2_000); // staggered arrival
  for (let k = 0; k < 2; k++) {
    await hit('polite', '/upload', { method: 'POST', headers, body: fileForm() });
    await hit('polite', '/health', { headers });
    await sleep(2_000 + Math.random() * 3_000);
  }
}

/** hammers 15 sequential uploads — token bucket, then trust decay drags the sliding window down */
async function aggressive(i) {
  const headers = {
    authorization: `Bearer ${aggressiveUsers[i].apiKey}`,
    'x-forwarded-for': `10.2.0.${i + 1}`,
  };
  await sleep(Math.random() * 1_000);
  let last;
  for (let k = 0; k < 15; k++) {
    last = await hit('aggressive', '/upload', { method: 'POST', headers, body: fileForm() });
  }
  if (last?.trust) trustFinal.push(Number(last.trust));
}

/** 8 uploads in parallel — free tier allows 2 in flight */
async function burst(i) {
  const headers = {
    authorization: `Bearer ${burstUsers[i].apiKey}`,
    'x-forwarded-for': `10.3.0.${i + 1}`,
  };
  await sleep(500 + Math.random() * 1_000);
  await Promise.all(
    Array.from({ length: 8 }, () => hit('burst', '/upload', { method: 'POST', headers, body: fileForm() })),
  );
}

/** five clients behind ONE ip, 40 hits each — the coarse per-IP wall */
async function botnet() {
  const headers = { 'x-forwarded-for': '10.9.9.9' };
  await sleep(Math.random() * 500);
  for (let k = 0; k < 40; k++) {
    await hit('botnet', '/health', { headers });
  }
}

// ---- run ------------------------------------------------------------------

console.log(`load test → ${BASE}`);
console.log(`personas: ${POLITE} polite, ${AGGRESSIVE} aggressive, ${BURST} burst, ${BOTNET} botnet (shared ip)\n`);
const t0 = performance.now();

await Promise.all([
  ...Array.from({ length: POLITE }, (_, i) => polite(i)),
  ...Array.from({ length: AGGRESSIVE }, (_, i) => aggressive(i)),
  ...Array.from({ length: BURST }, (_, i) => burst(i)),
  ...Array.from({ length: BOTNET }, () => botnet()),
]);

const wallMs = performance.now() - t0;

// ---- report ---------------------------------------------------------------

const personas = ['polite', 'aggressive', 'burst', 'botnet'];
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];

console.log('persona     total  2xx   429   other  |  429 layers');
for (const p of personas) {
  const rs = results.filter((r) => r.persona === p);
  const s2 = rs.filter((r) => r.status >= 200 && r.status < 300).length;
  const s429 = rs.filter((r) => r.status === 429).length;
  const other = rs.length - s2 - s429;
  const layers = {};
  for (const r of rs) if (r.status === 429 && r.layer) layers[r.layer] = (layers[r.layer] ?? 0) + 1;
  const layerStr = Object.entries(layers).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
  console.log(
    `${p.padEnd(11)} ${String(rs.length).padEnd(6)} ${String(s2).padEnd(5)} ${String(s429).padEnd(5)} ${String(other).padEnd(6)} |  ${layerStr}`,
  );
}

const lat = results.map((r) => r.ms).sort((a, b) => a - b);
console.log(
  `\n${results.length} requests in ${(wallMs / 1000).toFixed(1)}s ` +
    `(${(results.length / (wallMs / 1000)).toFixed(0)} req/s) — ` +
    `latency p50=${pct(lat, 50).toFixed(0)}ms p95=${pct(lat, 95).toFixed(0)}ms max=${pct(lat, 100).toFixed(0)}ms`,
);
if (trustFinal.length > 0) {
  console.log(`aggressive users' final trust: ${trustFinal.map((t) => t.toFixed(2)).join(', ')}`);
}

// ---- invariants -----------------------------------------------------------

let failed = 0;
function invariant(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const politeRs = results.filter((r) => r.persona === 'polite');
const layerCount = (name) => results.filter((r) => r.layer === name).length;

console.log('');
invariant('polite users never rate limited', politeRs.every((r) => r.status !== 429));
invariant('no 5xx anywhere', results.every((r) => r.status < 500), `worst=${Math.max(...results.map((r) => r.status))}`);
invariant('no network errors', results.every((r) => r.status !== 0));
invariant('layer 1 fired (botnet)', layerCount('fixed-window-ip') > 0, `${layerCount('fixed-window-ip')}x`);
invariant('layer 2 fired (aggressive, via trust decay)', layerCount('sliding-window-user') > 0, `${layerCount('sliding-window-user')}x`);
invariant('layer 3 fired (aggressive)', layerCount('token-bucket-upload') > 0, `${layerCount('token-bucket-upload')}x`);
invariant('layer 4 fired (burst)', layerCount('concurrency-upload') > 0, `${layerCount('concurrency-upload')}x`);
invariant('trust dropped for aggressive users', trustFinal.length > 0 && trustFinal.every((t) => t < 1));

const health = await fetch(`${BASE}/health`, { headers: { 'x-forwarded-for': '10.0.0.99' } });
invariant('server healthy after the storm', health.status === 200);

process.exit(failed > 0 ? 1 : 0);
