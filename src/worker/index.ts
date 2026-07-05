import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { DelayedError, UnrecoverableError, Worker } from 'bullmq';
import sharp from 'sharp';
import { concurrency, createRedis, gcra, type RedisClient } from '../limiter/index.js';
import { createQueueConnection, createWebhookQueue, TRANSCODE_QUEUE, WEBHOOK_QUEUE } from '../jobs/queues.js';
import { POLICY } from '../policy.js';
import { postJsonToWebhook, SsrfError } from '../ssrf.js';
import type { TranscodeJobData, TranscodeOutput, TranscodeResult, WebhookJobData } from '../jobs/types.js';
import { TMP_DIR } from '../paths.js';
import { removeTempFile, storage } from '../storage.js';
import { fileById } from '../db.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

async function jobFileActive(fileId: string, storedAs: string): Promise<boolean> {
  const file = await fileById(fileId);
  return Boolean(file && file.stored_as === storedAs && (file.expires_at === null || file.expires_at > Date.now()));
}

/**
 * Connection silence is how this worker once died undetected: ioredis
 * retrying forever with zero output while jobs piled up. Every connection
 * gets loud lifecycle logging, and startup fails fast if redis is
 * unreachable so a supervisor restarts us instead of us playing dead.
 */
function observe<T extends RedisClient>(conn: T, name: string): T {
  conn.on('connect', () => console.log(`[redis:${name}] connected`));
  conn.on('error', (err: Error) => console.error(`[redis:${name}] ${err.message}`));
  conn.on('close', () => console.warn(`[redis:${name}] closed`));
  return conn;
}

const redis = observe(createRedis(), 'limiter'); // limiter state — separate from BullMQ connections

try {
  await Promise.race([
    redis.ping(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('no PONG within 10s')), 10_000)),
  ]);
  console.log('[startup] redis reachable');
} catch (err) {
  console.error(`[startup] redis unreachable (${(err as Error).message}) — exiting for supervisor restart`);
  process.exit(1);
}

const webhookQueue = createWebhookQueue(observe(createQueueConnection(), 'webhook-queue'));
const webhookGate = gcra(redis, {
  name: 'webhook-egress',
  intervalMs: POLICY.webhook.intervalMs,
  burst: POLICY.webhook.burst,
});

async function warmProcessingPipeline(): Promise<void> {
  try {
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#111827' },
    })
      .webp()
      .toBuffer();
  } catch (err) {
    console.warn(`[warmup] sharp failed: ${(err as Error).message}`);
  }

  try {
    await runFfmpeg(['-version'], 5_000);
  } catch (err) {
    console.warn(`[warmup] ffmpeg unavailable: ${(err as Error).message}`);
  }
}

/** Images get thumb+web; videos get poster+web mp4; anything else is store-only. */
async function makeDerivatives(fileId: string, storedAs: string): Promise<TranscodeOutput[]> {
  const object = await storage.getObject(storedAs);
  if (!object) throw new Error(`object not found: ${storedAs}`);
  const source = await streamToBuffer(object.stream);
  try {
    await sharp(source).metadata();
    return makeImageDerivatives(fileId, source);
  } catch {
    if (!VIDEO_EXTENSIONS.has(path.extname(storedAs).toLowerCase())) return [];
  }

  const src = path.join(TMP_DIR, `${fileId}-source${path.extname(storedAs).toLowerCase()}`);
  await writeFile(src, source);
  try {
    return makeVideoDerivatives(fileId, src);
  } finally {
    await removeTempFile(src);
  }
}

async function makeImageDerivatives(fileId: string, src: Buffer): Promise<TranscodeOutput[]> {
  const variants = [
    { kind: 'thumb', box: 256, quality: 80 },
    { kind: 'web', box: 1280, quality: 85 },
  ] as const;

  const outputs: TranscodeOutput[] = [];
  for (const { kind, box, quality } of variants) {
    const file = `${fileId}-${kind}.webp`;
    const dest = path.join(TMP_DIR, file);
    try {
      await sharp(src)
        .resize(box, box, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toFile(dest);
      const saved = await storage.putFile(file, dest, 'image/webp');
      outputs.push({ kind, file, bytes: saved.bytes, url: `/files/${file}` });
    } finally {
      await removeTempFile(dest);
    }
  }
  return outputs;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function makeVideoDerivatives(fileId: string, src: string): Promise<TranscodeOutput[]> {
  const poster = `${fileId}-thumb.webp`;
  const web = `${fileId}-video.mp4`;
  const posterPath = path.join(TMP_DIR, poster);
  const webPath = path.join(TMP_DIR, web);

  try {
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-ss',
      '0',
      '-i',
      src,
      '-frames:v',
      '1',
      '-vf',
      'scale=480:-2:force_original_aspect_ratio=decrease',
      posterPath,
    ]);

    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-i',
      src,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-vf',
      'scale=1280:-2:force_original_aspect_ratio=decrease',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      webPath,
    ]);

    const [posterInfo, webInfo] = await Promise.all([
      storage.putFile(poster, posterPath, 'image/webp'),
      storage.putFile(web, webPath, 'video/mp4'),
    ]);
    return [
      { kind: 'thumb', file: poster, bytes: posterInfo.bytes, url: `/files/${poster}` },
      { kind: 'video', file: web, bytes: webInfo.bytes, url: `/files/${web}` },
    ];
  } finally {
    await Promise.all([removeTempFile(posterPath), removeTempFile(webPath)]);
  }
}

