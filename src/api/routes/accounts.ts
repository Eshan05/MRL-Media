import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { auth } from '../../auth.js';
import { db } from '../../db.js';
import { user as authUsers } from '../../db/schema/auth.js';
import { fixedWindow } from '../../limiter/index.js';
import { POLICY } from '../../policy.js';
import { requestBody, retryAfterSeconds, setRateLimitHeaders } from '../http.js';
import { recordDecision } from '../metrics.js';
import { createRequestGuards, requireUser } from '../request-guards.js';
import type { ApiPluginOptions } from '../types.js';

export const accountRoutes: FastifyPluginAsync<ApiPluginOptions> = async (app, { context }) => {
  const guards = createRequestGuards(context);
  const signupLimiter = fixedWindow(context.redis, { name: 'signup', ...POLICY.signup });

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const origin = `${req.protocol}://${req.headers.host ?? `localhost:${process.env.PORT ?? 3000}`}`;
      const url = new URL(req.url, origin);
      const response = await auth.handler(
        new Request(url, {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          body: requestBody(req),
        }),
      );

      const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const setCookie = responseHeaders.getSetCookie?.() ?? [];
      if (setCookie.length > 0) reply.header('set-cookie', setCookie);

      reply.code(response.status);
      return reply.send(Buffer.from(await response.arrayBuffer()));
    },
  });

  app.post('/signup', async (req, reply) => {
    const res = await signupLimiter.check(req.ip);
    recordDecision('fixed-window-signup', res.allowed);
    setRateLimitHeaders(reply, {
      limit: POLICY.signup.limit,
      remaining: res.remaining,
      resetAt: res.resetAt,
      policy: `${POLICY.signup.limit};w=${Math.ceil(POLICY.signup.windowMs / 1000)}`,
    });
    if (!res.allowed) {
      reply.header('retry-after', retryAfterSeconds(res.resetAt));
      return reply.code(429).send({ error: 'rate_limited', layer: 'fixed-window-signup', retryAt: res.resetAt });
    }

    const body = (req.body ?? {}) as { name?: unknown; email?: unknown; password?: unknown };
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 64) : null;
    if (!name) return reply.code(422).send({ error: 'name required' });
    const email =
      typeof body.email === 'string' && body.email.trim()
        ? body.email.trim().toLowerCase()
        : `${slugForEmail(name)}-${randomUUID()}@local.test`;
    const password =
      typeof body.password === 'string' && body.password.length >= 8
        ? body.password
        : `dev-${randomUUID()}-password`;

    const user = await createUserWithApiKey({ name, email, password, tier: 'free', ageDays: 0 });
    return reply.code(201).send({
      userId: user.id,
      apiKey: user.apiKey,
      tier: user.tier,
      note: 'new accounts start at 0.5x trust - limits grow as the account ages cleanly',
    });
  });

  app.post('/admin/users', async (req, reply) => {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return reply.code(503).send({ error: 'admin api disabled (ADMIN_KEY not set)' });
    const given = typeof req.headers['x-admin-key'] === 'string' ? req.headers['x-admin-key'] : '';
    const providedHash = createHash('sha256').update(given).digest();
    const expectedHash = createHash('sha256').update(adminKey).digest();
    if (!timingSafeEqual(providedHash, expectedHash)) {
      return reply.code(401).send({ error: 'bad admin key' });
    }

    const body = (req.body ?? {}) as {
      name?: unknown;
      email?: unknown;
      password?: unknown;
      tier?: unknown;
      ageDays?: unknown;
    };
    const name = typeof body.name === 'string' && body.name ? body.name.slice(0, 64) : 'test-user';
    const email =
      typeof body.email === 'string' && body.email.trim()
        ? body.email.trim().toLowerCase()
        : `${slugForEmail(name)}-${randomUUID()}@admin.local`;
    const password =
      typeof body.password === 'string' && body.password.length >= 8
        ? body.password
        : `admin-${randomUUID()}-password`;
    const tier = body.tier === 'pro' ? 'pro' : 'free';
    const ageDays = typeof body.ageDays === 'number' && body.ageDays >= 0 ? body.ageDays : 0;
    const user = await createUserWithApiKey({ name, email, password, tier, ageDays });
    return reply.code(201).send({ id: user.id, apiKey: user.apiKey, tier: user.tier });
  });

  app.get('/me', { preHandler: guards.authOnly }, async (req) => {
    const user = requireUser(req);
    return {
      id: user.id,
      name: user.name,
      tier: user.tier,
      accountAgeDays: Math.floor((Date.now() - user.created_at) / 86_400_000),
    };
  });
};

async function createUserWithApiKey({
  name,
  email,
  password,
  tier,
  ageDays,
}: {
  name: string;
  email: string;
  password: string;
  tier: 'free' | 'pro';
  ageDays: number;
}) {
  const signedUp = await auth.api.signUpEmail({ body: { name, email, password } });
  const userId = signedUp.user.id;
  const createdAt = new Date(Date.now() - ageDays * 86_400_000);
  await db.update(authUsers).set({ tier, createdAt, updatedAt: new Date() }).where(eq(authUsers.id, userId));
  const apiKey = await auth.api.createApiKey({
    body: { userId, name: 'default', rateLimitEnabled: false },
  });
  return { id: userId, apiKey: apiKey.key, tier };
}

function slugForEmail(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'user'
  );
}
