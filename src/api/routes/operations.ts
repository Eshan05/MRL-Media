import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { pendingOutboxCount } from '../../db.js';
import { HEARTBEAT_KEY } from '../../jobs/queues.js';
import { PUBLIC_DIR } from '../../paths.js';
import {
  outboxPendingGauge,
  queueDepthGauge,
  registry,
  workerHeartbeatAge,
} from '../metrics.js';
import type { ApiPluginOptions } from '../types.js';

export const operationRoutes: FastifyPluginAsync<ApiPluginOptions> = async (app, { context }) => {
  app.get('/health', async () => {
    const [depth, beat, pending] = await Promise.all([
      context.queueDepth(),
      context.redis.get(HEARTBEAT_KEY),
      pendingOutboxCount(),
    ]);
    return {
      ok: true,
      queueDepth: depth,
      outbox: { pending },
      worker: beat === null ? { alive: false } : { alive: true, lastBeatMsAgo: Date.now() - Number(beat) },
    };
  });

  app.get('/metrics', async (_req, reply) => {
    const [depth, beat, pending] = await Promise.all([
      context.queueDepth(),
      context.redis.get(HEARTBEAT_KEY),
      pendingOutboxCount(),
    ]);
    queueDepthGauge.set(depth);
    outboxPendingGauge.set(pending);
    workerHeartbeatAge.set(beat === null ? -1 : (Date.now() - Number(beat)) / 1_000);
    reply.type('text/plain; version=0.0.4');
    return registry.metrics();
  });

  app.get('/', async (_req, reply) => {
    const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    return reply.type('text/html').send(html);
  });
};
