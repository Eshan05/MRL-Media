import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { Tier } from './jobs/types.js';
import { files } from './db/schema/app.js';
import { DATA_DIR } from './paths.js';

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

mkdirSync(DATA_DIR, { recursive: true });

export const sqlite = new Database(path.join(DATA_DIR, 'mrl.db'));
// WAL so multiple API instances (one file, N processes) read while one writes
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    stored_as TEXT NOT NULL UNIQUE,
    original_name TEXT,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);
`);

export function recordFile(file: Omit<FileRow, 'created_at'>): void {
  db.insert(files)
    .values({
      id: file.id,
      user_id: file.user_id,
      stored_as: file.stored_as,
      original_name: file.original_name,
      bytes: file.bytes,
      created_at: Date.now(),
    })
    .run();
}

export function fileById(id: string): FileRow | undefined {
  return db.select().from(files).where(eq(files.id, id)).get() as FileRow | undefined;
}

export function filesByUser(userId: string): FileRow[] {
  return db
    .select()
    .from(files)
    .where(eq(files.user_id, userId))
    .orderBy(desc(files.created_at))
    .limit(100)
    .all() as FileRow[];
}
