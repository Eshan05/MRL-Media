import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core';

export const files = pgTable(
  'files',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    stored_as: text('stored_as').notNull().unique(),
    original_name: text('original_name'),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('idx_files_user').on(table.user_id)],
);

export const objects = pgTable('objects', {
  object_key: text('object_key').primaryKey(),
  content_type: text('content_type').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  data_base64: text('data_base64').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
});
