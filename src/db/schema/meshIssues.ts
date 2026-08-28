/**
 * Drizzle schema for the `mesh_issues` table (Mesh Issues Analysis epic
 * #4964, Phase 1 WP1).
 *
 * GLOBAL by design — there is intentionally NO `sourceId` column, mirroring
 * `estimated_positions` (see CLAUDE.md's global-by-design carve-out list). A
 * finding pools evidence from every Meshtastic-family source (TCP + MQTT)
 * into one row per physical subject; per-source scoping happens at the API
 * layer by intersecting a finding's `sourceIds` evidence with the caller's
 * permitted sources (issue #3745 leak class), not by a database column.
 *
 * **Identity model.** A finding's identity is `(issueType, subjectKey)`, not
 * `(issueType, nodeNum)`. `subjectKey` is a single non-null string so the
 * UNIQUE index behaves identically on SQLite, PostgreSQL and MySQL — a
 * nullable column inside a UNIQUE index treats NULLs as distinct on all three
 * backends, which would silently allow duplicate area findings (Tier A rule
 * A2b is attributed to a geographic area, not a node, so `nodeNum` alone
 * cannot be the key). Canonical forms:
 *   - node subject: `node:${nodeNum}`
 *   - area subject: `area:${latBin}:${lonBin}` (integer grid bin indices)
 * `nodeNum` is kept as a nullable denormalized column purely for
 * querying/joining (null for area findings); `subjectKey` is the real key.
 *
 * One row per `(issueType, subjectKey)`, upserted by the scheduled
 * `meshIssuesAnalysisService`. `cleanRuns` / `status` / `closedAt` implement
 * auto-close after N consecutive runs where the finding is not re-detected.
 * `dismissed` / `dismissedAt` / `dismissedBy` are Phase 3 UI fields, added now
 * so no follow-up migration is needed.
 *
 * Excluded from `BACKUP_TABLES` (systemBackupService.ts) — this is derived
 * data that regenerates on the next scheduled run, exactly like
 * `estimated_positions`, which is also absent from that list.
 *
 * Supports SQLite, PostgreSQL, and MySQL.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, integer as pgInteger, boolean as pgBoolean, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, bigint as myBigint, int as myInt, boolean as myBoolean } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshIssuesSqlite = sqliteTable('mesh_issues', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  issueType: text('issueType').notNull(),
  subjectKey: text('subjectKey').notNull(),
  // Denormalized for query/join convenience; null for area findings.
  nodeNum: integer('nodeNum'),
  severity: text('severity').notNull(),
  confidence: text('confidence').notNull(),
  // JSON object, including the `recommendation` string (see repository).
  evidence: text('evidence').notNull(),
  // JSON array of source ids that contributed evidence.
  sourceIds: text('sourceIds').notNull(),
  firstDetected: integer('firstDetected').notNull(),
  lastDetected: integer('lastDetected').notNull(),
  // Consecutive runs in which this finding was NOT re-detected.
  cleanRuns: integer('cleanRuns').notNull().default(0),
  status: text('status').notNull().default('open'),
  closedAt: integer('closedAt'),
  dismissed: integer('dismissed', { mode: 'boolean' }).notNull().default(false),
  dismissedAt: integer('dismissedAt'),
  // users.id; no FK — cross-table FKs are avoided elsewhere in this codebase.
  dismissedBy: integer('dismissedBy'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const meshIssuesPostgres = pgTable('mesh_issues', {
  id: pgSerial('id').primaryKey(),
  issueType: pgText('issueType').notNull(),
  subjectKey: pgText('subjectKey').notNull(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }),
  severity: pgText('severity').notNull(),
  confidence: pgText('confidence').notNull(),
  evidence: pgText('evidence').notNull(),
  sourceIds: pgText('sourceIds').notNull(),
  firstDetected: pgBigint('firstDetected', { mode: 'number' }).notNull(),
  lastDetected: pgBigint('lastDetected', { mode: 'number' }).notNull(),
  cleanRuns: pgInteger('cleanRuns').notNull().default(0),
  status: pgText('status').notNull().default('open'),
  closedAt: pgBigint('closedAt', { mode: 'number' }),
  dismissed: pgBoolean('dismissed').notNull().default(false),
  dismissedAt: pgBigint('dismissedAt', { mode: 'number' }),
  dismissedBy: pgInteger('dismissedBy'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const meshIssuesMysql = mysqlTable('mesh_issues', {
  id: myInt('id').autoincrement().primaryKey(),
  issueType: myVarchar('issueType', { length: 64 }).notNull(),
  subjectKey: myVarchar('subjectKey', { length: 128 }).notNull(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }),
  severity: myVarchar('severity', { length: 16 }).notNull(),
  confidence: myVarchar('confidence', { length: 16 }).notNull(),
  evidence: myText('evidence').notNull(),
  sourceIds: myText('sourceIds').notNull(),
  firstDetected: myBigint('firstDetected', { mode: 'number' }).notNull(),
  lastDetected: myBigint('lastDetected', { mode: 'number' }).notNull(),
  cleanRuns: myInt('cleanRuns').notNull().default(0),
  status: myVarchar('status', { length: 16 }).notNull().default('open'),
  closedAt: myBigint('closedAt', { mode: 'number' }),
  dismissed: myBoolean('dismissed').notNull().default(false),
  dismissedAt: myBigint('dismissedAt', { mode: 'number' }),
  dismissedBy: myInt('dismissedBy'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type MeshIssueSqlite = typeof meshIssuesSqlite.$inferSelect;
export type NewMeshIssueSqlite = typeof meshIssuesSqlite.$inferInsert;
export type MeshIssuePostgres = typeof meshIssuesPostgres.$inferSelect;
export type NewMeshIssuePostgres = typeof meshIssuesPostgres.$inferInsert;
export type MeshIssueMysql = typeof meshIssuesMysql.$inferSelect;
export type NewMeshIssueMysql = typeof meshIssuesMysql.$inferInsert;
