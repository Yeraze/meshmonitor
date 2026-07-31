/**
 * Drizzle schema for `meshcore_observer_keys` — one row per MeshCore source
 * holding that source's companion Ed25519 signing key (orlp format), used to
 * mint MeshCore Analyzer Observer auth tokens (epic #4457). Encrypted at rest
 * (AES-256-GCM envelope, see meshcoreObserverKeyStore).
 *
 * The private key is stored ONLY as the encrypted envelope JSON in
 * `encryptedPrivateKey`; `publicKey` (32-byte hex, uppercase) is kept in the
 * clear for display / sanity-checking — it is not secret, it is broadcast
 * over the air in every ADVERT. Kept out of `sources.config` and the settings
 * API so the key material never rides along in general config responses
 * (same reasoning as `source_pki_keys` — see that schema's header comment).
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite
export const meshcoreObserverKeysSqlite = sqliteTable('meshcore_observer_keys', {
  sourceId: text('sourceId').primaryKey(),
  encryptedPrivateKey: text('encryptedPrivateKey').notNull(),
  publicKey: text('publicKey'),
  keyOrigin: text('keyOrigin'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL
export const meshcoreObserverKeysPostgres = pgTable('meshcore_observer_keys', {
  sourceId: pgText('sourceId').primaryKey(),
  encryptedPrivateKey: pgText('encryptedPrivateKey').notNull(),
  publicKey: pgText('publicKey'),
  keyOrigin: pgText('keyOrigin'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const meshcoreObserverKeysMysql = mysqlTable('meshcore_observer_keys', {
  sourceId: myVarchar('sourceId', { length: 36 }).primaryKey(),
  encryptedPrivateKey: myText('encryptedPrivateKey').notNull(),
  publicKey: myVarchar('publicKey', { length: 64 }),
  keyOrigin: myVarchar('keyOrigin', { length: 16 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export type MeshCoreObserverKeySqlite = typeof meshcoreObserverKeysSqlite.$inferSelect;
export type NewMeshCoreObserverKeySqlite = typeof meshcoreObserverKeysSqlite.$inferInsert;
export type MeshCoreObserverKeyPostgres = typeof meshcoreObserverKeysPostgres.$inferSelect;
export type MeshCoreObserverKeyMysql = typeof meshcoreObserverKeysMysql.$inferSelect;
