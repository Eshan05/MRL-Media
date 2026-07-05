import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import {
  concurrency,
  createRedis,
  fixedWindow,
  slidingWindow,
  tokenBucket,
  trustMultiplier,
  scaledLimit,
  violationTracker,
} from '../limiter/index.js';
import { createQueueConnection, createTranscodeQueue } from '../jobs/queues.js';
import { POLICY } from '../policy.js';
import { auth, toAppUser } from '../auth.js';
import {
  db,
  deleteFileRow,
  deleteFileRowById,
  expiredFiles,
  fileById,
  filesByUser,
  recordFile,
  updateFileAccess,
  type FileRow,
  type FileVisibility,
  type UserRow,
} from '../db.js';
import { user as authUsers } from '../db/schema/auth.js';
import { looksPrivateHost } from '../ssrf.js';
import { queueDepthGauge, recordDecision, registry, workerHeartbeatAge } from './metrics.js';
import { PUBLIC_DIR, TMP_DIR } from '../paths.js';
import { contentTypeForKey, removeTempFile, storage } from '../storage.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    uploadActor?: UploadActor;
    /** adaptive multiplier (layer 6) computed for this request */
    trust?: number;
  }
}

type UploadActor =
  | {
      kind: 'user';
      key: string;
      userId: string;
      tier: 'free' | 'pro';
      trust: number;
    }
  | {
      kind: 'anonymous';
      key: string;
      userId: null;
      tier: 'anonymous';
      trust: number;
    };

const HEARTBEAT_KEY = 'mrl:worker:heartbeat';
const API_INSTANCE = process.env.API_INSTANCE_ID ?? process.env.HOSTNAME ?? randomUUID();
const ACCESS_CODE_SALT = process.env.MEDIA_CODE_SECRET ?? process.env.BETTER_AUTH_SECRET ?? 'dev-media-code-secret';
const ANON_KEY_SALT = process.env.ANON_KEY_SALT ?? process.env.BETTER_AUTH_SECRET ?? 'dev-anonymous-key-secret';
let cleanupRunning = false;

const redis = createRedis();
const app = Fastify({
  logger: true,
  // behind a reverse proxy req.ip is the proxy — every user would share one
  // layer-1 bucket. Set TRUST_PROXY=1 in that deployment.
  trustProxy: process.env.TRUST_PROXY === '1',
});
await app.register(multipart, { limits: { fileSize: POLICY.maxFileBytes, files: 1 } });

// clients get intent, not internals (no paths, no stack traces)
app.setErrorHandler((err: FastifyError, req, reply) => {
  req.log.error(err);
  if (err.name === 'MaxRetriesPerRequestError' || err.message.includes('Connection is closed')) {
    // redis unreachable → limiters can't answer → fail closed, honestly
    return reply.code(503).header('retry-after', 5).send({ error: 'rate_limiter_unavailable' });
  }
  if (err.statusCode === 406 && /multipart/i.test(err.message)) {
    // "not multipart" is the client sending the wrong media type — 415, not 406
    return reply.code(415).send({ error: 'multipart/form-data required' });
  }
  const errWithStatus = err as FastifyError & { status?: number };
  const rawStatus = err.statusCode ?? errWithStatus.status;
  const status = rawStatus && rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
  return reply.code(status).send({ error: status === 500 ? 'internal_error' : err.message });
});

const vt = violationTracker(redis, { name: 'api' });
const transcodeQueue = createTranscodeQueue(createQueueConnection());

// layer 6 backpressure signal, cached so it isn't a redis call per request
let depthCache = { at: 0, value: 0 };
async function queueDepth(): Promise<number> {
  if (Date.now() - depthCache.at > 5_000) {
    depthCache = { at: Date.now(), value: await transcodeQueue.getWaitingCount() };
  }
  return depthCache.value;
}

// ── layer 1: coarse per-IP fixed window on every route, before auth ────────
const ipLimiter = fixedWindow(redis, { name: 'ip', ...POLICY.ip });

