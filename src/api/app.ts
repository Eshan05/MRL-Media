import multipart from '@fastify/multipart';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { fixedWindow } from '../limiter/index.js';
import { POLICY } from '../policy.js';
import { retryAfterSeconds, setRateLimitHeaders } from './http.js';
import { recordDecision } from './metrics.js';
import { accountRoutes } from './routes/accounts.js';
import { fileRoutes } from './routes/files.js';
import { operationRoutes } from './routes/operations.js';
import { uploadRoutes } from './routes/uploads.js';
import type { ApiContext } from './types.js';

export async function buildApp(
  context: ApiContext,
  options: FastifyServerOptions = { logger: true },
) {
  const app = Fastify(options);
  await app.register(multipart, { limits: { fileSize: POLICY.maxFileBytes, files: 1 } });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    req.log.error(err);
    if (err.name === 'MaxRetriesPerRequestError' || err.message.includes('Connection is closed')) {
      return reply.code(503).header('retry-after', 5).send({ error: 'rate_limiter_unavailable' });
    }
    if (err.statusCode === 406 && /multipart/i.test(err.message)) {
      return reply.code(415).send({ error: 'multipart/form-data required' });
    }
    const errWithStatus = err as FastifyError & { status?: number };
    const rawStatus = err.statusCode ?? errWithStatus.status;
    const status = rawStatus && rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
    return reply.code(status).send({ error: status === 500 ? 'internal_error' : err.message });
  });

  const ipLimiter = fixedWindow(context.redis, { name: 'ip', ...POLICY.ip });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-api-instance', context.apiInstance);
    const result = await ipLimiter.check(req.ip);
    recordDecision('fixed-window-ip', result.allowed);
    reply.header('x-rl-ip-remaining', result.remaining);
    setRateLimitHeaders(reply, {
      limit: POLICY.ip.limit,
      remaining: result.remaining,
      resetAt: result.resetAt,
      policy: `${POLICY.ip.limit};w=${Math.ceil(POLICY.ip.windowMs / 1_000)}`,
    });
    if (!result.allowed) {
      reply.header('retry-after', retryAfterSeconds(result.resetAt));
      return reply
        .code(429)
        .send({ error: 'rate_limited', layer: 'fixed-window-ip', retryAt: result.resetAt });
    }
  });

  await app.register(accountRoutes, { context });
  await app.register(uploadRoutes, { context });
  await app.register(fileRoutes, { context });
  await app.register(operationRoutes, { context });

  return app;
}
