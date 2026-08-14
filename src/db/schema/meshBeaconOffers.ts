/**
 * Drizzle schema for received MeshBeacon offers (firmware 2.8+, #4723).
 *
 * Beacons were previously transient: `buildMeshBeaconContext` fired automations
 * off the packet and the offer was discarded. An actionable invitation card
 * needs them to outlive the packet — both to render at all, and so a dismissal
 * survives the next rebroadcast instead of nagging.
 *
 * Per-source, keyed on (sourceId, nodeNum): one live offer per beaconing node
 * per source. A rebroadcast UPDATES the row rather than appending, so the table
 * stays bounded by the number of beaconing neighbours, not by uptime.
 *
 * Supports SQLite, PostgreSQL, and MySQL.
 */
import {
  sqliteTable,
  text,
  integer,
  primaryKey as sqlitePrimaryKey,
  index as sqliteIndex,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  bigint as pgBigint,
  integer as pgInteger,
  boolean as pgBoolean,
  primaryKey as pgPrimaryKey,
  index as pgIndex,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  text as myText,
  bigint as myBigint,
  int as myInt,
  boolean as myBoolean,
  primaryKey as myPrimaryKey,
  index as myIndex,
} from 'drizzle-orm/mysql-core';

// ============ SQLite ============

export const meshBeaconOffersSqlite = sqliteTable('mesh_beacon_offers', {
  sourceId: text('sourceId').notNull(),
  /** Beaconing node's number (unsigned 32-bit). */
  nodeNum: integer('nodeNum').notNull(),
  /** Free-text beacon body; may be empty when the beacon carries only an offer. */
  message: text('message'),
  /** Channel the beacon advertises, when it advertises one. */
  offerChannelName: text('offerChannelName'),
  /** Meshtastic region enum; null when the beacon offers no region. */
  offerRegion: integer('offerRegion'),
  /** Modem-preset enum; null when the beacon offers no preset. */
  offerPreset: integer('offerPreset'),
  /**
   * True when the beacon advertises a joinable network (any of channel/region/
   * preset). Mirrors the `hasOffer` convenience flag on the automation trigger
   * so a card can filter without comparing three optional columns.
   */
  hasOffer: integer('hasOffer', { mode: 'boolean' }).notNull(),
  /** ms epoch first seen; preserved across rebroadcasts. */
  firstSeenAt: integer('firstSeenAt').notNull(),
  /** ms epoch of the most recent rebroadcast. */
  lastSeenAt: integer('lastSeenAt').notNull(),
  /**
   * ms epoch the user dismissed this offer; null = still showing.
   *
   * A rebroadcast must NOT clear this — that is the whole point of persisting
   * it. It IS cleared when the offer's *content* changes (a different channel,
   * region or preset), because that is a new invitation rather than a repeat of
   * the one already declined.
   */
  dismissedAt: integer('dismissedAt'),
}, (table) => ({
  pk: sqlitePrimaryKey({ columns: [table.sourceId, table.nodeNum] }),
  lastSeenIdx: sqliteIndex('idx_mesh_beacon_offers_lastSeenAt').on(table.lastSeenAt),
}));

// ============ PostgreSQL ============

export const meshBeaconOffersPostgres = pgTable('mesh_beacon_offers', {
  sourceId: pgText('sourceId').notNull(),
  // nodeNum is unsigned 32-bit; PG INTEGER is signed 32-bit.
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull(),
  message: pgText('message'),
  offerChannelName: pgText('offerChannelName'),
  offerRegion: pgInteger('offerRegion'),
  offerPreset: pgInteger('offerPreset'),
  hasOffer: pgBoolean('hasOffer').notNull(),
  // ms-epoch timestamps overflow 32-bit INTEGER.
  firstSeenAt: pgBigint('firstSeenAt', { mode: 'number' }).notNull(),
  lastSeenAt: pgBigint('lastSeenAt', { mode: 'number' }).notNull(),
  dismissedAt: pgBigint('dismissedAt', { mode: 'number' }),
}, (table) => ({
  pk: pgPrimaryKey({ columns: [table.sourceId, table.nodeNum] }),
  lastSeenIdx: pgIndex('idx_mesh_beacon_offers_lastSeenAt').on(table.lastSeenAt),
}));

// ============ MySQL ============

export const meshBeaconOffersMysql = mysqlTable('mesh_beacon_offers', {
  // MySQL PK columns must be bounded length, not TEXT.
  sourceId: myVarchar('sourceId', { length: 191 }).notNull(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull(),
  message: myText('message'),
  offerChannelName: myVarchar('offerChannelName', { length: 255 }),
  offerRegion: myInt('offerRegion'),
  offerPreset: myInt('offerPreset'),
  hasOffer: myBoolean('hasOffer').notNull(),
  firstSeenAt: myBigint('firstSeenAt', { mode: 'number' }).notNull(),
  lastSeenAt: myBigint('lastSeenAt', { mode: 'number' }).notNull(),
  dismissedAt: myBigint('dismissedAt', { mode: 'number' }),
}, (table) => ({
  pk: myPrimaryKey({ columns: [table.sourceId, table.nodeNum] }),
  lastSeenIdx: myIndex('idx_mesh_beacon_offers_lastSeenAt').on(table.lastSeenAt),
}));

// ============ TYPE INFERENCE ============

export type MeshBeaconOfferSqlite = typeof meshBeaconOffersSqlite.$inferSelect;
export type NewMeshBeaconOfferSqlite = typeof meshBeaconOffersSqlite.$inferInsert;
export type MeshBeaconOfferPostgres = typeof meshBeaconOffersPostgres.$inferSelect;
export type NewMeshBeaconOfferPostgres = typeof meshBeaconOffersPostgres.$inferInsert;
export type MeshBeaconOfferMysql = typeof meshBeaconOffersMysql.$inferSelect;
export type NewMeshBeaconOfferMysql = typeof meshBeaconOffersMysql.$inferInsert;
