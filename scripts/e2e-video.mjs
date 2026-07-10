// Video worker smoke: generate a tiny mp4 with ffmpeg, upload it, and verify
// worker outputs include a web mp4 plus poster thumbnail.
//
// Requires API + worker + redis:
//   ADMIN_KEY=dev-admin WEBHOOK_ALLOW_PRIVATE=1 PORT=3210 tsx src/api/server.ts
//   WEBHOOK_ALLOW_PRIVATE=1 tsx src/worker/index.ts
//   node scripts/e2e-video.mjs http://127.0.0.1:3210

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { adminUser } from './_helpers.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3210';
const tmp = resolve('.scale-tmp/video-smoke.mp4');
mkdirSync(resolve('.scale-tmp'), { recursive: true });

const ff = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x120:rate=10:duration=1',
    '-pix_fmt',
    'yuv420p',
    tmp,
  ],
  { stdio: 'inherit' },
);
if (ff.status !== 0) throw new Error('failed to generate test video with ffmpeg');

const { apiKey } = await adminUser(BASE, { name: `video-${Date.now()}`, tier: 'pro' });
const fd = new FormData();
fd.append('file', new File([readFileSync(tmp)], 'video-smoke.mp4', { type: 'video/mp4' }));
const upload = await fetch(`${BASE}/api/v1/uploads`, {
  method: 'POST',
  headers: { authorization: `Bearer ${apiKey}` },
  body: fd,
});
const body = await upload.json();
if (upload.status !== 202) throw new Error(`upload failed: ${upload.status} ${JSON.stringify(body)}`);

const deadline = Date.now() + 30_000;
let job;
while (Date.now() < deadline) {
  const res = await fetch(`${BASE}/api/v1/jobs/${body.id}`, { headers: { authorization: `Bearer ${apiKey}` } });
  job = await res.json();
  if (job.state === 'completed') break;
  if (job.state === 'failed') throw new Error(`transcode failed: ${job.failedReason}`);
  await sleep(300);
}

const outputs = job?.outputs ?? [];
const hasPoster = outputs.some((o) => o.kind === 'thumb' && o.file.endsWith('.webp'));
const hasVideo = outputs.some((o) => o.kind === 'video' && o.file.endsWith('.mp4'));
console.log(`video outputs: ${outputs.map((o) => `${o.kind}:${o.file}:${o.bytes}B`).join(', ')}`);
if (!hasPoster || !hasVideo) throw new Error('expected thumb webp and video mp4 outputs');
