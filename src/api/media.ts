import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { deleteFileRowById, type FileRow, type FileVisibility } from '../db.js';
import { storage } from '../storage.js';
import { firstHeader, multipartField } from './http.js';

const ACCESS_CODE_SALT = process.env.MEDIA_CODE_SECRET ?? process.env.BETTER_AUTH_SECRET ?? 'dev-media-code-secret';

export const FILE_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-(thumb|web|video))?(\.[a-z0-9]{1,10})?$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseVisibility(
  headerValue: string | string[] | undefined,
  fields: Record<string, unknown>,
): FileVisibility | null {
  const value = firstHeader(headerValue) ?? multipartField(fields, 'visibility') ?? 'public';
  return value === 'public' || value === 'private' ? value : null;
}

export function newAccessCode(): string {
  return randomBytes(18).toString('base64url');
}

export function hashAccessCode(code: string): string {
  return createHash('sha256').update(ACCESS_CODE_SALT).update(':').update(code).digest('hex');
}

export function codeFromQuery(req: FastifyRequest): string | undefined {
  const value = (req.query as { code?: unknown }).code;
  return typeof value === 'string' && value.length <= 256 ? value : undefined;
}

export function canReadSharedMedia(file: FileRow, code: string | undefined, ownerId: string | null): boolean {
  if (file.visibility === 'public') return true;
  if (file.user_id !== null && file.user_id === ownerId) return true;
  if (!code || !file.access_code_hash) return false;
  const expected = Buffer.from(file.access_code_hash, 'hex');
  const actual = Buffer.from(hashAccessCode(code), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isExpired(file: FileRow): boolean {
  return file.expires_at !== null && file.expires_at <= Date.now();
}

export function mediaUrlFor(storedAs: string, privateCode: string | null): string {
  const url = `/media/${storedAs}`;
  return privateCode ? `${url}?code=${encodeURIComponent(privateCode)}` : url;
}

export function fileResponse(file: FileRow, privateCode: string | null = null) {
  return {
    id: file.id,
    filename: file.original_name,
    bytes: file.bytes,
    storedAs: file.stored_as,
    visibility: file.visibility,
    state: file.processing_status,
    url: `/files/${file.stored_as}`,
    mediaUrl: file.visibility === 'public' || privateCode ? mediaUrlFor(file.stored_as, privateCode) : null,
    privateCode,
    expiresAt: file.expires_at ? new Date(file.expires_at).toISOString() : null,
    statusUrl: `/api/v1/jobs/${file.id}`,
  };
}

export function sanitizeExt(filename: string | undefined): string {
  const ext = path.extname(filename ?? '').toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

export async function purgeFile(file: FileRow): Promise<void> {
  await purgeMediaObjects(file);
  await deleteFileRowById(file.id);
}

export async function purgeMediaObjects(file: FileRow): Promise<void> {
  const derivativeKeys = [`${file.id}-thumb.webp`, `${file.id}-web.webp`, `${file.id}-video.mp4`];
  await Promise.all([file.stored_as, ...derivativeKeys].map((key) => storage.deleteObject(key)));
}
