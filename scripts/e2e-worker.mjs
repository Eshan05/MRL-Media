// End-to-end worker verification: uploads real images, waits for the
// transcodes, downloads a derivative, and measures webhook pacing.
// Requires the api (ADMIN_KEY set), the worker (WEBHOOK_ALLOW_PRIVATE=1),
// and redis:
//   node scripts/e2e-worker.mjs [baseUrl]
import { createServer } from 'node:http';
import sharp from 'sharp';
import { adminUser } from './_helpers.mjs';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const results = [];
const report = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
};

// tiny webhook receiver so GCRA pacing is measurable
const hits = [];
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hits.push({ at: Date.now(), body });
    res.end('ok');
  });
});
await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
const HOOK_PORT = receiver.address().port;

const { apiKey } = await adminUser(BASE, { name: `e2e-${Date.now()}` });
const auth = { authorization: `Bearer ${apiKey}` };

// 4 real PNGs, distinct colors
const ids = [];
for (let i = 0; i < 4; i++) {
  const png = await sharp({
    create: { width: 900, height: 700, channels: 3, background: { r: 60 * i, g: 120, b: 200 - 40 * i } },
  })
    .png()
    .toBuffer();
  const fd = new FormData();
  fd.append('file', new File([png], `pic-${i}.png`, { type: 'image/png' }));
  const res = await fetch(`${BASE}/api/v1/uploads`, {
    method: 'POST',
    headers: { ...auth, 'x-webhook-url': `http://127.0.0.1:${HOOK_PORT}/hook` },
    body: fd,
  });
  const json = await res.json();
  if (res.status === 202) ids.push(json.id);
  else console.log(`  upload ${i}: ${res.status} ${JSON.stringify(json)}`);
}
report('4 image uploads -> 202', ids.length === 4, `got ${ids.length}`);

async function waitDone(id, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(`${BASE}/api/v1/jobs/${id}`, { headers: auth });
    const json = await res.json();
    if (json.state === 'completed') return json;
    if (json.state === 'failed') throw new Error(`job failed: ${json.failedReason}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timeout waiting for transcode');
}

let outputsOk = ids.length === 4;
let firstOutputs = null;
for (const id of ids) {
  try {
    const job = await waitDone(id);
    if (!job.outputs || job.outputs.length !== 2) outputsOk = false;
    firstOutputs ??= job.outputs;
  } catch (e) {
    outputsOk = false;
    console.log(`  job ${id}: ${e.message}`);
  }
}
report(
  'all transcodes completed with thumb+web',
  outputsOk,
  firstOutputs ? firstOutputs.map((o) => o.file).join(', ') : 'n/a',
);

if (firstOutputs) {
  const dl = await fetch(`${BASE}${firstOutputs[0].url}`, { headers: auth });
  const bytes = (await dl.arrayBuffer()).byteLength;
  report(
    'thumb downloadable as image/webp (owner)',
    dl.status === 200 && dl.headers.get('content-type') === 'image/webp' && bytes > 0,
    `got ${dl.status} ${dl.headers.get('content-type')} ${bytes}B`,
  );

  // ACL: another user gets 404 for the same file, not 403 — no existence leak
  const stranger = await adminUser(BASE, { name: `e2e-stranger-${Date.now()}` });
  const denied = await fetch(`${BASE}${firstOutputs[0].url}`, {
    headers: { authorization: `Bearer ${stranger.apiKey}` },
  });
  report('ACL: stranger gets 404 on the same file', denied.status === 404, `got ${denied.status}`);

  const anon = await fetch(`${BASE}${firstOutputs[0].url}`);
  report('ACL: anonymous gets 401', anon.status === 401, `got ${anon.status}`);

  const shared = await fetch(`${BASE}${firstOutputs[0].url.replace('/files/', '/media/')}`);
  report(
    'public media route is anonymous-readable',
    shared.status === 200 && shared.headers.get('content-type') === 'image/webp',
    `got ${shared.status} ${shared.headers.get('content-type')}`,
  );
}

// webhook pacing: burst 2, then one per 2s
const deadline = Date.now() + 30_000;
while (hits.length < 4 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
}
report('4 webhooks delivered', hits.length === 4, `got ${hits.length}`);

if (hits.length === 4) {
  const t = hits.map((h) => h.at);
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  const total = t[3] - t[0];
  // With burst=2, any three deliveries to the same receiver must span about
  // one interval; the first two do not have to arrive at the exact same time.
  const windowA = t[2] - t[0];
  const windowB = t[3] - t[1];
  const paced = windowA >= 1500 && windowB >= 1500 && total >= 3400;
  report(
    'GCRA spacing respected',
    paced,
    `gaps=${gaps.join(',')}ms windows=${windowA},${windowB}ms total=${total}ms`,
  );

  const evt = JSON.parse(hits[0].body);
  report(
    'payload shape correct',
    evt.event === 'media.processed' && Array.isArray(evt.outputs) && evt.outputs.length === 2,
    `event=${evt.event} outputs=${evt.outputs?.length}`,
  );
}

receiver.close();
process.exit(results.every(Boolean) ? 0 : 1);
