import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    stored_as: text('stored_as').notNull().unique(),
    original_name: text('original_name'),
    bytes: integer('bytes').notNull(),
    created_at: integer('created_at').notNull(),
  },
  (table) => [index('idx_files_user').on(table.user_id)],
);
