/**
 * Drizzle schema for `cross_source_links` (#5561, map "heard here" edges).
 *
 * An hourly aggregate of "source A's radio was heard by source B": one row
 * per (tx source + node, rx source + node, kind, transport, hour). Written
 * from the live RX paths (Meshtastic, MQTT ingest, MeshCore OTA) by
 * `crossSourceLinkRecorder.ts`; read by `/api/analysis/cross-source-links`.
 *
 * NOT per-source in the usual sense: a row names TWO sources (`txSourceId`,
 * `rxSourceId`) and has no single `sourceId` column. The read rule is that a
 * viewer must be able to read BOTH (see CLAUDE.md's exception list).
 *
 *  - `kind`: `origin` (the packet came from A's own node, heard directly) or
 *    `relay` (A most likely relayed it; inferred from a short relay hash).
 *  - `transportClass`: `rf` (B's own radio heard it) or `mqtt_gateway` (a
 *    gateway/observer on source B heard it over its radio). Broker-delivered
 *    MQTT and UDP copies are not RF edges and are never stored.
 *  - `txNodeId` / `rxNodeId`: the radios at each end (`!xxxxxxxx` or a
 *    MeshCore public key). `rxNodeId` is B's own node for `rf`, the gateway /
 *    observer for `mqtt_gateway`.
 *  - `hourBucket`: unix ms floored to the hour.
 *  - `snrAvg` / `rssiAvg` are running means over `snrCount` / `rssiCount`
 *    samples (a hearing can lack either reading).
 *
 * Regenerable data bounded by the coverage retention window: NOT in
 * `BACKUP_TABLES`, same as non-survey coverage receptions.
 *
 * Indexes (declared in the migration):
 *  - UNIQUE `xs_links_bucket_uniq (txSourceId, txNodeId, rxSourceId, rxNodeId, kind, transportClass, hourBucket)`
 *  - `xs_links_bucket_idx (hourBucket)`: window query + retention purge.
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, bigint as pgBigint, serial as pgSerial, doublePrecision as pgDouble } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, bigint as myBigint } from 'drizzle-orm/mysql-core';

export const crossSourceLinksSqlite = sqliteTable('cross_source_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  txSourceId: text('txSourceId').notNull(),
  txNodeId: text('txNodeId').notNull(),
  rxSourceId: text('rxSourceId').notNull(),
  rxNodeId: text('rxNodeId').notNull(),
  protocol: text('protocol').notNull(),
  kind: text('kind').notNull(),
  transportClass: text('transportClass').notNull(),
  hourBucket: integer('hourBucket').notNull(),
  count: integer('count').notNull(),
  snrMin: real('snrMin'),
  snrAvg: real('snrAvg'),
  snrMax: real('snrMax'),
  snrCount: integer('snrCount').notNull(),
  rssiAvg: real('rssiAvg'),
  rssiCount: integer('rssiCount').notNull(),
  lastHeardAt: integer('lastHeardAt').notNull(),
});

export const crossSourceLinksPostgres = pgTable('cross_source_links', {
  id: pgSerial('id').primaryKey(),
  txSourceId: pgText('txSourceId').notNull(),
  txNodeId: pgText('txNodeId').notNull(),
  rxSourceId: pgText('rxSourceId').notNull(),
  rxNodeId: pgText('rxNodeId').notNull(),
  protocol: pgText('protocol').notNull(),
  kind: pgText('kind').notNull(),
  transportClass: pgText('transportClass').notNull(),
  hourBucket: pgBigint('hourBucket', { mode: 'number' }).notNull(),
  count: pgInteger('count').notNull(),
  snrMin: pgDouble('snrMin'),
  snrAvg: pgDouble('snrAvg'),
  snrMax: pgDouble('snrMax'),
  snrCount: pgInteger('snrCount').notNull(),
  rssiAvg: pgDouble('rssiAvg'),
  rssiCount: pgInteger('rssiCount').notNull(),
  lastHeardAt: pgBigint('lastHeardAt', { mode: 'number' }).notNull(),
});

export const crossSourceLinksMysql = mysqlTable('cross_source_links', {
  id: myInt('id').autoincrement().primaryKey(),
  txSourceId: myVarchar('txSourceId', { length: 64 }).notNull(),
  txNodeId: myVarchar('txNodeId', { length: 80 }).notNull(),
  rxSourceId: myVarchar('rxSourceId', { length: 64 }).notNull(),
  rxNodeId: myVarchar('rxNodeId', { length: 80 }).notNull(),
  protocol: myVarchar('protocol', { length: 16 }).notNull(),
  kind: myVarchar('kind', { length: 16 }).notNull(),
  transportClass: myVarchar('transportClass', { length: 16 }).notNull(),
  hourBucket: myBigint('hourBucket', { mode: 'number' }).notNull(),
  count: myInt('count').notNull(),
  snrMin: myDouble('snrMin'),
  snrAvg: myDouble('snrAvg'),
  snrMax: myDouble('snrMax'),
  snrCount: myInt('snrCount').notNull(),
  rssiAvg: myDouble('rssiAvg'),
  rssiCount: myInt('rssiCount').notNull(),
  lastHeardAt: myBigint('lastHeardAt', { mode: 'number' }).notNull(),
});

export type CrossSourceLinkSqlite = typeof crossSourceLinksSqlite.$inferSelect;
export type CrossSourceLinkPostgres = typeof crossSourceLinksPostgres.$inferSelect;
export type CrossSourceLinkMysql = typeof crossSourceLinksMysql.$inferSelect;
