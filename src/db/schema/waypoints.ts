/**
 * Drizzle schema definition for the waypoints table
 *
 * Stores Meshtastic waypoints (PortNum.WAYPOINT_APP, ID 8). Per-source: each
 * source maintains its own waypoint set keyed on (sourceId, waypointId).
 * Supports SQLite, PostgreSQL, and MySQL.
 */
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey as sqlitePrimaryKey,
  index as sqliteIndex,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  bigint as pgBigint,
  integer as pgInteger,
  doublePrecision as pgDouble,
  primaryKey as pgPrimaryKey,
  index as pgIndex,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  text as myText,
  bigint as myBigint,
  int as myInt,
  double as myDouble,
  primaryKey as myPrimaryKey,
  index as myIndex,
} from 'drizzle-orm/mysql-core';

// ============ SQLite ============

export const waypointsSqlite = sqliteTable('waypoints', {
  sourceId: text('source_id').notNull(),
  waypointId: integer('waypoint_id').notNull(),
  ownerNodeNum: integer('owner_node_num'),
  latitude: real('latitude').notNull(),
  longitude: real('longitude').notNull(),
  expireAt: integer('expire_at'),
  lockedTo: integer('locked_to'),
  name: text('name').notNull().default(''),
  description: text('description').notNull().default(''),
  iconCodepoint: integer('icon_codepoint'),
  iconEmoji: text('icon_emoji'),
  isVirtual: integer('is_virtual').notNull().default(0),
  /** Device channel slot the waypoint is broadcast on. NULL = slot 0 (#4341). */
  channel: integer('channel'),
  rebroadcastIntervalS: integer('rebroadcast_interval_s'),
  /** Hop limit 0-7 the waypoint is sent with. NULL = the node's configured limit (#5482). */
  hopLimit: integer('hop_limit'),
  /** `<automationId>:<waypointKey>` for waypoints owned by an automation step (#5482). */
  automationKey: text('automation_key'),
  /** Digest of the content an automation step last sent (#5482, onlyWhenChanged). */
  broadcastFingerprint: text('broadcast_fingerprint'),
  lastBroadcastAt: integer('last_broadcast_at'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastUpdatedAt: integer('last_updated_at').notNull(),
}, (table) => ({
  pk: sqlitePrimaryKey({ columns: [table.sourceId, table.waypointId] }),
  expireIdx: sqliteIndex('idx_waypoints_source_expire').on(table.sourceId, table.expireAt),
  ownerIdx: sqliteIndex('idx_waypoints_source_owner').on(table.sourceId, table.ownerNodeNum),
}));

// ============ PostgreSQL ============

export const waypointsPostgres = pgTable('waypoints', {
  sourceId: pgText('source_id').notNull(),
  waypointId: pgBigint('waypoint_id', { mode: 'number' }).notNull(),
  ownerNodeNum: pgBigint('owner_node_num', { mode: 'number' }),
  latitude: pgDouble('latitude').notNull(),
  longitude: pgDouble('longitude').notNull(),
  expireAt: pgBigint('expire_at', { mode: 'number' }),
  lockedTo: pgBigint('locked_to', { mode: 'number' }),
  name: pgText('name').notNull().default(''),
  description: pgText('description').notNull().default(''),
  iconCodepoint: pgInteger('icon_codepoint'),
  iconEmoji: pgText('icon_emoji'),
  isVirtual: pgInteger('is_virtual').notNull().default(0),
  /** Device channel slot the waypoint is broadcast on. NULL = slot 0 (#4341). */
  channel: pgInteger('channel'),
  rebroadcastIntervalS: pgInteger('rebroadcast_interval_s'),
  /** Hop limit 0-7 the waypoint is sent with. NULL = the node's configured limit (#5482). */
  hopLimit: pgInteger('hop_limit'),
  /** `<automationId>:<waypointKey>` for waypoints owned by an automation step (#5482). */
  automationKey: pgText('automation_key'),
  /** Digest of the content an automation step last sent (#5482, onlyWhenChanged). */
  broadcastFingerprint: pgText('broadcast_fingerprint'),
  lastBroadcastAt: pgBigint('last_broadcast_at', { mode: 'number' }),
  firstSeenAt: pgBigint('first_seen_at', { mode: 'number' }).notNull(),
  lastUpdatedAt: pgBigint('last_updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: pgPrimaryKey({ columns: [table.sourceId, table.waypointId] }),
  expireIdx: pgIndex('idx_waypoints_source_expire').on(table.sourceId, table.expireAt),
  ownerIdx: pgIndex('idx_waypoints_source_owner').on(table.sourceId, table.ownerNodeNum),
}));

// ============ MySQL ============

export const waypointsMysql = mysqlTable('waypoints', {
  sourceId: myVarchar('source_id', { length: 36 }).notNull(),
  waypointId: myBigint('waypoint_id', { mode: 'number' }).notNull(),
  ownerNodeNum: myBigint('owner_node_num', { mode: 'number' }),
  latitude: myDouble('latitude').notNull(),
  longitude: myDouble('longitude').notNull(),
  expireAt: myBigint('expire_at', { mode: 'number' }),
  lockedTo: myBigint('locked_to', { mode: 'number' }),
  name: myVarchar('name', { length: 64 }).notNull().default(''),
  description: myText('description').notNull(),
  iconCodepoint: myInt('icon_codepoint'),
  iconEmoji: myVarchar('icon_emoji', { length: 16 }),
  isVirtual: myInt('is_virtual').notNull().default(0),
  /** Device channel slot the waypoint is broadcast on. NULL = slot 0 (#4341). */
  channel: myInt('channel'),
  rebroadcastIntervalS: myInt('rebroadcast_interval_s'),
  /** Hop limit 0-7 the waypoint is sent with. NULL = the node's configured limit (#5482). */
  hopLimit: myInt('hop_limit'),
  /** `<automationId>:<waypointKey>` for waypoints owned by an automation step (#5482). */
  automationKey: myVarchar('automation_key', { length: 255 }),
  /** Digest of the content an automation step last sent (#5482, onlyWhenChanged). */
  broadcastFingerprint: myVarchar('broadcast_fingerprint', { length: 64 }),
  lastBroadcastAt: myBigint('last_broadcast_at', { mode: 'number' }),
  firstSeenAt: myBigint('first_seen_at', { mode: 'number' }).notNull(),
  lastUpdatedAt: myBigint('last_updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: myPrimaryKey({ columns: [table.sourceId, table.waypointId] }),
  expireIdx: myIndex('idx_waypoints_source_expire').on(table.sourceId, table.expireAt),
  ownerIdx: myIndex('idx_waypoints_source_owner').on(table.sourceId, table.ownerNodeNum),
}));

// ============ Type inference ============

export type WaypointSqlite = typeof waypointsSqlite.$inferSelect;
export type NewWaypointSqlite = typeof waypointsSqlite.$inferInsert;
export type WaypointPostgres = typeof waypointsPostgres.$inferSelect;
export type NewWaypointPostgres = typeof waypointsPostgres.$inferInsert;
export type WaypointMysql = typeof waypointsMysql.$inferSelect;
export type NewWaypointMysql = typeof waypointsMysql.$inferInsert;
