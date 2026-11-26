/**
 * Drizzle schema for the Walkabout Coverage tables (epic #5891, Phase 1).
 * Spec: WALKABOUT_P1_SPEC.md §2.2. Migration 248 (WP1) creates them; indexes
 * live in the migration (DDL-only, project convention), listed here:
 *
 * `coverage_walkabout_sessions`
 *  - `cov_wk_sess_source_started_idx (sourceId, startedAt)`
 *  - `cov_wk_sess_ended_idx (endedAt)`
 *  - `cov_wk_sess_import_idx (importId)` (migration 250; partial on SQLite/PG)
 * `coverage_walkabout_samples`
 *  - `cov_wk_smp_session_fix_idx (sessionId, fixAt)`
 *  - `cov_wk_smp_source_idx (sourceId)`
 * `coverage_walkabout_receptions`
 *  - UNIQUE `cov_wk_rx_uniq (sessionId, packetKey, creditedKey)`
 *  - `cov_wk_rx_session_heard_idx (sessionId, heardAt)`
 *  - `cov_wk_rx_source_idx (sourceId)`
 *
 * PER-SOURCE (`sourceId`). No foreign keys (as `coverage_receptions`); the
 * repository deletes children in order. User data kept until deleted.
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, bigint as pgBigint, serial as pgSerial, doublePrecision as pgDouble } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite ============

export const coverageWalkaboutSessionsSqlite = sqliteTable('coverage_walkabout_sessions', {
  id: text('id').primaryKey(),
  sourceId: text('sourceId').notNull(),
  name: text('name'),
  startedAt: integer('startedAt').notNull(),
  endedAt: integer('endedAt'),
  endReason: text('endReason'),
  startedBy: integer('startedBy'),
  /** null = recorded live; set = created by a walkabout import (#6573, migration 250). */
  importId: text('importId'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

export const coverageWalkaboutSamplesSqlite = sqliteTable('coverage_walkabout_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('sessionId').notNull(),
  sourceId: text('sourceId').notNull(),
  latitude: real('latitude').notNull(),
  longitude: real('longitude').notNull(),
  accuracyM: real('accuracyM').notNull(),
  deviceFixAt: integer('deviceFixAt').notNull(),
  fixAt: integer('fixAt').notNull(),
  receivedAt: integer('receivedAt').notNull(),
});

export const coverageWalkaboutReceptionsSqlite = sqliteTable('coverage_walkabout_receptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('sessionId').notNull(),
  sourceId: text('sourceId').notNull(),
  protocol: text('protocol').notNull(),
  creditedKey: text('creditedKey').notNull(),
  creditedNodeNum: integer('creditedNodeNum'),
  creditKind: text('creditKind').notNull(),
  hopsAway: integer('hopsAway'),
  packetKey: text('packetKey').notNull(),
  snr: real('snr'),
  rssi: integer('rssi'),
  heardAt: integer('heardAt').notNull(),
  sampleId: integer('sampleId'),
  latitude: real('latitude').notNull(),
  longitude: real('longitude').notNull(),
  accuracyM: real('accuracyM').notNull(),
  sampleAgeMs: integer('sampleAgeMs').notNull(),
});

// ============ PostgreSQL ============

