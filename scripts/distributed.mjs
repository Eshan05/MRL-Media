// Distributed correctness — the reason limiter state lives in redis at all.
// Run several API instances against ONE redis (and one sqlite file) and
// prove the limits hold globally, not per instance.
//
//   TRUST_PROXY=1 ADMIN_KEY=dev-admin PORT=3211 tsx src/api/server.ts   (and 3212, 3213)
//   node scripts/distributed.mjs http://127.0.0.1:3211,http://127.0.0.1:3212,http://127.0.0.1:3213

import { adminUser } from './_helpers.mjs';

const BASES = (process.argv[2] ?? 'http://127.0.0.1:3211,http://127.0.0.1:3212,http://127.0.0.1:3213').split(',');
const run = Date.now();
const results = [];
const report = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};
const node = (i) => BASES[i % BASES.length];

function form(bytes = 16) {
  const fd = new FormData();
  fd.append('file', new File([Buffer.alloc(bytes, 55)], 'd.txt', { type: 'text/plain' }));
  return fd;
}

async function upload(base, key, { ip, bytes } = {}) {
  const res = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'x-forwarded-for': ip ?? '10.99.1.1' },
    body: form(bytes),
  });
  let json = {};
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, layer: json.layer ?? null, base };
}

console.log(`distributed check across ${BASES.length} instances: ${BASES.join(' ')}\n`);

// D1: sequential round-robin — token bucket is ONE bucket, not one per node
{
  const { apiKey } = await adminUser(BASES[0], { name: `d1-${run}` });
  const rs = [];
  for (let i = 0; i < 10; i++) rs.push(await upload(node(i), apiKey));
  const created = rs.filter((r) => r.status === 201).length;
  const perNode = BASES.map((b) => rs.filter((r) => r.base === b && r.status === 201).length);
  report(
    'D1 one bucket across nodes (sequential round-robin)',
    created === 5,
    `${created}x201 total (per-node were ${perNode.join('/')}; a per-instance bucket would allow 15)`,
  );
}

// D2: parallel across nodes — atomicity holds even under cross-node races
{
  const { apiKey } = await adminUser(BASES[0], { name: `d2-${run}`, tier: 'pro' });
  const rs = await Promise.all(
    Array.from({ length: 9 }, (_, i) => upload(node(i), apiKey)),
  );
  const created = rs.filter((r) => r.status === 201).length;
  report('D2 cross-node races cannot oversell tokens (9 parallel)', created === 5, `${created}x201`);
}

// D3: the semaphore is distributed too — 2 in-flight TOTAL, not per node
{
  const { apiKey } = await adminUser(BASES[0], { name: `d3-${run}` });
  const rs = await Promise.all(
    Array.from({ length: 6 }, (_, i) => upload(node(i), apiKey, { bytes: 8 * 1024 * 1024 })),
  );
  const created = rs.filter((r) => r.status === 201).length;
  const cc = rs.filter((r) => r.layer === 'concurrency-upload').length;
  report(
    'D3 in-flight slots shared across nodes (free=2, 6 parallel)',
    created <= 4 && cc >= 2,
    `${created}x201, concurrency-blocked ${cc} (per-instance slots would allow all 6)`,
  );
}

// D4: fixed window per IP is global — 110 hits round-robin, exactly 100 pass
{
  const ip = `10.99.2.${run % 250}`;
  let passed = 0;
  for (let i = 0; i < 110; i++) {
    const res = await fetch(`${node(i)}/health`, { headers: { 'x-forwarded-for': ip } });
    if (res.status === 200) passed++;
  }
  report('D4 IP window shared across nodes (110 hits, limit 100)', passed === 100, `${passed}x200`);
}

// D5: the full three-phase cascade holds cross-node — sliding window state
// AND the violation tracker are shared, so trust decay computed on one node
// shrinks the limit enforced on every other node
{
  const { apiKey } = await adminUser(BASES[0], { name: `d5-${run}` });
  const layers = [];
  for (let i = 0; i < 15; i++) {
    const r = await upload(node(i), apiKey);
    layers.push(r.status === 201 ? '201' : r.layer);
  }
  const ok =
    layers.slice(0, 5).every((l) => l === '201') &&
    layers.slice(5, 10).every((l) => l === 'token-bucket-upload') &&
    layers.slice(10).every((l) => l === 'sliding-window-user');
  report(
    'D5 three-phase cascade across nodes (shared sliding + violations)',
    ok,
    ok ? '5x201 -> 5xtoken-bucket -> 5xsliding-window, round-robin' : layers.join(','),
  );
}

process.exit(results.every(Boolean) ? 0 : 1);
