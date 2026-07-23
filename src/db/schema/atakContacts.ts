import { sqliteTable, text, integer, real, primaryKey as sqlitePrimaryKey } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  real as pgReal,
  bigint as pgBigint,
  primaryKey as pgPrimaryKey,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  int as myInt,
  double as myDouble,
  bigint as myBigint,
  primaryKey as myPrimaryKey,
} from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============
//
// One row per distinct ATAK EUD (End User Device) seen on a source, built
// from the PLI (Position Location Information) variant of a decoded
// TAKPacket (ATAK/CoT Phase 2, issue #3691). Unlike the reception-log tables
// (mqtt_packet_log, packet_log), this is a one-row-per-device state table —
// each new PLI beacon upserts the existing row in place rather than
// appending. Meshtastic-only: MeshCore has no ATAK format.
//
// Identity / PK: composite (uid, sourceId). `uid` is `deviceCallsign` when
// present (the stable ATAK EUD identifier), else `callsign`, else the
// carrying node fallback `!<nodeNum hex>` — see atakContactService.

export const atakContactsSqlite = sqliteTable('atak_contacts', {
  uid: text('uid').notNull(),
  sourceId: text('sourceId').notNull(),
  /** Carrying Meshtastic node number (unsigned 32-bit). */
  nodeNum: integer('nodeNum'),
  /** User-facing display callsign (mutable). */
  callsign: text('callsign'),
  /** Stable ATAK EUD device UID (may equal `uid`). */
  deviceCallsign: text('deviceCallsign'),
  /** Team enum int (0-14); null if no Group. */
  team: integer('team'),
  /** MemberRole enum int (0-8); null if no Group. */
  role: integer('role'),
  /** Status.battery percentage; null if no Status. */
  battery: integer('battery'),
  /** Decimal degrees; null when bogus (e.g. Null Island, out-of-range). */
  latitude: real('latitude'),
  longitude: real('longitude'),
  /** HAE meters; null if absent. */
  altitude: integer('altitude'),
  /** m/s. */
  speed: integer('speed'),
  /** Degrees. */
  course: integer('course'),
  /** ms epoch of latest PLI. */
  lastSeen: integer('lastSeen').notNull(),
  /** ms epoch first seen; preserved across upserts. */
  createdAt: integer('createdAt').notNull(),
}, (table) => ({
  pk: sqlitePrimaryKey({ columns: [table.uid, table.sourceId] }),
}));

// ============ PostgreSQL Schema ============

export const atakContactsPostgres = pgTable('atak_contacts', {
  uid: pgText('uid').notNull(),
  sourceId: pgText('sourceId').notNull(),
  // nodeNum is unsigned 32-bit; PG INTEGER is signed 32-bit.
  nodeNum: pgBigint('nodeNum', { mode: 'number' }),
  callsign: pgText('callsign'),
  deviceCallsign: pgText('deviceCallsign'),
  team: pgInteger('team'),
  role: pgInteger('role'),
  battery: pgInteger('battery'),
  latitude: pgReal('latitude'),
  longitude: pgReal('longitude'),
  altitude: pgInteger('altitude'),
  speed: pgInteger('speed'),
  course: pgInteger('course'),
  // ms-epoch timestamps overflow 32-bit INTEGER; JS Date.now() is ~1.8e12.
  lastSeen: pgBigint('lastSeen', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: pgPrimaryKey({ columns: [table.uid, table.sourceId] }),
}));

// ============ MySQL Schema ============

export const atakContactsMysql = mysqlTable('atak_contacts', {
  // MySQL PK columns must be bounded length, not TEXT.
  uid: myVarchar('uid', { length: 191 }).notNull(),
  sourceId: myVarchar('sourceId', { length: 191 }).notNull(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }),
  callsign: myVarchar('callsign', { length: 255 }),
  deviceCallsign: myVarchar('deviceCallsign', { length: 255 }),
  team: myInt('team'),
  role: myInt('role'),
  battery: myInt('battery'),
  latitude: myDouble('latitude'),
  longitude: myDouble('longitude'),
  altitude: myInt('altitude'),
  speed: myInt('speed'),
  course: myInt('course'),
  lastSeen: myBigint('lastSeen', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: myPrimaryKey({ columns: [table.uid, table.sourceId] }),
}));

// ============ TYPE INFERENCE ============

export type AtakContactSqlite = typeof atakContactsSqlite.$inferSelect;
export type NewAtakContactSqlite = typeof atakContactsSqlite.$inferInsert;
export type AtakContactPostgres = typeof atakContactsPostgres.$inferSelect;
export type NewAtakContactPostgres = typeof atakContactsPostgres.$inferInsert;
export type AtakContactMysql = typeof atakContactsMysql.$inferSelect;
export type NewAtakContactMysql = typeof atakContactsMysql.$inferInsert;
