import { bigint, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { PROCESSING_STATES, type TranscodeJobData, type TranscodeOutput } from '../../jobs/types.js';

export const files = pgTable(
  'files',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id'),
    stored_as: text('stored_as').notNull().unique(),
    original_name: text('original_name'),
    visibility: text('visibility').notNull().default('private'),
    access_code_hash: text('access_code_hash'),
    webhook_url: text('webhook_url'),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
    expires_at: bigint('expires_at', { mode: 'number' }),
    processing_status: text('processing_status', { enum: PROCESSING_STATES }).notNull().default('completed'),
    processing_outputs: jsonb('processing_outputs').$type<TranscodeOutput[]>(),
    processing_error: text('processing_error'),
    processing_started_at: bigint('processing_started_at', { mode: 'number' }),
    processing_finished_at: bigint('processing_finished_at', { mode: 'number' }),
    processing_updated_at: bigint('processing_updated_at', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('idx_files_user').on(table.user_id),
    index('idx_files_expiry').on(table.expires_at),
    index('idx_files_processing').on(table.processing_status, table.processing_updated_at),
  ],
);

export const jobOutbox = pgTable(
  'job_outbox',
  {
    id: text('id').primaryKey(),
    file_id: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['transcode'] }).notNull(),
    payload: jsonb('payload').$type<TranscodeJobData>().notNull(),
    status: text('status', { enum: ['pending', 'dispatched'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    available_at: bigint('available_at', { mode: 'number' }).notNull(),
    locked_at: bigint('locked_at', { mode: 'number' }),
    dispatched_at: bigint('dispatched_at', { mode: 'number' }),
    last_error: text('last_error'),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('job_outbox_file_kind_unique').on(table.file_id, table.kind),
    index('idx_job_outbox_pending').on(table.status, table.available_at, table.locked_at),
  ],
);

export const objects = pgTable('objects', {
  object_key: text('object_key').primaryKey(),
  content_type: text('content_type').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  data_base64: text('data_base64').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
});
