import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Tier } from './jobs/types.js';
import { files } from './db/schema/app.js';

export type AuthTier = Exclude<Tier, 'anonymous'>;

export interface UserRow {
  id: string;
  name: string;
  tier: AuthTier;
  created_at: number;
}

export interface FileRow {
  id: string;
  user_id: string | null;
  stored_as: string;
  original_name: string | null;
  visibility: FileVisibility;
  access_code_hash: string | null;
  bytes: number;
  created_at: number;
  expires_at: number | null;
}

export type FileVisibility = 'public' | 'private';

const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/mrl_media';

export const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool);

export async function recordFile(file: Omit<FileRow, 'created_at'>): Promise<void> {
  await db.insert(files).values({
    id: file.id,
    user_id: file.user_id,
    stored_as: file.stored_as,
    original_name: file.original_name,
    visibility: file.visibility,
    access_code_hash: file.access_code_hash,
    bytes: file.bytes,
    created_at: Date.now(),
    expires_at: file.expires_at,
  });
}

export async function fileById(id: string): Promise<FileRow | undefined> {
  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  return normalizeFile(row);
}

export async function filesByUser(userId: string): Promise<FileRow[]> {
  const rows = await db
    .select()
    .from(files)
    .where(eq(files.user_id, userId))
    .orderBy(desc(files.created_at))
    .limit(100);
  return rows.map(normalizeFile).filter((row): row is FileRow => row !== undefined);
}

export async function updateFileAccess({
  id,
  userId,
  visibility,
  accessCodeHash,
}: {
  id: string;
  userId: string;
  visibility: FileVisibility;
  accessCodeHash: string | null;
}): Promise<FileRow | undefined> {
  const [row] = await db
    .update(files)
    .set({ visibility, access_code_hash: accessCodeHash })
    .where(and(eq(files.id, id), eq(files.user_id, userId)))
    .returning();
  return normalizeFile(row);
}

export async function deleteFileRow(id: string, userId: string): Promise<FileRow | undefined> {
  const [row] = await db.delete(files).where(and(eq(files.id, id), eq(files.user_id, userId))).returning();
  return normalizeFile(row);
}

export async function deleteFileRowById(id: string): Promise<FileRow | undefined> {
  const [row] = await db.delete(files).where(eq(files.id, id)).returning();
  return normalizeFile(row);
}

export async function expiredFiles(now = Date.now(), limit = 100): Promise<FileRow[]> {
  const rows = await db
    .select()
    .from(files)
    .where(and(isNotNull(files.expires_at), lt(files.expires_at, now)))
    .orderBy(files.expires_at)
    .limit(limit);
  return rows.map(normalizeFile).filter((row): row is FileRow => row !== undefined);
}

function normalizeFile(row: typeof files.$inferSelect | undefined): FileRow | undefined {
  if (!row) return undefined;
  return {
    ...row,
    visibility: row.visibility === 'public' ? 'public' : 'private',
  };
}
