// Layer attribution matrix — proves WHICH layer catches WHICH behavior.
// Every scenario uses a fresh user so nothing leaks between rows, and each
// row asserts the exact blocking layer, not just "a 429 happened".
//
// Requires api with TRUST_PROXY=1 + ADMIN_KEY, worker, redis:
//   TRUST_PROXY=1 ADMIN_KEY=dev-admin PORT=3210 tsx src/api/server.ts
//   node scripts/layer-matrix.mjs http://127.0.0.1:3210

import { createServer } from 'node:http';
import { adminUser } from './_helpers.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3210';
const run = Date.now();
let scenarioN = 0;
const rows = [];

function verdict(scenario, action, expected, observed, ok) {
  rows.push({ scenario, action, expected, observed, ok });
}

function form(bytes = 16) {
  const fd = new FormData();
  fd.append('file', new File([Buffer.alloc(bytes, 120)], 'm.txt', { type: 'text/plain' }));
  return fd;
}

async function upload({ key, ip, hook, bytes }) {
  const headers = {
    authorization: `Bearer ${key}`,
    'x-forwarded-for': ip ?? `10.50.${scenarioN}.1`,
  };
  if (hook) headers['x-webhook-url'] = hook;
  const res = await fetch(`${BASE}/upload`, { method: 'POST', headers, body: form(bytes) });
  let json = {};
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, layer: json.layer ?? null, trust: res.headers.get('x-rl-trust') };
}

// ── S1: within limits → untouched ──────────────────────────────────────────
{
  scenarioN = 1;
  const { apiKey } = await adminUser(BASE, { name: `s1-${run}` });
  const rs = [];
  for (let i = 0; i < 5; i++) rs.push(await upload({ key: apiKey }));
  const ok = rs.every((r) => r.status === 201);
  verdict('S1', '5 rapid sequential uploads (= bucket size)', 'all 201, no layer', `${rs.filter((r) => r.status === 201).length}x201`, ok);
}

// ── S2: 6th rapid upload → token bucket, and ONLY token bucket ─────────────
{
  scenarioN = 2;
  const { apiKey } = await adminUser(BASE, { name: `s2-${run}` });
  for (let i = 0; i < 5; i++) await upload({ key: apiKey });
  const sixth = await upload({ key: apiKey });
  const ok = sixth.status === 429 && sixth.layer === 'token-bucket-upload';
  verdict('S2', '6th rapid upload', '429 token-bucket-upload', `${sixth.status} ${sixth.layer}`, ok);
}

// ── S3: parallel uploads, free tier → concurrency, NOT token bucket ────────
{
  scenarioN = 3;
  const { apiKey } = await adminUser(BASE, { name: `s3-${run}` });
  // 4 parallel 8MB bodies: within the 5-token budget, above the 2-slot cap
  const rs = await Promise.all(Array.from({ length: 4 }, () => upload({ key: apiKey, bytes: 8 * 1024 * 1024 })));
  const created = rs.filter((r) => r.status === 201).length;
  const cc = rs.filter((r) => r.layer === 'concurrency-upload').length;
  const tb = rs.filter((r) => r.layer === 'token-bucket-upload').length;
  const ok = cc >= 1 && tb === 0 && created >= 2;
  verdict('S3', 'free: 4 parallel 8MB uploads', '≥1 concurrency-upload, 0 token-bucket', `${created}x201 cc:${cc} tb:${tb}`, ok);
}

// ── S4: same behavior, pro tier → no blocking (5 slots) ────────────────────
{
  scenarioN = 4;
  const { apiKey } = await adminUser(BASE, { name: `s4-${run}`, tier: 'pro' });
  const rs = await Promise.all(Array.from({ length: 4 }, () => upload({ key: apiKey, bytes: 8 * 1024 * 1024 })));
  const ok = rs.every((r) => r.status === 201);
  verdict('S4', 'pro: same 4 parallel uploads', 'all 201', `${rs.filter((r) => r.status === 201).length}x201`, ok);
}

// ── S5: sustained hammering → exact three-phase cascade ────────────────────
{
  scenarioN = 5;
  const { apiKey } = await adminUser(BASE, { name: `s5-${run}` });
  const layers = [];
  let lastTrust = null;
  for (let i = 0; i < 15; i++) {
    const r = await upload({ key: apiKey });
    layers.push(r.status === 201 ? '201' : r.layer);
    lastTrust = r.trust;
  }
  const phase1 = layers.slice(0, 5).every((l) => l === '201');
  const phase2 = layers.slice(5, 10).every((l) => l === 'token-bucket-upload');
  const phase3 = layers.slice(10).every((l) => l === 'sliding-window-user');
  verdict(
    'S5',
    '15 sequential uploads (hammering)',
    '1-5: 201 · 6-10: token-bucket · 11-15: sliding-window (trust decay)',
    `phases=${phase1}/${phase2}/${phase3} trust=${lastTrust}`,
    phase1 && phase2 && phase3,
  );
}

