/**
 * Drizzle schema for `script_secrets` — named values (API keys and the like)
 * that user scripts receive as environment variables.
 *
 * GLOBAL by design: one row per name, no `sourceId`. Every user script run on
 * every source gets every stored secret, the way a script would see a
 * variable set in the container's environment.
 *
 * `encryptedValue` is an AES-256-GCM envelope JSON keyed from SESSION_SECRET
 * (see `scriptSecretStore.ts`), never the plain value. `name` is in the clear:
 * it is the environment variable name, and the UI lists it.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite
export const scriptSecretsSqlite = sqliteTable('script_secrets', {
  name: text('name').primaryKey(),
  encryptedValue: text('encryptedValue').notNull(),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL
export const scriptSecretsPostgres = pgTable('script_secrets', {
  name: pgText('name').primaryKey(),
  encryptedValue: pgText('encryptedValue').notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const scriptSecretsMysql = mysqlTable('script_secrets', {
  name: myVarchar('name', { length: 64 }).primaryKey(),
  encryptedValue: myText('encryptedValue').notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export type ScriptSecretSqlite = typeof scriptSecretsSqlite.$inferSelect;
export type ScriptSecretPostgres = typeof scriptSecretsPostgres.$inferSelect;
export type ScriptSecretMysql = typeof scriptSecretsMysql.$inferSelect;