app.addHook('onRequest', async (req, reply) => {
  reply.header('x-api-instance', API_INSTANCE);
  const res = await ipLimiter.check(req.ip);
  recordDecision('fixed-window-ip', res.allowed);
  reply.header('x-rl-ip-remaining', res.remaining);
  setRateLimitHeaders(reply, {
    limit: POLICY.ip.limit,
    remaining: res.remaining,
    resetAt: res.resetAt,
    policy: `${POLICY.ip.limit};w=${Math.ceil(POLICY.ip.windowMs / 1000)}`,
  });
  if (!res.allowed) {
    reply.header('retry-after', retryAfterSeconds(res.resetAt));
    return reply.code(429).send({ error: 'rate_limited', layer: 'fixed-window-ip', retryAt: res.resetAt });
  }
});

// ── auth ────────────────────────────────────────────────────────────────────

app.route({
  method: ['GET', 'POST'],
  url: '/api/auth/*',
  handler: async (req, reply) => {
    const origin = `${req.protocol}://${req.headers.host ?? `localhost:${process.env.PORT ?? 3000}`}`;
    const url = new URL(req.url, origin);
    const headers = fromNodeHeaders(req.headers);
    const response = await auth.handler(
      new Request(url, {
        method: req.method,
        headers,
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

/** Better Auth session or API key → user row. */
async function authenticatedUser(req: FastifyRequest): Promise<UserRow | null> {
  try {
    const session = await auth.api.getSession({ headers: authHeaders(req) });
    return session?.user ? toAppUser(session.user) : null;
  } catch (err) {
    const status = clientAuthErrorStatus(err);
    if (status && hasAuthAttempt(req)) {
      return null;
    }
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

/** Authenticated mutations still pass layer 6 + layer 2. */
async function userGate(req: FastifyRequest, reply: FastifyReply) {
  await authOnly(req, reply);
  if (reply.sent) return;

  const actor = await rateLimitAuthenticatedUser(req, reply, requireUser(req));
  if (actor) req.uploadActor = actor;
}

/** Uploads can be authenticated or no-account anonymous. */
async function uploadGate(req: FastifyRequest, reply: FastifyReply) {
  const user = await authenticatedUser(req);
  if (!user && hasAuthAttempt(req)) {
    return reply.code(401).send({ error: 'invalid session, x-api-key, or Authorization: Bearer <api key>' });
  }
  if (user) {
    req.user = user;
    const actor = await rateLimitAuthenticatedUser(req, reply, user);
    if (!actor) return;
    req.uploadActor = actor;
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

async function rateLimitAuthenticatedUser(
  req: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
): Promise<Extract<UploadActor, { kind: 'user' }> | null> {
  const violations = await vt.count(user.id);
  const trust = trustMultiplier(
    {
      accountAgeDays: (Date.now() - user.created_at) / 86_400_000,
      recentViolations: violations,
      globalQueueDepth: await queueDepth(),
    },
    POLICY.adaptive,
  );
  req.trust = trust;
  reply.header('x-rl-trust', trust.toFixed(3));

  const sw = slidingWindow(redis, {
    name: 'user',
    limit: scaledLimit(POLICY.user.limit, trust),
    windowMs: POLICY.user.windowMs,
  });
  const res = await sw.check(user.id);
  recordDecision('sliding-window-user', res.allowed);
  reply.header('x-rl-user-remaining', res.remaining);
  const userLimit = scaledLimit(POLICY.user.limit, trust);
  setRateLimitHeaders(reply, {
    limit: userLimit,
    remaining: res.remaining,
    resetAt: res.resetAt,
    policy: `${userLimit};w=${Math.ceil(POLICY.user.windowMs / 1000)}`,
  });
  if (!res.allowed) {
    await vt.record(user.id);
    reply.header('retry-after', retryAfterSeconds(res.resetAt));
    reply.code(429).send({ error: 'rate_limited', layer: 'sliding-window-user', retryAt: res.resetAt });
    return null;
  }
  return { kind: 'user', key: user.id, userId: user.id, tier: user.tier, trust };
}

// ── accounts ────────────────────────────────────────────────────────────────

const signupLimiter = fixedWindow(redis, { name: 'signup', ...POLICY.signup });

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
    await reply.header('retry-after', retryAfterSeconds(res.resetAt));
    return reply.code(429).send({ error: 'rate_limited', layer: 'fixed-window-signup', retryAt: res.resetAt });
  }
  const body = (req.body ?? {}) as { name?: unknown; email?: unknown; password?: unknown };
  const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim().slice(0, 64) : null;
  if (!name) {
    return reply.code(422).send({ error: 'name required' });
  }
  const email =
    typeof body.email === 'string' && body.email.trim().length > 0
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
    note: 'new accounts start at 0.5x trust — limits grow as the account ages cleanly',
  });
});

/**
 * Test/ops backdoor, disabled unless ADMIN_KEY is set: create users with
 * arbitrary tier and account age. This is how the test suites get
 * deterministic trust (age 30d → 1.0x) without waiting a month.
 */
app.post('/admin/users', async (req, reply) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return reply.code(503).send({ error: 'admin api disabled (ADMIN_KEY not set)' });
  }
  const given = typeof req.headers['x-admin-key'] === 'string' ? req.headers['x-admin-key'] : '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(adminKey).digest();
  if (!timingSafeEqual(a, b)) {
    return reply.code(401).send({ error: 'bad admin key' });
  }
  const body = (req.body ?? {}) as {
    name?: unknown;
    email?: unknown;
    password?: unknown;
    tier?: unknown;
    ageDays?: unknown;
  };
  const name = typeof body.name === 'string' && body.name.length > 0 ? body.name.slice(0, 64) : 'test-user';
  const email =
    typeof body.email === 'string' && body.email.trim().length > 0
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

app.get('/me', { preHandler: authOnly }, async (req) => {
  const user = requireUser(req);
  return {
    id: user.id,
    name: user.name,
    tier: user.tier,
    accountAgeDays: Math.floor((Date.now() - user.created_at) / 86_400_000),
  };
});

// ── uploads ─────────────────────────────────────────────────────────────────

app.post('/upload', { preHandler: uploadGate }, async (req, reply) => {
  const actor = requireUploadActor(req);
  const trust = requireTrust(req);
  // layer 3: uploads are the bursty action — token bucket, scaled by trust
  const uploadBurst =
    actor.kind === 'anonymous' ? POLICY.anonymous.uploadBurst : scaledLimit(POLICY.upload.burst, trust);
  const uploadRefill =
    actor.kind === 'anonymous' ? POLICY.anonymous.uploadRefillPerSec : POLICY.upload.refillPerSec;
  const tb = tokenBucket(redis, {
    name: 'upload',
    capacity: uploadBurst,
    refillPerSec: uploadRefill,
  });
  const res = await tb.check(actor.key);
  recordDecision('token-bucket-upload', res.allowed);
  reply.header('x-rl-upload-remaining', res.remaining);
  setRateLimitHeaders(reply, {
    limit: uploadBurst,
    remaining: res.remaining,
    resetAt: res.resetAt,
    policy: `${uploadBurst};w=${Math.ceil(uploadBurst / uploadRefill)}`,
  });
  if (!res.allowed) {
    if (actor.kind === 'user') await vt.record(actor.userId);
    reply.header('retry-after', retryAfterSeconds(res.resetAt));
    return reply.code(429).send({ error: 'rate_limited', layer: 'token-bucket-upload', retryAt: res.resetAt });
  }

  // optional destination for the media.processed event; syntactic SSRF
  // screen here, authoritative resolve-time check in the worker
  const webhookUrl = typeof req.headers['x-webhook-url'] === 'string' ? req.headers['x-webhook-url'] : undefined;
  if (webhookUrl !== undefined && actor.kind === 'anonymous') {
    return reply.code(401).send({ error: 'authentication required for upload webhooks' });
  }
  if (webhookUrl !== undefined) {
    let hostname: string | null = null;
    try {
      const u = new URL(webhookUrl);
      hostname = /^https?:$/.test(u.protocol) ? u.hostname : null;
    } catch {
      /* not a url */
    }
    if (hostname === null) {
      return reply.code(400).send({ error: 'x-webhook-url must be a http(s) URL' });
    }
    if (!POLICY.webhook.allowPrivate && looksPrivateHost(hostname)) {
      return reply.code(422).send({ error: 'webhook destination must be a public host' });
    }
  }

  const data = await req.file();
  if (!data) {
    return reply.code(422).send({ error: 'multipart file field required' });
  }
  const visibility = parseVisibility(req.headers['x-media-visibility'], data.fields);
  if (!visibility) {
    data.file.resume();
    return reply.code(422).send({ error: 'x-media-visibility must be public or private' });
  }

  // layer 4a: tier-based slots on uploads in flight
  const slots = concurrency(redis, {
    name: 'upload-inflight',
    slots: POLICY.inflight.slots[actor.tier],
    ttlMs: POLICY.inflight.ttlMs,
  });
  const slot = await slots.acquire(actor.key);
  recordDecision('concurrency-upload', slot.acquired);
  reply.header('x-rl-inflight', `${slot.inUse}/${POLICY.inflight.slots[actor.tier]}`);
  if (!slot.acquired || slot.holderId === undefined) {
    if (actor.kind === 'user') await vt.record(actor.userId);
    data.file.resume(); // discard the body so the connection can settle
    return reply
      .code(429)
      .send({ error: 'rate_limited', layer: 'concurrency-upload', inFlight: slot.inUse });
  }

  const id = randomUUID();
  const storedAs = `${id}${sanitizeExt(data.filename)}`;
  const dest = path.join(TMP_DIR, `${id}.upload${path.extname(storedAs)}`);
  const privateCode = visibility === 'private' ? newAccessCode() : null;
  const expiresAt = actor.kind === 'anonymous' ? Date.now() + POLICY.anonymous.retentionDays * 86_400_000 : null;
  try {
    try {
      await pipeline(data.file, createWriteStream(dest));
    } catch (err) {
      // client aborted or disk failed — don't leave a partial file behind
      await removeTempFile(dest);
      throw err;
    }
    if (data.file.truncated) {
      // multipart limits cut the stream silently; a 200 here would hand the
      // user a corrupt file with no warning
      await removeTempFile(dest);
      return reply.code(413).send({ error: `file exceeds ${POLICY.maxFileBytes} bytes` });
    }
    const { size } = await stat(dest);
    await storage.putFile(storedAs, dest, data.mimetype ?? contentTypeForKey(storedAs));

    await recordFile({
      id,
      user_id: actor.userId,
      stored_as: storedAs,
      original_name: data.filename ?? null,
      visibility,
      access_code_hash: privateCode ? hashAccessCode(privateCode) : null,
      bytes: size,
      expires_at: expiresAt,
    });

    await transcodeQueue.add(
      'transcode',
      {
        fileId: id,
        storedAs,
        ownerId: actor.userId,
        userId: actor.key,
        tier: actor.tier,
        originalName: data.filename,
        bytes: size,
        webhookUrl,
      },
      {
        jobId: id, // makes GET /jobs/:id trivial
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      },
    );

    const mediaUrl = mediaUrlFor(storedAs, privateCode);
    reply.code(201).header('location', mediaUrl);
    return {
      id,
      filename: data.filename,
      bytes: size,
      storedAs,
      actor: actor.kind,
      visibility,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      mediaUrl,
      privateCode,
      statusUrl: actor.kind === 'user' ? `/jobs/${id}` : null,
    };
  } finally {
    await removeTempFile(dest);
    await slots.release(actor.key, slot.holderId);
  }
});

// ── files and share links ───────────────────────────────────────────────────

// original uploads plus worker derivatives (<uuid>-thumb.webp, <uuid>-web.webp)
const FILE_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-(thumb|web|video))?(\.[a-z0-9]{1,10})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

app.get('/media/:name', async (req, reply) => {
  const { name } = req.params as { name: string };
  if (!FILE_NAME_RE.test(name)) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const file = await fileById(name.slice(0, 36));
  if (!file || isExpired(file)) {
    if (file) void purgeFile(file).catch((err) => req.log.warn(err));
    return reply.code(404).send({ error: 'not_found' });
  }
  const owner = await authenticatedUser(req);
  if (!canReadSharedMedia(file, codeFromQuery(req), owner?.id ?? null)) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const object = await storage.getObject(name);
  if (!object) {
    return reply.code(404).send({ error: 'not_found' });
  }
  reply.type(object.contentType);
  return reply.send(object.stream);
});

app.get('/files', { preHandler: authOnly }, async (req) => ({
  files: (await filesByUser(requireUser(req).id)).filter((f) => !isExpired(f)).map((f) => ({
    id: f.id,
    filename: f.original_name,
    bytes: f.bytes,
    visibility: f.visibility,
    url: `/files/${f.stored_as}`,
    mediaUrl: f.visibility === 'public' ? `/media/${f.stored_as}` : null,
    expiresAt: f.expires_at ? new Date(f.expires_at).toISOString() : null,
    statusUrl: `/jobs/${f.id}`,
  })),
}));

app.patch('/files/:id', { preHandler: userGate }, async (req, reply) => {
  const user = requireUser(req);
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const current = await fileById(id);
  if (!current || current.user_id !== user.id) {
    return reply.code(404).send({ error: 'not_found' });
  }

  const body = (req.body ?? {}) as { visibility?: unknown; regenerateCode?: unknown };
  const visibility =
    body.visibility === undefined
      ? current.visibility
      : body.visibility === 'public' || body.visibility === 'private'
        ? body.visibility
        : null;
  if (!visibility) {
    return reply.code(422).send({ error: 'visibility must be public or private' });
  }
  if (body.regenerateCode === true && visibility !== 'private') {
    return reply.code(422).send({ error: 'private links can only be regenerated for private files' });
  }

  const shouldGenerateCode =
    visibility === 'private' && (body.regenerateCode === true || current.access_code_hash === null);
  const privateCode = shouldGenerateCode ? newAccessCode() : null;
  const updated = await updateFileAccess({
    id,
    userId: user.id,
    visibility,
    accessCodeHash:
      visibility === 'public' ? null : privateCode ? hashAccessCode(privateCode) : current.access_code_hash,
  });
  if (!updated) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return fileResponse(updated, privateCode);
});

app.delete('/files/:id', { preHandler: userGate }, async (req, reply) => {
  const user = requireUser(req);
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const removed = await deleteFileRow(id, user.id);
  if (!removed) {
    return reply.code(404).send({ error: 'not_found' });
  }
  await purgeMediaObjects(removed);
  return reply.code(204).send();
});

app.get('/files/:name', { preHandler: authOnly }, async (req, reply) => {
  const user = requireUser(req);
  const { name } = req.params as { name: string };
  if (!FILE_NAME_RE.test(name)) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const owned = await fileById(name.slice(0, 36));
  if (!owned || owned.user_id !== user.id || isExpired(owned)) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const object = await storage.getObject(name);
  if (!object) {
    return reply.code(404).send({ error: 'not_found' });
  }
  reply.type(object.contentType);
  return reply.send(object.stream);
});

app.get('/jobs/:id', { preHandler: authOnly }, async (req, reply) => {
  const user = requireUser(req);
  const { id } = req.params as { id: string };
  if (!UUID_RE.test(id)) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const owned = await fileById(id);
  if (!owned || owned.user_id !== user.id || isExpired(owned)) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const job = await transcodeQueue.getJob(id);
  if (!job) {
    return reply.code(404).send({ error: 'not_found' });
  }
  const state = await job.getState();
  return {
    id,
    state,
    outputs: job.returnvalue?.outputs ?? null,
    failedReason: job.failedReason ?? null,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    webhook: job.data.webhookUrl ? 'delivered by worker after processing' : null,
  };
});

// ── observability ───────────────────────────────────────────────────────────

app.get('/health', async () => {
  const [depth, beat] = await Promise.all([queueDepth(), redis.get(HEARTBEAT_KEY)]);
  return {
    ok: true,
    queueDepth: depth,
    worker: beat === null ? { alive: false } : { alive: true, lastBeatMsAgo: Date.now() - Number(beat) },
  };
});

app.get('/metrics', async (_req, reply) => {
  const [depth, beat] = await Promise.all([queueDepth(), redis.get(HEARTBEAT_KEY)]);
  queueDepthGauge.set(depth);
  workerHeartbeatAge.set(beat === null ? -1 : (Date.now() - Number(beat)) / 1000);
  reply.type('text/plain; version=0.0.4');
  return registry.metrics();
});

// demo page — shows every limiter header and which layer fires
app.get('/', async (_req, reply) => {
  const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  return reply.type('text/html').send(html);
});

function retryAfterSeconds(resetAt: number): number {
  return Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
}

function setRateLimitHeaders(
  reply: FastifyReply,
  limit: { limit: number; remaining: number; resetAt: number; policy: string },
): void {
  reply.header('ratelimit-limit', limit.limit);
  reply.header('ratelimit-remaining', Math.max(0, limit.remaining));
  reply.header('ratelimit-reset', retryAfterSeconds(limit.resetAt));
  reply.header('ratelimit-policy', limit.policy);
}

function requestBody(req: FastifyRequest): BodyInit | undefined {
  if (req.method === 'GET' || req.method === 'HEAD' || req.body === undefined) return undefined;
  if (typeof req.body === 'string') return req.body;
  if (req.body instanceof Uint8Array) return Buffer.from(req.body).toString('utf8');
  return JSON.stringify(req.body);
}

function authHeaders(req: FastifyRequest): Headers {
  const headers = fromNodeHeaders(req.headers);
  const bearer = bearerToken(req.headers.authorization);
  if (bearer && !headers.has('x-api-key')) headers.set('x-api-key', bearer);
  return headers;
}

function requireUser(req: FastifyRequest): UserRow {
  if (!req.user) throw new Error('auth invariant violated: req.user missing');
  return req.user;
}

function requireUploadActor(req: FastifyRequest): UploadActor {
  if (!req.uploadActor) throw new Error('upload invariant violated: req.uploadActor missing');
  return req.uploadActor;
}

function requireTrust(req: FastifyRequest): number {
  if (typeof req.trust !== 'number') throw new Error('rate-limit invariant violated: req.trust missing');
  return req.trust;
}

function hasAuthAttempt(req: FastifyRequest): boolean {
  return Boolean(req.headers.authorization || req.headers['x-api-key'] || req.headers.cookie);
}

function clientAuthErrorStatus(err: unknown): number | null {
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    body?: { status?: unknown; statusCode?: unknown; message?: unknown };
    message?: unknown;
  };
  for (const value of [e.status, e.statusCode, e.body?.status, e.body?.statusCode]) {
    const status = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(status) && status >= 400 && status < 500) return status;
  }
  const message = String(e.body?.message ?? e.message ?? '');
  return /invalid api key|unauthorized|forbidden/i.test(message) ? 401 : null;
}

function bearerToken(value: string | undefined): string | undefined {
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function anonymousKey(ip: string): string {
  return `anon:${createHash('sha256').update(ANON_KEY_SALT).update(':').update(ip).digest('hex').slice(0, 24)}`;
}

function parseVisibility(headerValue: string | string[] | undefined, fields: Record<string, unknown>): FileVisibility | null {
  const value = firstHeader(headerValue) ?? multipartField(fields, 'visibility') ?? 'public';
  if (value === 'public' || value === 'private') return value;
  return null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function multipartField(fields: Record<string, unknown>, name: string): string | undefined {
  const raw = fields[name];
  const field = Array.isArray(raw) ? raw[0] : raw;
  const value = (field as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' ? value : undefined;
}

function newAccessCode(): string {
  return randomBytes(18).toString('base64url');
}

function hashAccessCode(code: string): string {
  return createHash('sha256').update(ACCESS_CODE_SALT).update(':').update(code).digest('hex');
}

function codeFromQuery(req: FastifyRequest): string | undefined {
  const value = (req.query as { code?: unknown }).code;
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}

function canReadSharedMedia(file: FileRow, code: string | undefined, ownerId: string | null): boolean {
  if (file.visibility === 'public') return true;
  if (file.user_id !== null && file.user_id === ownerId) return true;
  if (!code || !file.access_code_hash) return false;
  const expected = Buffer.from(file.access_code_hash, 'hex');
  const actual = Buffer.from(hashAccessCode(code), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isExpired(file: FileRow): boolean {
  return file.expires_at !== null && file.expires_at <= Date.now();
}

function mediaUrlFor(storedAs: string, privateCode: string | null): string {
  const url = `/media/${storedAs}`;
  return privateCode ? `${url}?code=${encodeURIComponent(privateCode)}` : url;
}

function fileResponse(file: FileRow, privateCode: string | null = null) {
  return {
    id: file.id,
    filename: file.original_name,
    bytes: file.bytes,
    storedAs: file.stored_as,
    visibility: file.visibility,
    url: `/files/${file.stored_as}`,
    mediaUrl: file.visibility === 'public' || privateCode ? mediaUrlFor(file.stored_as, privateCode) : null,
    privateCode,
    expiresAt: file.expires_at ? new Date(file.expires_at).toISOString() : null,
    statusUrl: `/jobs/${file.id}`,
  };
}

async function purgeFile(file: FileRow): Promise<void> {
  await purgeMediaObjects(file);
  await deleteFileRowById(file.id);
}

async function purgeMediaObjects(file: FileRow): Promise<void> {
  const derivativeKeys = [`${file.id}-thumb.webp`, `${file.id}-web.webp`, `${file.id}-video.mp4`];
  await Promise.all([file.stored_as, ...derivativeKeys].map((key) => storage.deleteObject(key)));
}

async function cleanupExpiredFiles(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const rows = await expiredFiles();
    for (const row of rows) {
      await purgeFile(row);
    }
  } finally {
    cleanupRunning = false;
  }
}

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
  const signedUp = await auth.api.signUpEmail({
    body: { name, email, password },
  });
  const userId = signedUp.user.id;
  const createdAt = new Date(Date.now() - ageDays * 86_400_000);

  await db
    .update(authUsers)
    .set({ tier, createdAt, updatedAt: new Date() })
    .where(eq(authUsers.id, userId));

  const apiKey = await auth.api.createApiKey({
    body: {
      userId,
      name: 'default',
      rateLimitEnabled: false,
    },
  });

  return { id: userId, apiKey: apiKey.key, tier };
}

function slugForEmail(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'user';
}

/** filenames are attacker-controlled; only a plain ascii extension survives */
function sanitizeExt(filename: string | undefined): string {
  const ext = path.extname(filename ?? '').toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

app.addHook('onClose', async () => {
  await transcodeQueue.close();
  await redis.quit();
});

await mkdir(TMP_DIR, { recursive: true });
void cleanupExpiredFiles().catch((err) => app.log.warn(err));
setInterval(() => {
  cleanupExpiredFiles().catch((err) => app.log.warn(err));
}, 60 * 60_000).unref();
const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
