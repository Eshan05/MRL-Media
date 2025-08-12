// Local scale smoke with fixed arrival schedule.
//
// This is not a capacity claim: one Node client, loopback network, one redis,
// one machine scheduler. It is useful for regression checks because requests
// are planned at a fixed arrival rate and latency is measured from planned
// send time -> response end, so local stalls are not hidden by closed-loop
// "wait for response, then send next" behavior.
//
// Requires API with TRUST_PROXY=1:
//   TRUST_PROXY=1 PORT=3211 tsx src/api/server.ts
//   node scripts/local-scale.mjs [baseUrl] [rate=200] [durationS=30] [maxInFlight=1000]
//
// Optional:
//   UPLOAD_EVERY=25  one upload per N arrivals (0 disables uploads)
//   IP_POOL=200      rotate source IPs; keep per-IP volume below layer 1

import { setTimeout as sleep } from 'node:timers/promises';
import { adminUsers } from './_helpers.mjs';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const BASE = args[0] ?? 'http://127.0.0.1:3211';
const RATE = Number(args[1] ?? 200);
const DURATION_S = Number(args[2] ?? 30);
const MAX_IN_FLIGHT = Number(args[3] ?? 1_000);
const UPLOAD_EVERY = Number(process.env.UPLOAD_EVERY ?? 25);
const IP_POOL = Number(process.env.IP_POOL ?? Math.max(64, Math.ceil((RATE * 60) / 80)));
const TOTAL = Math.floor(RATE * DURATION_S);
const PERIOD_MS = 1_000 / RATE;
const run = Date.now();

if (
  !Number.isFinite(RATE) ||
  !Number.isFinite(DURATION_S) ||
  !Number.isFinite(MAX_IN_FLIGHT) ||
  RATE <= 0 ||
  DURATION_S <= 0 ||
  MAX_IN_FLIGHT <= 0
) {
  console.error('usage: node scripts/local-scale.mjs [baseUrl] [rate=200] [durationS=30] [maxInFlight=1000]');
  process.exit(2);
}

/** @type {{status: number, layer?: string, plannedMs: number, startLagMs: number, at: number}[]} */
const samples = [];
let inFlight = 0;
let maxInFlight = 0;
let clientDrops = 0;

function ipFor(i) {
  const n = i % IP_POOL;
  return `10.60.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}

function form() {
  const fd = new FormData();
  fd.append('file', new File(['scale'], 'scale.txt', { type: 'text/plain' }));
  return fd;
}

// pool of pre-minted uploaders — uploads round-robin so no single user's
// bucket is the accidental bottleneck
const UPLOADER_POOL = UPLOAD_EVERY > 0 ? await adminUsers(BASE, 64, { name: 'scale' }) : [];

async function hit(i, dueAt, startedAt) {
  const isUpload = UPLOAD_EVERY > 0 && i % UPLOAD_EVERY === 0;
  const headers = { 'x-forwarded-for': ipFor(i) };
  if (isUpload) headers.authorization = `Bearer ${UPLOADER_POOL[(i / UPLOAD_EVERY) % UPLOADER_POOL.length | 0].apiKey}`;

  try {
    const res = await fetch(`${BASE}${isUpload ? '/upload' : '/health'}`, {
      method: isUpload ? 'POST' : 'GET',
      headers,
      body: isUpload ? form() : undefined,
    });
    let layer;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      const json = await res.json().catch(() => ({}));
      layer = json.layer;
    } else {
      await res.arrayBuffer();
    }
    samples.push({
      status: res.status,
      layer,
      plannedMs: performance.now() - dueAt,
      startLagMs: startedAt - dueAt,
      at: Date.now(),
    });
  } catch {
    samples.push({
      status: 0,
      layer: 'network-error',
      plannedMs: performance.now() - dueAt,
      startLagMs: startedAt - dueAt,
      at: Date.now(),
    });
  } finally {
    inFlight--;
  }
}

function pct(values, p) {
  if (values.length === 0) return 0;
  const xs = [...values].sort((a, b) => a - b);
  return xs[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
}

function stats(rows, field) {
  const xs = rows.map((r) => r[field]);
  return `p50=${pct(xs, 50).toFixed(1)}ms p95=${pct(xs, 95).toFixed(1)}ms p99=${pct(xs, 99).toFixed(1)}ms max=${pct(xs, 100).toFixed(1)}ms`;
}

console.log(
  `local scale: ${RATE}/s for ${DURATION_S}s -> ${BASE} (${TOTAL} arrivals, maxInFlight=${MAX_IN_FLIGHT}, uploadEvery=${UPLOAD_EVERY}, ipPool=${IP_POOL})`,
);

const started = performance.now();
for (let i = 0; i < TOTAL; i++) {
  const dueAt = started + i * PERIOD_MS;
  const waitMs = dueAt - performance.now();
  if (waitMs > 0) await sleep(waitMs);

  const startedAt = performance.now();
  if (inFlight >= MAX_IN_FLIGHT) {
    clientDrops++;
    samples.push({ status: -1, layer: 'client-drop', plannedMs: startedAt - dueAt, startLagMs: startedAt - dueAt, at: Date.now() });
    continue;
  }
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  void hit(i, dueAt, startedAt);
}

while (inFlight > 0) await sleep(25);
const wallS = (performance.now() - started) / 1000;

const byStatus = new Map();
const byLayer = new Map();
for (const r of samples) {
  byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  if (r.layer) byLayer.set(r.layer, (byLayer.get(r.layer) ?? 0) + 1);
}

const sorted = [...samples].sort((a, b) => a.at - b.at);
const fifth = Math.max(1, Math.floor(sorted.length / 5));
const early = sorted.slice(0, fifth);
const late = sorted.slice(-fifth);
const earlyP95 = pct(early.map((r) => r.plannedMs), 95);
const lateP95 = pct(late.map((r) => r.plannedMs), 95);
const drift = earlyP95 === 0 ? 0 : lateP95 / earlyP95;
const s5xx = samples.filter((s) => s.status >= 500).length;
const s429 = samples.filter((s) => s.status === 429).length;
const net = samples.filter((s) => s.status === 0).length;

console.log(`\ncompleted ${samples.length - clientDrops}/${TOTAL} in ${wallS.toFixed(1)}s = ${((samples.length - clientDrops) / wallS).toFixed(0)} completed/s`);
console.log(`max in-flight client requests: ${maxInFlight}`);
console.log(`status: ${[...byStatus.entries()].map(([k, v]) => `${k}:${v}`).join(' ')}`);
console.log(`layers: ${[...byLayer.entries()].map(([k, v]) => `${k}:${v}`).join(' ') || '-'}`);
console.log(`planned latency: ${stats(samples.filter((s) => s.status !== -1), 'plannedMs')}`);
console.log(`start lag:        ${stats(samples, 'startLagMs')}`);
console.log(`first 20% p95 -> last 20% p95: ${earlyP95.toFixed(1)}ms -> ${lateP95.toFixed(1)}ms (${drift.toFixed(2)}x)`);

let failed = 0;
function invariant(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

console.log('');
invariant('client kept up with planned arrivals', clientDrops === 0, `drops=${clientDrops}`);
invariant('no network errors', net === 0, `${net}`);
invariant('no 5xx', s5xx === 0, `${s5xx}`);
invariant('no unintended 429s', s429 === 0, `${s429}`);
invariant('p95 did not drift above 2x', drift < 2, `${drift.toFixed(2)}x`);

process.exit(failed > 0 ? 1 : 0);
