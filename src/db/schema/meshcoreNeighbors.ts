import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, serial as mySerial } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcoreNeighborsSqlite = sqliteTable('meshcore_neighbor_info', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  publicKey: text('publicKey').notNull(),
  neighborPublicKey: text('neighborPublicKey').notNull(),
  snr: real('snr'),
  lastHeardSecs: integer('lastHeardSecs'),
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const meshcoreNeighborsPostgres = pgTable('meshcore_neighbor_info', {
  id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
  sourceId: pgText('sourceId').notNull(),
  publicKey: pgText('publicKey').notNull(),
  neighborPublicKey: pgText('neighborPublicKey').notNull(),
  snr: pgReal('snr'),
  lastHeardSecs: pgInteger('lastHeardSecs'),
  timestamp: pgInteger('timestamp').notNull(),
  createdAt: pgInteger('createdAt').notNull(),
});

// ============ MySQL Schema ============

export const meshcoreNeighborsMysql = mysqlTable('meshcore_neighbor_info', {
  id: mySerial('id').primaryKey(),
  sourceId: myVarchar('sourceId', { length: 255 }).notNull(),
  publicKey: myVarchar('publicKey', { length: 64 }).notNull(),
  neighborPublicKey: myVarchar('neighborPublicKey', { length: 64 }).notNull(),
  snr: myDouble('snr'),
  lastHeardSecs: myInt('lastHeardSecs'),
  timestamp: myInt('timestamp').notNull(),
  createdAt: myInt('createdAt').notNull(),
});