// ── S6: IP flood → layer 1 hits everyone behind that IP, before auth ───────
{
  scenarioN = 6;
  const ip = `10.66.6.${run % 250}`;
  for (let i = 0; i < 110; i++) {
    await fetch(`${BASE}/health`, { headers: { 'x-forwarded-for': ip } });
  }
  // innocent authenticated user behind the SAME ip — collateral damage
  const innocent = await adminUser(BASE, { name: `s6a-${run}` });
  const collateral = await upload({ key: innocent.apiKey, ip });
  // identical user on a different ip — untouched
  const elsewhere = await adminUser(BASE, { name: `s6b-${run}` });
  const fine = await upload({ key: elsewhere.apiKey, ip: '10.77.7.7' });
  const ok = collateral.status === 429 && collateral.layer === 'fixed-window-ip' && fine.status === 201;
  verdict(
    'S6',
    '110 hits from one IP, then innocent user on same IP',
    'innocent blocked by fixed-window-ip (before auth!), other IP fine',
    `sameIP=${collateral.status} ${collateral.layer} · otherIP=${fine.status}`,
    ok,
  );
}

// ── S7: abuser and neighbor at the same time → per-user isolation ──────────
{
  scenarioN = 7;
  const abuser = await adminUser(BASE, { name: `s7a-${run}` });
  const neighbor = await adminUser(BASE, { name: `s7b-${run}` });
  const [abused, polite1, polite2] = await Promise.all([
    (async () => {
      const rs = [];
      for (let i = 0; i < 10; i++) rs.push(await upload({ key: abuser.apiKey, ip: '10.88.8.1' }));
      return rs;
    })(),
    upload({ key: neighbor.apiKey, ip: '10.88.8.2' }),
    upload({ key: neighbor.apiKey, ip: '10.88.8.2' }),
  ]);
  const abuserBlocked = abused.some((r) => r.status === 429);
  const ok = abuserBlocked && polite1.status === 201 && polite2.status === 201;
  verdict('S7', 'abuser hammers while neighbor uploads 2', 'abuser 429s, neighbor all 201', `abuser429=${abuserBlocked} neighbor=${polite1.status},${polite2.status}`, ok);
}

// ── S8: webhook pacing is per destination host ──────────────────────────────
{
  scenarioN = 8;
  const portA = 45700 + (run % 50);
  const portB = portA + 1;
  const mkReceiver = (port, hits) => new Promise((resolve) => {
    const s = createServer((req, res) => { hits.push(Date.now()); res.end('ok'); });
    s.listen(port, () => resolve(s));
  });
  const hitsA = []; const hitsB = [];
  const [srvA, srvB] = await Promise.all([mkReceiver(portA, hitsA), mkReceiver(portB, hitsB)]);

  // pro tier: 10 transcode slots, so all 4 jobs process immediately and the
  // webhook enqueues stay simultaneous — free tier's 3 slots would park the
  // 4th job 2s (layer 4b) and stagger exactly what this scenario measures
  const { apiKey } = await adminUser(BASE, { name: `s8-${run}`, tier: 'pro' });
  // warm the pipeline so cold-start latency doesn't stagger the enqueues
  await upload({ key: apiKey });
  for (let i = 0; i < 3; i++) await upload({ key: apiKey, hook: `http://127.0.0.1:${portA}/h` });
  await upload({ key: apiKey, hook: `http://127.0.0.1:${portB}/h` });

  const deadline = Date.now() + 20_000;
  while ((hitsA.length < 3 || hitsB.length < 1) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  srvA.close(); srvB.close();

  const gapA = hitsA.length === 3 ? hitsA[2] - hitsA[0] : -1;
  const bIndependent = hitsB.length === 1 && hitsA.length >= 1 && hitsB[0] - Math.min(...hitsA, hitsB[0]) < 1_500;
  const ok = hitsA.length === 3 && gapA >= 1_500 && bIndependent;
  verdict(
    'S8',
    '3 webhooks → host A, 1 → host B, simultaneously',
    'A paced (3rd ≥1.5s after 1st), B delivered immediately — independent buckets',
    `A=${hitsA.length} spread=${gapA}ms · B immediate=${bIndependent}`,
    ok,
  );
}

// ── report ──────────────────────────────────────────────────────────────────
console.log('\n#   action                                       expected → observed');
for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.scenario}  ${r.action}`);
  console.log(`        expected: ${r.expected}`);
  console.log(`        observed: ${r.observed}\n`);
}
const failed = rows.filter((r) => !r.ok).length;
console.log(`${rows.length - failed}/${rows.length} scenarios attributed correctly`);
process.exit(failed > 0 ? 1 : 0);
