// Slow scenarios — the two layer proofs that need real wall-clock time.
//
// S9: layer 2 fires at FULL trust. The bucket's 60s throughput is
//     burst 5 + refill 30 = 35/min, which exceeds the sliding cap of
//     30/min — so paced traffic that never violates the bucket must
//     eventually be blocked by the sliding window, with trust still 1.000.
//     (~60s runtime; waits for a window boundary to be deterministic.)
//
// S10: layer 5's failure path — a receiver that 500s twice then accepts.
//      BullMQ retries with exponential backoff (1s, 2s), GCRA's burst
//      absorbs the retries, delivery eventually lands.
//
//   TRUST_PROXY=1 ADMIN_KEY=dev-admin PORT=3210 tsx src/api/server.ts   (+ worker)
//   node scripts/matrix-slow.mjs http://127.0.0.1:3210

import { createServer } from 'node:http';
import { adminUser } from './_helpers.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3210';
const run = Date.now();
const results = [];
const report = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function form() {
  const fd = new FormData();
  fd.append('file', new File(['slow'], 'w.txt', { type: 'text/plain' }));
  return fd;
}

async function upload(key, extra = {}) {
  const res = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'x-forwarded-for': '10.55.0.1', ...extra },
    body: form(),
  });
  let json = {};
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, layer: json.layer ?? null, trust: res.headers.get('x-rl-trust') };
}

// ── S9: sliding window at full trust ────────────────────────────────────────
{
  const WINDOW = 60_000;
  // start right after a window boundary so the whole run lives in one window
  const intoWindow = Date.now() % WINDOW;
  const wait = (WINDOW - intoWindow + 200) % WINDOW;
  console.log(`S9: waiting ${(wait / 1000).toFixed(1)}s for a window boundary, then ~55s of paced uploads...`);
  const { apiKey } = await adminUser(BASE, { name: `s9-${run}` });
  await sleep(wait);

  let blocked = null;
  let attempts = 0;

  // burst 5 (bucket capacity), then pace at 2.05s (just under refill rate,
  // so the bucket never blocks and no violation ever decays trust)
  for (let i = 0; i < 5; i++) {
    attempts++;
    await upload(apiKey);
  }
  while (attempts < 40 && blocked === null) {
    await sleep(2_050);
    attempts++;
    const r = await upload(apiKey);
    if (r.status === 429) blocked = { ...r, attempt: attempts };
  }

  const ok =
    blocked !== null &&
    blocked.layer === 'sliding-window-user' &&
    blocked.trust === '1.000';
  report(
    'S9 layer 2 fires standalone at full trust (paced 35/min vs cap 30/min)',
    ok,
    blocked
      ? `blocked at attempt ${blocked.attempt} by ${blocked.layer}, trust=${blocked.trust} (no decay involved)`
      : `never blocked in ${attempts} attempts`,
  );
}

// ── S10: webhook retry with backoff after receiver failures ────────────────
{
  const port = 45800 + (run % 100);
  const hits = [];
  const receiver = createServer((req, res) => {
    hits.push(Date.now());
    if (hits.length <= 2) {
      res.statusCode = 500; // fail the first two attempts
      res.end('nope');
    } else {
      res.end('ok');
    }
  });
  await new Promise((r) => receiver.listen(port, r));

  const { apiKey } = await adminUser(BASE, { name: `s10-${run}` });
  const r = await upload(apiKey, { 'x-webhook-url': `http://127.0.0.1:${port}/h` });
  if (r.status !== 201) {
    receiver.close();
    report('S10 webhook retry path', false, `upload failed: ${r.status}`);
  } else {
    const deadline = Date.now() + 25_000;
    while (hits.length < 3 && Date.now() < deadline) await sleep(200);
    await sleep(3_000); // ensure no spurious 4th delivery
    receiver.close();

    const gaps = hits.slice(1).map((t, i) => t - hits[i]);
    const ok =
      hits.length === 3 && // exactly 3 attempts: fail, fail, success
      gaps[0] >= 800 && gaps[0] <= 2_600 && // backoff ~1s (+ gcra tolerance)
      gaps[1] >= 1_700 && gaps[1] <= 4_500; // backoff ~2s
    report(
      'S10 layer 5 failure path: 500,500 then delivered, exponential backoff',
      ok,
      `attempts=${hits.length} gaps=${gaps.join('ms, ')}ms (expected ~1000ms, ~2000ms)`,
    );
  }
}

console.log(`${results.filter(Boolean).length}/${results.length} slow scenarios passed`);
process.exit(results.every(Boolean) ? 0 : 1);
