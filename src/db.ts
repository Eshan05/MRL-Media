import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { ProcessingState, Tier, TranscodeJobData, TranscodeOutput } from './jobs/types.js';
import { files, jobOutbox } from './db/schema/app.js';

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
  webhook_url: string | null;
  bytes: number;
  created_at: number;
  expires_at: number | null;
  processing_status: ProcessingState;
  processing_outputs: TranscodeOutput[] | null;
  processing_error: string | null;
  processing_started_at: number | null;
  processing_finished_at: number | null;
  processing_updated_at: number;
}

export type JobOutboxRow = typeof jobOutbox.$inferSelect;

export type FileVisibility = 'public' | 'private';

const connectionString = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/mrl_media';

export const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool);

export async function createStagingFile(
  file: Pick<
    FileRow,
    | 'id'
    | 'user_id'
    | 'stored_as'
    | 'original_name'
    | 'visibility'
    | 'access_code_hash'
    | 'webhook_url'
    | 'expires_at'
  >,
): Promise<void> {
  const now = Date.now();
  await db.insert(files).values({
    ...file,
    bytes: 0,
    created_at: now,
    processing_status: 'staging',
    processing_outputs: null,
    processing_error: null,
    processing_started_at: null,
    processing_finished_at: null,
    processing_updated_at: now,
  });
}

export async function finalizeStagedFile({
  id,
  bytes,
  job,
}: {
  id: string;
  bytes: number;
  job: TranscodeJobData;
}): Promise<FileRow> {
  const now = Date.now();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(files)
      .set({ bytes, processing_status: 'pending', processing_updated_at: now })
      .where(and(eq(files.id, id), eq(files.processing_status, 'staging')))
      .returning();
    if (!row) throw new Error(`staging file not found: ${id}`);

    await tx.insert(jobOutbox).values({
      id: randomUUID(),
      file_id: id,
      kind: 'transcode',
      payload: job,
      status: 'pending',
      attempts: 0,
      available_at: now,
      locked_at: null,
      dispatched_at: null,
      last_error: null,
      created_at: now,
    });
    return normalizeFile(row)!;
  });
}

export async function deleteStagingFile(id: string): Promise<FileRow | undefined> {
  const [row] = await db
    .delete(files)
    .where(and(eq(files.id, id), eq(files.processing_status, 'staging')))
    .returning();
  return normalizeFile(row);
}

export async function staleStagingFiles(before: number, limit = 100): Promise<FileRow[]> {
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.processing_status, 'staging'), lt(files.processing_updated_at, before)))
    .orderBy(files.processing_updated_at)
    .limit(limit);
  return rows.map(normalizeFile).filter((row): row is FileRow => row !== undefined);
}

export async function fileById(id: string): Promise<FileRow | undefined> {
  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  return normalizeFile(row);
}

export async function filesByUser(userId: string): Promise<FileRow[]> {
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.user_id, userId), ne(files.processing_status, 'staging')))
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

export async function markFileQueued(id: string, now = Date.now()): Promise<void> {
  await db
    .update(files)
    .set({ processing_status: 'queued', processing_updated_at: now, processing_error: null })
    .where(and(eq(files.id, id), eq(files.processing_status, 'pending')));
}

export async function markFileProcessing(id: string, now = Date.now()): Promise<void> {
  await db
    .update(files)
    .set({
      processing_status: 'processing',
      processing_started_at: now,
      processing_finished_at: null,
      processing_updated_at: now,
      processing_error: null,
    })
    .where(and(eq(files.id, id), inArray(files.processing_status, ['pending', 'queued', 'processing'])));
}

export async function completeFileProcessing(
  id: string,
  outputs: TranscodeOutput[],
  now = Date.now(),
): Promise<void> {
  await db
    .update(files)
    .set({
      processing_status: 'completed',
      processing_outputs: outputs,
      processing_error: null,
      processing_finished_at: now,
      processing_updated_at: now,
    })
    .where(eq(files.id, id));
}

export async function failFileProcessing(id: string, error: string, now = Date.now()): Promise<void> {
  await db
    .update(files)
    .set({
      processing_status: 'failed',
      processing_error: error.slice(0, 2_000),
      processing_finished_at: now,
      processing_updated_at: now,
    })
    .where(eq(files.id, id));
}

export async function claimOutboxBatch({
  now,
  leaseMs,
  limit,
}: {
  now: number;
  leaseMs: number;
  limit: number;
}): Promise<JobOutboxRow[]> {
  return db.transaction(async (tx) => {
    const available = await tx
      .select({ id: jobOutbox.id })
      .from(jobOutbox)
      .where(
        and(
          eq(jobOutbox.status, 'pending'),
          lt(jobOutbox.available_at, now + 1),
          or(isNull(jobOutbox.locked_at), lt(jobOutbox.locked_at, now - leaseMs)),
        ),
      )
      .orderBy(jobOutbox.created_at)
      .limit(limit)
      .for('update', { skipLocked: true });
    const ids = available.map((row) => row.id);
    if (ids.length === 0) return [];

    return tx
      .update(jobOutbox)
      .set({
        locked_at: now,
        attempts: sql`${jobOutbox.attempts} + 1`,
      })
      .where(inArray(jobOutbox.id, ids))
      .returning();
  });
}

export async function markOutboxDispatched(id: string, now = Date.now()): Promise<void> {
  await db
    .update(jobOutbox)
    .set({ status: 'dispatched', dispatched_at: now, locked_at: null, last_error: null })
    .where(and(eq(jobOutbox.id, id), eq(jobOutbox.status, 'pending')));
}

export async function releaseOutbox(
  id: string,
  error: string,
  availableAt: number,
): Promise<void> {
  await db
    .update(jobOutbox)
    .set({ locked_at: null, last_error: error.slice(0, 2_000), available_at: availableAt })
    .where(and(eq(jobOutbox.id, id), eq(jobOutbox.status, 'pending')));
}

export async function pendingOutboxCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(jobOutbox).where(eq(jobOutbox.status, 'pending'));
  return row?.value ?? 0;
}

function normalizeFile(row: typeof files.$inferSelect | undefined): FileRow | undefined {
  if (!row) return undefined;
  return {
    ...row,
    visibility: row.visibility === 'public' ? 'public' : 'private',
  };
}
