/**
 * Drizzle schema for `source_pki_keys` — one row per Meshtastic source holding
 * that source's local-node X25519 PRIVATE key, encrypted at rest (AES-256-GCM
 * envelope, see sourcePkiKeyStore). Used to decrypt PKI direct messages
 * server-side so they can be surfaced in the unified view (issue #3441).
 *
 * The private key is stored ONLY as the encrypted envelope JSON in
 * `encryptedPrivateKey`; `publicKey` (base64) is kept in the clear for display /
 * sanity-checking. Kept out of the `sources.config` blob and the settings API so
 * the key material never rides along in general config responses.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite
export const sourcePkiKeysSqlite = sqliteTable('source_pki_keys', {
  sourceId: text('sourceId').primaryKey(),
  encryptedPrivateKey: text('encryptedPrivateKey').notNull(),
  publicKey: text('publicKey'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL
export const sourcePkiKeysPostgres = pgTable('source_pki_keys', {
  sourceId: pgText('sourceId').primaryKey(),
  encryptedPrivateKey: pgText('encryptedPrivateKey').notNull(),
  publicKey: pgText('publicKey'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const sourcePkiKeysMysql = mysqlTable('source_pki_keys', {
  sourceId: myVarchar('sourceId', { length: 36 }).primaryKey(),
  encryptedPrivateKey: myText('encryptedPrivateKey').notNull(),
  publicKey: myVarchar('publicKey', { length: 128 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export type SourcePkiKeySqlite = typeof sourcePkiKeysSqlite.$inferSelect;
export type NewSourcePkiKeySqlite = typeof sourcePkiKeysSqlite.$inferInsert;
export type SourcePkiKeyPostgres = typeof sourcePkiKeysPostgres.$inferSelect;
export type SourcePkiKeyMysql = typeof sourcePkiKeysMysql.$inferSelect;
