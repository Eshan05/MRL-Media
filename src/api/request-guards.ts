import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth, toAppUser } from '../auth.js';
import type { UserRow } from '../db.js';
import { scaledLimit, slidingWindow, trustMultiplier } from '../limiter/index.js';
import { POLICY } from '../policy.js';
import { recordDecision } from './metrics.js';
import { authHeaders, clientAuthErrorStatus, hasAuthAttempt, retryAfterSeconds, setRateLimitHeaders } from './http.js';
import type { ApiContext, UploadActor } from './types.js';

const ANON_KEY_SALT = process.env.ANON_KEY_SALT ?? process.env.BETTER_AUTH_SECRET ?? 'dev-anonymous-key-secret';

export interface RequestGuards {
  authenticatedUser(req: FastifyRequest): Promise<UserRow | null>;
  authOnly(req: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  userGate(req: FastifyRequest, reply: FastifyReply): Promise<unknown>;
  uploadGate(req: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export function createRequestGuards(context: ApiContext): RequestGuards {
  async function authenticatedUser(req: FastifyRequest): Promise<UserRow | null> {
    try {
      const session = await auth.api.getSession({ headers: authHeaders(req) });
      return session?.user ? toAppUser(session.user) : null;
    } catch (err) {
      const status = clientAuthErrorStatus(err);
      if (status && hasAuthAttempt(req)) return null;
      throw err;
    }
  }

  async function authOnly(req: FastifyRequest, reply: FastifyReply) {
    const user = await authenticatedUser(req);
    if (!user) {
      return reply.code(401).send({ error: 'valid session, x-api-key, or Authorization: Bearer <api key> required' });
    }
    req.user = user;
  }

  async function userGate(req: FastifyRequest, reply: FastifyReply) {
    await authOnly(req, reply);
    if (reply.sent) return;

    const actor = await rateLimitAuthenticatedUser(context, req, reply, requireUser(req));
    if (actor) req.uploadActor = actor;
  }

  async function uploadGate(req: FastifyRequest, reply: FastifyReply) {
    const user = await authenticatedUser(req);
    if (!user && hasAuthAttempt(req)) {
      return reply.code(401).send({ error: 'invalid session, x-api-key, or Authorization: Bearer <api key>' });
    }
    if (user) {
      req.user = user;
      const actor = await rateLimitAuthenticatedUser(context, req, reply, user);
      if (actor) req.uploadActor = actor;
      return;
    }

    const trust = POLICY.anonymous.trust;
    req.trust = trust;
    req.uploadActor = {
      kind: 'anonymous',
      key: anonymousKey(req.ip),
      userId: null,
      tier: 'anonymous',
      trust,
    };
    reply.header('x-rl-trust', trust.toFixed(3));
    reply.header('x-rl-user-remaining', 'anonymous');
  }

  return { authenticatedUser, authOnly, userGate, uploadGate };
}

async function rateLimitAuthenticatedUser(
  context: ApiContext,
  req: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
): Promise<Extract<UploadActor, { kind: 'user' }> | null> {
  const violations = await context.violations.count(user.id);
  const trust = trustMultiplier(
    {
      accountAgeDays: (Date.now() - user.created_at) / 86_400_000,
      recentViolations: violations,
      globalQueueDepth: await context.queueDepth(),
    },
    POLICY.adaptive,
  );
  req.trust = trust;
  reply.header('x-rl-trust', trust.toFixed(3));

  const userLimit = scaledLimit(POLICY.user.limit, trust);
  const res = await slidingWindow(context.redis, {
    name: 'user',
    limit: userLimit,
    windowMs: POLICY.user.windowMs,
  }).check(user.id);
  recordDecision('sliding-window-user', res.allowed);
  reply.header('x-rl-user-remaining', res.remaining);
  setRateLimitHeaders(reply, {
    limit: userLimit,
    remaining: res.remaining,
    resetAt: res.resetAt,
    policy: `${userLimit};w=${Math.ceil(POLICY.user.windowMs / 1000)}`,
  });
  if (!res.allowed) {
    await context.violations.record(user.id);
    reply.header('retry-after', retryAfterSeconds(res.resetAt));
    reply.code(429).send({ error: 'rate_limited', layer: 'sliding-window-user', retryAt: res.resetAt });
    return null;
  }
  return { kind: 'user', key: user.id, userId: user.id, tier: user.tier, trust };
}

export function requireUser(req: FastifyRequest): UserRow {
  if (!req.user) throw new Error('auth invariant violated: req.user missing');
  return req.user;
}

export function requireUploadActor(req: FastifyRequest): UploadActor {
  if (!req.uploadActor) throw new Error('upload invariant violated: req.uploadActor missing');
  return req.uploadActor;
}

export function requireTrust(req: FastifyRequest): number {
  if (typeof req.trust !== 'number') throw new Error('rate-limit invariant violated: req.trust missing');
  return req.trust;
}

function anonymousKey(ip: string): string {
  return `anon:${createHash('sha256').update(ANON_KEY_SALT).update(':').update(ip).digest('hex').slice(0, 24)}`;
}