export const coverageWalkaboutSessionsPostgres = pgTable('coverage_walkabout_sessions', {
  id: pgText('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  name: pgText('name'),
  startedAt: pgBigint('startedAt', { mode: 'number' }).notNull(),
  endedAt: pgBigint('endedAt', { mode: 'number' }),
  endReason: pgText('endReason'),
  startedBy: pgInteger('startedBy'),
  importId: pgText('importId'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

export const coverageWalkaboutSamplesPostgres = pgTable('coverage_walkabout_samples', {
  id: pgSerial('id').primaryKey(),
  sessionId: pgText('sessionId').notNull(),
  sourceId: pgText('sourceId').notNull(),
  latitude: pgDouble('latitude').notNull(),
  longitude: pgDouble('longitude').notNull(),
  accuracyM: pgReal('accuracyM').notNull(),
  deviceFixAt: pgBigint('deviceFixAt', { mode: 'number' }).notNull(),
  fixAt: pgBigint('fixAt', { mode: 'number' }).notNull(),
  receivedAt: pgBigint('receivedAt', { mode: 'number' }).notNull(),
});

export const coverageWalkaboutReceptionsPostgres = pgTable('coverage_walkabout_receptions', {
  id: pgSerial('id').primaryKey(),
  sessionId: pgText('sessionId').notNull(),
  sourceId: pgText('sourceId').notNull(),
  protocol: pgText('protocol').notNull(),
  creditedKey: pgText('creditedKey').notNull(),
  // Meshtastic node numbers are unsigned 32-bit; PG INTEGER is signed.
  creditedNodeNum: pgBigint('creditedNodeNum', { mode: 'number' }),
  creditKind: pgText('creditKind').notNull(),
  hopsAway: pgInteger('hopsAway'),
  packetKey: pgText('packetKey').notNull(),
  snr: pgReal('snr'),
  rssi: pgInteger('rssi'),
  heardAt: pgBigint('heardAt', { mode: 'number' }).notNull(),
  sampleId: pgInteger('sampleId'),
  latitude: pgDouble('latitude').notNull(),
  longitude: pgDouble('longitude').notNull(),
  accuracyM: pgReal('accuracyM').notNull(),
  sampleAgeMs: pgInteger('sampleAgeMs').notNull(),
});

// ============ MySQL ============

export const coverageWalkaboutSessionsMysql = mysqlTable('coverage_walkabout_sessions', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  name: myVarchar('name', { length: 120 }),
  startedAt: myBigint('startedAt', { mode: 'number' }).notNull(),
  endedAt: myBigint('endedAt', { mode: 'number' }),
  endReason: myVarchar('endReason', { length: 16 }),
  startedBy: myInt('startedBy'),
  importId: myVarchar('importId', { length: 36 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export const coverageWalkaboutSamplesMysql = mysqlTable('coverage_walkabout_samples', {
  id: myInt('id').autoincrement().primaryKey(),
  sessionId: myVarchar('sessionId', { length: 36 }).notNull(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  latitude: myDouble('latitude').notNull(),
  longitude: myDouble('longitude').notNull(),
  accuracyM: myDouble('accuracyM').notNull(),
  deviceFixAt: myBigint('deviceFixAt', { mode: 'number' }).notNull(),
  fixAt: myBigint('fixAt', { mode: 'number' }).notNull(),
  receivedAt: myBigint('receivedAt', { mode: 'number' }).notNull(),
});

export const coverageWalkaboutReceptionsMysql = mysqlTable('coverage_walkabout_receptions', {
  id: myInt('id').autoincrement().primaryKey(),
  sessionId: myVarchar('sessionId', { length: 36 }).notNull(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  protocol: myVarchar('protocol', { length: 16 }).notNull(),
  creditedKey: myVarchar('creditedKey', { length: 80 }).notNull(),
  creditedNodeNum: myBigint('creditedNodeNum', { mode: 'number' }),
  creditKind: myVarchar('creditKind', { length: 8 }).notNull(),
  hopsAway: myInt('hopsAway'),
  packetKey: myVarchar('packetKey', { length: 80 }).notNull(),
  snr: myDouble('snr'),
  rssi: myInt('rssi'),
  heardAt: myBigint('heardAt', { mode: 'number' }).notNull(),
  sampleId: myInt('sampleId'),
  latitude: myDouble('latitude').notNull(),
  longitude: myDouble('longitude').notNull(),
  accuracyM: myDouble('accuracyM').notNull(),
  sampleAgeMs: myInt('sampleAgeMs').notNull(),
});
