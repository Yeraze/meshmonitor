/**
 * Drizzle schema for `direct_rf_contacts` (#6210, Direct RF Contacts).
 *
 * A daily rollup of the nodes a source's own radio heard directly over RF:
 * one row per (sourceId, nodeKey, dayBucket). Written by
 * `directRfContactRecorder.ts` from the live RX paths (Meshtastic TCP and the
 * MeshCore companion); read by `/api/sources/:id/direct-rf-contacts` and the
 * Info tab network survey.
 *
 * PER-SOURCE: every row has a `sourceId`; reads scope through
 * `withSourceScope`. Source deletion / node purge removes a source's rows.
 *
 *  - `nodeKey`: `!xxxxxxxx` for Meshtastic, the 64-hex public key for
 *    MeshCore (the same id forms `cross_source_links` uses).
 *  - `nodeNum`: the Meshtastic node number; NULL for MeshCore.
 *  - `dayBucket`: unix ms floored to the UTC day.
 *  - `firstHeardAt` / `lastHeardAt`: server time (ms) of the first and last
 *    direct reception within the day.
 *  - `snrSum` / `rssiSum` over `snrCount` / `rssiCount` give the average; a
 *    reception can lack either reading, so the counts differ from
 *    `receptionCount`.
 *
 * Retention: `direct_rf_contacts_retention_days` (default 30), swept hourly
 * by `directRfContactsRetentionService`. In `BACKUP_TABLES`: the packet log
 * this replaces rolls over, so this history cannot be rebuilt.
 *
 * Indexes (declared in the migration):
 *  - UNIQUE `direct_rf_contacts_day_uniq (sourceId, nodeKey, dayBucket)`
 *  - `direct_rf_contacts_source_day_idx (sourceId, dayBucket)`: window query
 *  - `direct_rf_contacts_day_idx (dayBucket)`: retention purge
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint, serial as pgSerial, doublePrecision as pgDouble } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, bigint as myBigint } from 'drizzle-orm/mysql-core';

export const directRfContactsSqlite = sqliteTable('direct_rf_contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  protocol: text('protocol').notNull(),
  nodeKey: text('nodeKey').notNull(),
  nodeNum: integer('nodeNum'),
  dayBucket: integer('dayBucket').notNull(),
  firstHeardAt: integer('firstHeardAt').notNull(),
  lastHeardAt: integer('lastHeardAt').notNull(),
  receptionCount: integer('receptionCount').notNull(),
  bestSnr: real('bestSnr'),
  bestRssi: real('bestRssi'),
  snrSum: real('snrSum').notNull(),
  snrCount: integer('snrCount').notNull(),
  rssiSum: real('rssiSum').notNull(),
  rssiCount: integer('rssiCount').notNull(),
});

export const directRfContactsPostgres = pgTable('direct_rf_contacts', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  protocol: pgText('protocol').notNull(),
  nodeKey: pgText('nodeKey').notNull(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }),
  dayBucket: pgBigint('dayBucket', { mode: 'number' }).notNull(),
  firstHeardAt: pgBigint('firstHeardAt', { mode: 'number' }).notNull(),
  lastHeardAt: pgBigint('lastHeardAt', { mode: 'number' }).notNull(),
  receptionCount: pgInteger('receptionCount').notNull(),
  bestSnr: pgDouble('bestSnr'),
  bestRssi: pgDouble('bestRssi'),
  snrSum: pgDouble('snrSum').notNull(),
  snrCount: pgInteger('snrCount').notNull(),
  rssiSum: pgDouble('rssiSum').notNull(),
  rssiCount: pgInteger('rssiCount').notNull(),
});

export const directRfContactsMysql = mysqlTable('direct_rf_contacts', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  protocol: myVarchar('protocol', { length: 16 }).notNull(),
  nodeKey: myVarchar('nodeKey', { length: 80 }).notNull(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }),
  dayBucket: myBigint('dayBucket', { mode: 'number' }).notNull(),
  firstHeardAt: myBigint('firstHeardAt', { mode: 'number' }).notNull(),
  lastHeardAt: myBigint('lastHeardAt', { mode: 'number' }).notNull(),
  receptionCount: myInt('receptionCount').notNull(),
  bestSnr: myDouble('bestSnr'),
  bestRssi: myDouble('bestRssi'),
  snrSum: myDouble('snrSum').notNull(),
  snrCount: myInt('snrCount').notNull(),
  rssiSum: myDouble('rssiSum').notNull(),
  rssiCount: myInt('rssiCount').notNull(),
});

export type DirectRfContactSqlite = typeof directRfContactsSqlite.$inferSelect;
export type DirectRfContactPostgres = typeof directRfContactsPostgres.$inferSelect;
export type DirectRfContactMysql = typeof directRfContactsMysql.$inferSelect;
