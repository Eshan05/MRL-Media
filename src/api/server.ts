import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createQueueConnection, createTranscodeQueue } from '../jobs/queues.js';
import { createRedis, violationTracker } from '../limiter/index.js';
import { TMP_DIR } from '../paths.js';
import { buildApp } from './app.js';
import { startCleanupScheduler } from './cleanup.js';
import type { ApiContext } from './types.js';

const redis = createRedis();
const transcodeQueue = createTranscodeQueue(createQueueConnection());
let depthCache = { at: 0, value: 0 };

const context: ApiContext = {
  redis,
  transcodeQueue,
  violations: violationTracker(redis, { name: 'api' }),
  apiInstance: process.env.API_INSTANCE_ID ?? process.env.HOSTNAME ?? randomUUID(),
  async queueDepth(): Promise<number> {
    if (Date.now() - depthCache.at > 5_000) {
      depthCache = { at: Date.now(), value: await transcodeQueue.getWaitingCount() };
    }
    return depthCache.value;
  },
};

await mkdir(TMP_DIR, { recursive: true });
const app = await buildApp(context, {
  logger: true,
  trustProxy: process.env.TRUST_PROXY === '1',
});
const cleanup = startCleanupScheduler(app.log);

app.addHook('onClose', async () => {
  await cleanup.close();
  await transcodeQueue.close();
  await redis.quit();
});

const port = Number(process.env.PORT ?? 3000);
try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
