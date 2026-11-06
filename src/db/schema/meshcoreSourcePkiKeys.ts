/**
 * Drizzle schema for `meshcore_source_pki_keys` — one row per MeshCore
 * Companion source holding THAT device's own Ed25519 identity private key
 * (orlp format), captured automatically on connect and used server-side to
 * decrypt our own echoed direct messages for exact #6194 heard-by matching
 * (issue #6195). Encrypted at rest (AES-256-GCM envelope, see
 * meshcoreSourcePkiKeyStore).
 *
 * The private key is stored ONLY as the encrypted envelope JSON in
 * `encryptedPrivateKey`; `publicKey` (32-byte Ed25519 hex) is kept in the
 * clear for display / mismatch-detection — it is not secret, it is broadcast
 * over the air in every ADVERT. `keyMismatch` is set when the device reports a
 * different public key than the stored one, so we refuse to silently overwrite
 * a captured key. Kept out of `sources.config` and the settings API so the key
 * material never rides along in general config responses (same reasoning as
 * `source_pki_keys` / `meshcore_observer_keys` — see those schemas' header
 * comments).
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite
export const meshcoreSourcePkiKeysSqlite = sqliteTable('meshcore_source_pki_keys', {
  sourceId: text('sourceId').primaryKey(),
  encryptedPrivateKey: text('encryptedPrivateKey').notNull(),
  publicKey: text('publicKey'),
  keyMismatch: integer('keyMismatch').notNull().default(0),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL
export const meshcoreSourcePkiKeysPostgres = pgTable('meshcore_source_pki_keys', {
  sourceId: pgText('sourceId').primaryKey(),
  encryptedPrivateKey: pgText('encryptedPrivateKey').notNull(),
  publicKey: pgText('publicKey'),
  keyMismatch: pgInteger('keyMismatch').notNull().default(0),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const meshcoreSourcePkiKeysMysql = mysqlTable('meshcore_source_pki_keys', {
  sourceId: myVarchar('sourceId', { length: 36 }).primaryKey(),
  encryptedPrivateKey: myText('encryptedPrivateKey').notNull(),
  publicKey: myVarchar('publicKey', { length: 64 }),
  keyMismatch: myInt('keyMismatch').notNull().default(0),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export type MeshCoreSourcePkiKeySqlite = typeof meshcoreSourcePkiKeysSqlite.$inferSelect;
export type NewMeshCoreSourcePkiKeySqlite = typeof meshcoreSourcePkiKeysSqlite.$inferInsert;
export type MeshCoreSourcePkiKeyPostgres = typeof meshcoreSourcePkiKeysPostgres.$inferSelect;
export type MeshCoreSourcePkiKeyMysql = typeof meshcoreSourcePkiKeysMysql.$inferSelect;
