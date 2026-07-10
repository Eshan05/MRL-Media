import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createStagingFile, deleteStagingFile, finalizeStagedFile } from '../../db.js';
import { concurrency, scaledLimit, tokenBucket } from '../../limiter/index.js';
import { TMP_DIR } from '../../paths.js';
import { POLICY } from '../../policy.js';
import { looksPrivateHost } from '../../ssrf.js';
import { contentTypeForKey, removeTempFile, storage } from '../../storage.js';
import { retryAfterSeconds, setRateLimitHeaders } from '../http.js';
import {
  hashAccessCode,
  mediaUrlFor,
  newAccessCode,
  parseVisibility,
  sanitizeExt,
} from '../media.js';
import { recordDecision } from '../metrics.js';
import { createRequestGuards, requireTrust, requireUploadActor } from '../request-guards.js';
import type { ApiPluginOptions } from '../types.js';

export const uploadRoutes: FastifyPluginAsync<ApiPluginOptions> = async (app, { context }) => {
  const guards = createRequestGuards(context);

  const durableHandler = (versioned: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const actor = requireUploadActor(req);
    const trust = requireTrust(req);
    const uploadBurst =
      actor.kind === 'anonymous' ? POLICY.anonymous.uploadBurst : scaledLimit(POLICY.upload.burst, trust);
    const uploadRefill =
      actor.kind === 'anonymous' ? POLICY.anonymous.uploadRefillPerSec : POLICY.upload.refillPerSec;
    const bucket = tokenBucket(context.redis, {
      name: 'upload',
      capacity: uploadBurst,
      refillPerSec: uploadRefill,
    });
    const token = await bucket.check(actor.key);
    recordDecision('token-bucket-upload', token.allowed);
    reply.header('x-rl-upload-remaining', token.remaining);
    setRateLimitHeaders(reply, {
      limit: uploadBurst,
      remaining: token.remaining,
      resetAt: token.resetAt,
      policy: `${uploadBurst};w=${Math.ceil(uploadBurst / uploadRefill)}`,
    });
    if (!token.allowed) {
      if (actor.kind === 'user') await context.violations.record(actor.userId);
      reply.header('retry-after', retryAfterSeconds(token.resetAt));
      return reply
        .code(429)
        .send({ error: 'rate_limited', layer: 'token-bucket-upload', retryAt: token.resetAt });
    }

    const webhookUrl = validateWebhookHeader(req, reply, actor.kind === 'anonymous');
    if (reply.sent) return;

    const data = await req.file();
    if (!data) return reply.code(422).send({ error: 'multipart file field required' });
    const visibility = parseVisibility(req.headers['x-media-visibility'], data.fields);
    if (!visibility) {
      data.file.resume();
      return reply.code(422).send({ error: 'x-media-visibility must be public or private' });
    }

    const slots = concurrency(context.redis, {
      name: 'upload-inflight',
      slots: POLICY.inflight.slots[actor.tier],
      ttlMs: POLICY.inflight.ttlMs,
    });
    const slot = await slots.acquire(actor.key);
    recordDecision('concurrency-upload', slot.acquired);
    reply.header('x-rl-inflight', `${slot.inUse}/${POLICY.inflight.slots[actor.tier]}`);
    if (!slot.acquired || slot.holderId === undefined) {
      if (actor.kind === 'user') await context.violations.record(actor.userId);
      data.file.resume();
      return reply.code(429).send({ error: 'rate_limited', layer: 'concurrency-upload', inFlight: slot.inUse });
    }

    const id = randomUUID();
    const storedAs = `${id}${sanitizeExt(data.filename)}`;
    const dest = path.join(TMP_DIR, `${id}.upload${path.extname(storedAs)}`);
    const privateCode = visibility === 'private' ? newAccessCode() : null;
    const expiresAt = actor.kind === 'anonymous' ? Date.now() + POLICY.anonymous.retentionDays * 86_400_000 : null;
    let staged = false;
    let objectStored = false;

    try {
      try {
        await pipeline(data.file, createWriteStream(dest));
      } catch (err) {
        await removeTempFile(dest);
        throw err;
      }
      if (data.file.truncated) {
        await removeTempFile(dest);
        return reply.code(413).send({ error: `file exceeds ${POLICY.maxFileBytes} bytes` });
      }

      const { size } = await stat(dest);
      await createStagingFile({
        id,
        user_id: actor.userId,
        stored_as: storedAs,
        original_name: data.filename ?? null,
        visibility,
        access_code_hash: privateCode ? hashAccessCode(privateCode) : null,
        webhook_url: webhookUrl ?? null,
        expires_at: expiresAt,
      });
      staged = true;

      await storage.putFile(storedAs, dest, data.mimetype ?? contentTypeForKey(storedAs));
      objectStored = true;
      await finalizeStagedFile({
        id,
        bytes: size,
        job: {
          fileId: id,
          storedAs,
          ownerId: actor.userId,
          userId: actor.key,
          tier: actor.tier,
          originalName: data.filename,
          bytes: size,
          webhookUrl,
        },
      });
      staged = false;

      const mediaUrl = mediaUrlFor(storedAs, privateCode);
      const statusUrl = actor.kind === 'user' ? `${versioned ? '/api/v1' : ''}/jobs/${id}` : null;
      reply.code(versioned ? 202 : 201).header('location', statusUrl ?? mediaUrl);
      return {
        id,
        filename: data.filename,
        bytes: size,
        storedAs,
        actor: actor.kind,
        visibility,
        ...(versioned ? { state: 'pending' as const } : {}),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        mediaUrl,
        privateCode,
        statusUrl,
      };
    } catch (err) {
      if (staged) {
        let safeToDeleteRow = !objectStored;
        if (objectStored) {
          try {
            await storage.deleteObject(storedAs);
            safeToDeleteRow = true;
          } catch (cleanupErr) {
            req.log.warn(cleanupErr, `failed to compensate stored object ${storedAs}`);
          }
        }
        if (safeToDeleteRow) await deleteStagingFile(id);
      }
      throw err;
    } finally {
      await removeTempFile(dest);
      await slots.release(actor.key, slot.holderId);
    }
  };

  app.post('/api/v1/uploads', { preHandler: guards.uploadGate }, durableHandler(true));
  app.post('/upload', { preHandler: guards.uploadGate }, durableHandler(false));
};

function validateWebhookHeader(
  req: FastifyRequest,
  reply: FastifyReply,
  anonymous: boolean,
): string | undefined {
  const webhookUrl = typeof req.headers['x-webhook-url'] === 'string' ? req.headers['x-webhook-url'] : undefined;
  if (webhookUrl === undefined) return undefined;
  if (anonymous) {
    reply.code(401).send({ error: 'authentication required for upload webhooks' });
    return undefined;
  }

  let hostname: string | null = null;
  try {
    const url = new URL(webhookUrl);
    hostname = /^https?:$/.test(url.protocol) ? url.hostname : null;
  } catch {
    // handled below
  }
  if (hostname === null) {
    reply.code(400).send({ error: 'x-webhook-url must be a http(s) URL' });
  } else if (!POLICY.webhook.allowPrivate && looksPrivateHost(hostname)) {
    reply.code(422).send({ error: 'webhook destination must be a public host' });
  }
  return webhookUrl;
}
