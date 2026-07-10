import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  deleteFileRow,
  fileById,
  filesByUser,
  updateFileAccess,
  type FileVisibility,
} from '../../db.js';
import { storage } from '../../storage.js';
import {
  canReadSharedMedia,
  codeFromQuery,
  FILE_NAME_RE,
  fileResponse,
  hashAccessCode,
  isExpired,
  newAccessCode,
  purgeFile,
  purgeMediaObjects,
  UUID_RE,
} from '../media.js';
import { createRequestGuards, requireUser } from '../request-guards.js';
import type { ApiPluginOptions } from '../types.js';

export const fileRoutes: FastifyPluginAsync<ApiPluginOptions> = async (app, { context }) => {
  const guards = createRequestGuards(context);

  app.get('/media/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!FILE_NAME_RE.test(name)) return reply.code(404).send({ error: 'not_found' });
    const file = await fileById(name.slice(0, 36));
    if (!file || file.processing_status === 'staging' || isExpired(file)) {
      if (file && isExpired(file)) void purgeFile(file).catch((err) => req.log.warn(err));
      return reply.code(404).send({ error: 'not_found' });
    }
    const owner = await guards.authenticatedUser(req);
    if (!canReadSharedMedia(file, codeFromQuery(req), owner?.id ?? null)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const object = await storage.getObject(name);
    if (!object) return reply.code(404).send({ error: 'not_found' });
    reply.type(object.contentType);
    return reply.send(object.stream);
  });

  app.get('/files', { preHandler: guards.authOnly }, async (req) => ({
    files: (await filesByUser(requireUser(req).id))
      .filter((file) => !isExpired(file))
      .map((file) => ({
        id: file.id,
        filename: file.original_name,
        bytes: file.bytes,
        visibility: file.visibility,
        state: file.processing_status,
        url: `/files/${file.stored_as}`,
        mediaUrl: file.visibility === 'public' ? `/media/${file.stored_as}` : null,
        expiresAt: file.expires_at ? new Date(file.expires_at).toISOString() : null,
        statusUrl: `/api/v1/jobs/${file.id}`,
      })),
  }));

  app.patch('/files/:id', { preHandler: guards.userGate }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const current = await fileById(id);
    if (!current || current.user_id !== user.id || current.processing_status === 'staging') {
      return reply.code(404).send({ error: 'not_found' });
    }

    const body = (req.body ?? {}) as { visibility?: unknown; regenerateCode?: unknown };
    const visibility: FileVisibility | null =
      body.visibility === undefined
        ? current.visibility
        : body.visibility === 'public' || body.visibility === 'private'
          ? body.visibility
          : null;
    if (!visibility) return reply.code(422).send({ error: 'visibility must be public or private' });
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
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return fileResponse(updated, privateCode);
  });

  app.delete('/files/:id', { preHandler: guards.userGate }, async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const removed = await deleteFileRow(id, user.id);
    if (!removed) return reply.code(404).send({ error: 'not_found' });
    await purgeMediaObjects(removed);
    return reply.code(204).send();
  });

  app.get('/files/:name', { preHandler: guards.authOnly }, async (req, reply) => {
    const user = requireUser(req);
    const { name } = req.params as { name: string };
    if (!FILE_NAME_RE.test(name)) return reply.code(404).send({ error: 'not_found' });
    const owned = await fileById(name.slice(0, 36));
    if (
      !owned ||
      owned.user_id !== user.id ||
      owned.processing_status === 'staging' ||
      isExpired(owned)
    ) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const object = await storage.getObject(name);
    if (!object) return reply.code(404).send({ error: 'not_found' });
    reply.type(object.contentType);
    return reply.send(object.stream);
  });

  const jobHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const owned = await fileById(id);
    if (!owned || owned.user_id !== user.id || owned.processing_status === 'staging' || isExpired(owned)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return {
      id,
      state: owned.processing_status,
      outputs: owned.processing_outputs,
      failedReason: owned.processing_error,
      processedOn: owned.processing_started_at,
      finishedOn: owned.processing_finished_at,
      webhook: owned.webhook_url ? 'delivered by worker after processing' : null,
    };
  };

  app.get('/api/v1/jobs/:id', { preHandler: guards.authOnly }, jobHandler);
  app.get('/jobs/:id', { preHandler: guards.authOnly }, jobHandler);
};
