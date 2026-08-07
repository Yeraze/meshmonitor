/**
 * Drizzle schema for `meshcore_observer_credentials` — one row per MeshCore
 * source holding that source's STATIC MQTT broker credentials for the
 * Analyzer Observer (issue #4595).
 *
 * Some regional Analyzer brokers (e.g. meshcoretel.ru) do not verify the
 * Ed25519-signed token the `v1_{PUBLIC_KEY}` scheme produces; they want a
 * plain MQTT username/password instead. That password is a secret and gets
 * exactly the same treatment as the signing key in `meshcore_observer_keys`:
 * an AES-256-GCM envelope keyed off SESSION_SECRET (see
 * `meshcoreObserverCredentialStore.ts`), never a plaintext column and never a
 * field inside `sources.config`.
 *
 * `username` is deliberately kept in the CLEAR: it is not a secret (it is
 * sent in the MQTT CONNECT packet in plaintext on a non-TLS broker anyway),
 * and the UI must be able to show which account is configured — the same
 * split the sibling table uses for `publicKey` vs `encryptedPrivateKey`.
 *
 * A separate table, not two more columns on `meshcore_observer_keys`, because
 * that table's `encryptedPrivateKey` is NOT NULL: a password-mode source has
 * no signing key at all, and there is no honest value to put there.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite
export const meshcoreObserverCredentialsSqlite = sqliteTable('meshcore_observer_credentials', {
  sourceId: text('sourceId').primaryKey(),
  username: text('username').notNull(),
  encryptedPassword: text('encryptedPassword').notNull(),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL
export const meshcoreObserverCredentialsPostgres = pgTable('meshcore_observer_credentials', {
  sourceId: pgText('sourceId').primaryKey(),
  username: pgText('username').notNull(),
  encryptedPassword: pgText('encryptedPassword').notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const meshcoreObserverCredentialsMysql = mysqlTable('meshcore_observer_credentials', {
  sourceId: myVarchar('sourceId', { length: 36 }).primaryKey(),
  username: myVarchar('username', { length: 255 }).notNull(),
  encryptedPassword: myText('encryptedPassword').notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export type MeshCoreObserverCredentialSqlite = typeof meshcoreObserverCredentialsSqlite.$inferSelect;
export type NewMeshCoreObserverCredentialSqlite = typeof meshcoreObserverCredentialsSqlite.$inferInsert;
export type MeshCoreObserverCredentialPostgres = typeof meshcoreObserverCredentialsPostgres.$inferSelect;
export type MeshCoreObserverCredentialMysql = typeof meshcoreObserverCredentialsMysql.$inferSelect;