function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });
  });
}

await mkdir(TMP_DIR, { recursive: true });
await warmProcessingPipeline();

const transcodeWorker = new Worker<TranscodeJobData, TranscodeResult>(
  TRANSCODE_QUEUE,
  async (job, token) => {
    const { fileId, storedAs, userId, tier, webhookUrl, originalName, bytes } = job.data;
    if (!(await jobFileActive(fileId, storedAs))) {
      return { outputs: [] };
    }

    const slots = concurrency(redis, {
      name: 'transcode',
      slots: POLICY.transcode.slots[tier],
      ttlMs: POLICY.transcode.ttlMs,
    });
    const slot = await slots.acquire(userId);
    if (!slot.acquired || slot.holderId === undefined) {
      // user's slots are full — park the job instead of burning a worker
      await job.moveToDelayed(Date.now() + POLICY.transcode.noSlotRetryMs, token);
      throw new DelayedError();
    }

    try {
      const outputs = await makeDerivatives(fileId, storedAs);
      if (!(await jobFileActive(fileId, storedAs))) {
        await Promise.all(outputs.map((output) => storage.deleteObject(output.file)));
        return { outputs: [] };
      }

      if (webhookUrl) {
        await webhookQueue.add(
          'deliver',
          {
            url: webhookUrl,
            payload: {
              event: 'media.processed',
              fileId,
              original: { name: originalName, bytes, url: `/files/${storedAs}` },
              outputs,
              processedAt: new Date().toISOString(),
            },
          },
          {
            attempts: POLICY.webhook.attempts,
            backoff: { type: 'exponential', delay: POLICY.webhook.backoffMs },
            removeOnComplete: { age: 3_600 },
            removeOnFail: { age: 86_400 },
          },
        );
      }

      return { outputs };
    } finally {
      await slots.release(userId, slot.holderId);
    }
  },
  {
    connection: observe(createQueueConnection(), 'transcode-worker'),
    // local parallelism only — per-user fairness is the semaphore's job
    concurrency: 8,
  },
);

const webhookWorker = new Worker<WebhookJobData>(
  WEBHOOK_QUEUE,
  async (job, token) => {
    const host = new URL(job.data.url).host;

    const gate = await webhookGate.check(host);
    if (!gate.allowed) {
      // GCRA tells us the exact millisecond this delivery becomes polite —
      // schedule it for precisely then, no guessing
      await job.moveToDelayed(gate.retryAt, token);
      throw new DelayedError();
    }

    let res;
    try {
      res = await postJsonToWebhook(job.data.url, job.data.payload, {
        allowPrivate: POLICY.webhook.allowPrivate,
      });
    } catch (err) {
      if (err instanceof SsrfError) {
        throw new UnrecoverableError(err.message); // no retries
      }
      throw err;
    }
    if (res.status >= 300 && res.status < 400) {
      throw new UnrecoverableError(`webhook redirects are not allowed (${res.status})`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`destination answered ${res.status}`); // → retry with backoff
    }
    return { status: res.status };
  },
  { connection: observe(createQueueConnection(), 'webhook-worker'), concurrency: 4 },
);

for (const worker of [transcodeWorker, webhookWorker]) {
  worker.on('error', (err) => {
    console.error(`[${worker.name}] worker error: ${err.message}`);
  });
  worker.on('completed', (job) => {
    console.log(`[${worker.name}] ${job.id} completed`);
  });
  worker.on('failed', (job, err) => {
    console.error(`[${worker.name}] ${job?.id} failed: ${err.message}`);
  });
}

// liveness signal for the API's /health — absence after 15s means dead/deaf
export const HEARTBEAT_KEY = 'mrl:worker:heartbeat';
await redis.set(HEARTBEAT_KEY, Date.now().toString(), 'PX', 15_000);
setInterval(() => {
  redis.set(HEARTBEAT_KEY, Date.now().toString(), 'PX', 15_000).catch((err: Error) => {
    console.error(`[heartbeat] ${err.message}`);
  });
}, 5_000).unref();

async function shutdown() {
  await Promise.all([transcodeWorker.close(), webhookWorker.close()]);
  await webhookQueue.close();
  await redis.quit();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(
  `worker up — transcode slots free=${POLICY.transcode.slots.free} pro=${POLICY.transcode.slots.pro}, ` +
    `webhook pacing 1/${POLICY.webhook.intervalMs}ms burst ${POLICY.webhook.burst}` +
    (POLICY.webhook.allowPrivate ? ' (PRIVATE DESTINATIONS ALLOWED — dev mode)' : ''),
);
