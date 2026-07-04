import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Tier } from './jobs/types.js';
import { files } from './db/schema/app.js';

export interface UserRow {
  id: string;
  name: string;
  tier: Tier;
  created_at: number;
}

export interface FileRow {
  id: string;
  user_id: string;
  stored_as: string;
  original_name: string | null;
  bytes: number;
  created_at: number;
}

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
    bytes: file.bytes,
    created_at: Date.now(),
  });
}

export async function fileById(id: string): Promise<FileRow | undefined> {
  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  return row as FileRow | undefined;
}

export async function filesByUser(userId: string): Promise<FileRow[]> {
  const rows = await db
    .select()
    .from(files)
    .where(eq(files.user_id, userId))
    .orderBy(desc(files.created_at))
    .limit(100);
  return rows as FileRow[];
}
