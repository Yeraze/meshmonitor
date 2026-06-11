/**
 * Drizzle schema for Automated Remote Favorites Management (issue #2608).
 *
 * Two tables, both per-source and per-target:
 *
 *  - auto_favorite_targets: one config row per remote target node a user has
 *    asked MeshMonitor to keep favorites up to date on (via Remote Admin).
 *    Discovery can use the target's NeighborInfo, its passing traceroutes, or
 *    both. Each cycle favorites up to `maxNewPerCycle` newly discovered eligible
 *    neighbors and re-sends up to `maxRefavoritePerCycle` previously assigned
 *    favorites (favorite assignment is fire-and-forget over LoRa — there is no
 *    ACK — so re-sending guards against dropped commands).
 *
 *  - auto_favorite_assignments: tracking ledger of which neighbor nodeNums have
 *    been favorited on a given target, so "newly discovered" can be told apart
 *    from "already assigned" and the oldest assignments can be re-sent first.
 *
 * Supports SQLite, PostgreSQL, and MySQL.
 */
import { sqliteTable, text, integer, uniqueIndex as sqliteUniqueIndex } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial, uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, boolean as myBoolean, bigint as myBigint, serial as mySerial, uniqueIndex as myUniqueIndex } from 'drizzle-orm/mysql-core';

// Default eligible roles: Router (2), Router Late (11), Client Base (12).
// Matches the infrastructure roles called out in issue #2608.
export const DEFAULT_ELIGIBLE_ROLES_JSON = '[2,11,12]';

// ============================ auto_favorite_targets ============================

// SQLite
export const autoFavoriteTargetsSqlite = sqliteTable('auto_favorite_targets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  targetNodeNum: integer('targetNodeNum').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  useNeighborInfo: integer('useNeighborInfo', { mode: 'boolean' }).notNull().default(true),
  useTraceroutes: integer('useTraceroutes', { mode: 'boolean' }).notNull().default(true),
  intervalHours: integer('intervalHours').notNull().default(24),
  maxNewPerCycle: integer('maxNewPerCycle').notNull().default(1),
  maxRefavoritePerCycle: integer('maxRefavoritePerCycle').notNull().default(1),
  eligibleRoles: text('eligibleRoles').notNull().default(DEFAULT_ELIGIBLE_ROLES_JSON),
  lastRunAt: integer('lastRunAt'),
  lastNeighborRequestAt: integer('lastNeighborRequestAt'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
}, (table) => ({
  targetUniq: sqliteUniqueIndex('aft_source_target_uniq').on(table.sourceId, table.targetNodeNum),
}));

// PostgreSQL
export const autoFavoriteTargetsPostgres = pgTable('auto_favorite_targets', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  targetNodeNum: pgBigint('targetNodeNum', { mode: 'number' }).notNull(),
  enabled: pgBoolean('enabled').notNull().default(false),
  useNeighborInfo: pgBoolean('useNeighborInfo').notNull().default(true),
  useTraceroutes: pgBoolean('useTraceroutes').notNull().default(true),
  intervalHours: pgInteger('intervalHours').notNull().default(24),
  maxNewPerCycle: pgInteger('maxNewPerCycle').notNull().default(1),
  maxRefavoritePerCycle: pgInteger('maxRefavoritePerCycle').notNull().default(1),
  eligibleRoles: pgText('eligibleRoles').notNull().default(DEFAULT_ELIGIBLE_ROLES_JSON),
  lastRunAt: pgBigint('lastRunAt', { mode: 'number' }),
  lastNeighborRequestAt: pgBigint('lastNeighborRequestAt', { mode: 'number' }),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
}, (table) => ({
  targetUniq: pgUniqueIndex('aft_source_target_uniq').on(table.sourceId, table.targetNodeNum),
}));

// MySQL
export const autoFavoriteTargetsMysql = mysqlTable('auto_favorite_targets', {
  id: mySerial('id').primaryKey(),
  sourceId: myVarchar('sourceId', { length: 36 }).notNull(),
  targetNodeNum: myBigint('targetNodeNum', { mode: 'number' }).notNull(),
  enabled: myBoolean('enabled').notNull().default(false),
  useNeighborInfo: myBoolean('useNeighborInfo').notNull().default(true),
  useTraceroutes: myBoolean('useTraceroutes').notNull().default(true),
  intervalHours: myInt('intervalHours').notNull().default(24),
  maxNewPerCycle: myInt('maxNewPerCycle').notNull().default(1),
  maxRefavoritePerCycle: myInt('maxRefavoritePerCycle').notNull().default(1),
  eligibleRoles: myVarchar('eligibleRoles', { length: 255 }).notNull().default(DEFAULT_ELIGIBLE_ROLES_JSON),
  lastRunAt: myBigint('lastRunAt', { mode: 'number' }),
  lastNeighborRequestAt: myBigint('lastNeighborRequestAt', { mode: 'number' }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
}, (table) => ({
  targetUniq: myUniqueIndex('aft_source_target_uniq').on(table.sourceId, table.targetNodeNum),
}));

// ========================= auto_favorite_assignments =========================

// SQLite
export const autoFavoriteAssignmentsSqlite = sqliteTable('auto_favorite_assignments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  targetNodeNum: integer('targetNodeNum').notNull(),
  favoriteNodeNum: integer('favoriteNodeNum').notNull(),
  discoverySource: text('discoverySource'),
  firstAssignedAt: integer('firstAssignedAt').notNull(),
  lastAssignedAt: integer('lastAssignedAt').notNull(),
}, (table) => ({
  assignUniq: sqliteUniqueIndex('afa_source_target_fav_uniq').on(table.sourceId, table.targetNodeNum, table.favoriteNodeNum),
}));

// PostgreSQL
export const autoFavoriteAssignmentsPostgres = pgTable('auto_favorite_assignments', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  targetNodeNum: pgBigint('targetNodeNum', { mode: 'number' }).notNull(),
  favoriteNodeNum: pgBigint('favoriteNodeNum', { mode: 'number' }).notNull(),
  discoverySource: pgText('discoverySource'),
  firstAssignedAt: pgBigint('firstAssignedAt', { mode: 'number' }).notNull(),
  lastAssignedAt: pgBigint('lastAssignedAt', { mode: 'number' }).notNull(),
}, (table) => ({
  assignUniq: pgUniqueIndex('afa_source_target_fav_uniq').on(table.sourceId, table.targetNodeNum, table.favoriteNodeNum),
}));

// MySQL
export const autoFavoriteAssignmentsMysql = mysqlTable('auto_favorite_assignments', {
  id: mySerial('id').primaryKey(),
  sourceId: myVarchar('sourceId', { length: 36 }).notNull(),
  targetNodeNum: myBigint('targetNodeNum', { mode: 'number' }).notNull(),
  favoriteNodeNum: myBigint('favoriteNodeNum', { mode: 'number' }).notNull(),
  discoverySource: myVarchar('discoverySource', { length: 32 }),
  firstAssignedAt: myBigint('firstAssignedAt', { mode: 'number' }).notNull(),
  lastAssignedAt: myBigint('lastAssignedAt', { mode: 'number' }).notNull(),
}, (table) => ({
  assignUniq: myUniqueIndex('afa_source_target_fav_uniq').on(table.sourceId, table.targetNodeNum, table.favoriteNodeNum),
}));

// Type inference
export type AutoFavoriteTargetSqlite = typeof autoFavoriteTargetsSqlite.$inferSelect;
export type AutoFavoriteAssignmentSqlite = typeof autoFavoriteAssignmentsSqlite.$inferSelect;
