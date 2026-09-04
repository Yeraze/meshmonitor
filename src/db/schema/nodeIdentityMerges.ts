/**
 * Drizzle schema for the node identity-merge journal (issue #5032).
 *
 * One row per operator-initiated "these two rows are the same physical node"
 * merge. The row is both the audit record and the **undo tape**: `journal`
 * holds a serialized description of every re-key, delete and replace the merge
 * performed, in enough detail to run the whole thing backwards.
 *
 * Why the journal is stored rather than re-derived: after the merge there is
 * nothing left in the data to tell a re-keyed row from a row that always
 * belonged to the surviving node. `route_segments` row 91,203 now says
 * `fromNodeNum = <new>`; whether it said `<old>` five minutes ago is not
 * recoverable from the table. So the merge writes down what it touched, at the
 * moment it touches it, inside the same transaction.
 *
 * The journal captures whichever side of each re-key is SMALLER — the rows that
 * moved, or the rows that already belonged to the survivor — so a merge onto a
 * days-old 2.8 identity (the normal case) writes a journal of a few dozen ids
 * rather than one per row of a multi-year history. See
 * `src/db/repositories/nodeIdentityMerge.ts` for the format.
 *
 * NOT per-source-scoped away: `sourceId` is on the row and every merge is
 * confined to one source, but the table itself is global, like `audit_log`.
 *
 * Supports SQLite, PostgreSQL, and MySQL.
 */
import {
  sqliteTable,
  text,
  integer,
  index as sqliteIndex,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  bigint as pgBigint,
  integer as pgInteger,
  boolean as pgBoolean,
  index as pgIndex,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  longtext as myLongtext,
  bigint as myBigint,
  int as myInt,
  boolean as myBoolean,
  index as myIndex,
} from 'drizzle-orm/mysql-core';

// ============ SQLite ============

export const nodeIdentityMergesSqlite = sqliteTable('node_identity_merges', {
  /** Opaque merge id (uuid v4). Also the undo handle in the API. */
  id: text('id').primaryKey(),
  /** The source both nodes belong to. A merge NEVER crosses sources. */
  sourceId: text('sourceId').notNull(),
  /** The retired node number — its `nodes` row is deleted by the merge. */
  fromNodeNum: integer('fromNodeNum').notNull(),
  /** The surviving node number — everything is re-keyed onto it. */
  toNodeNum: integer('toNodeNum').notNull(),
  /** `!hex` ids at merge time, kept for display after the old row is gone. */
  fromNodeId: text('fromNodeId'),
  toNodeId: text('toNodeId'),
  /**
   * What justified the pairing: `derivedNodeNum` / `publicKey` when the merge
   * matched a live detection, `manual` when the operator supplied the pair
   * without one.
   */
  basis: text('basis').notNull(),
  /** ms epoch the merge committed. */
  mergedAt: integer('mergedAt').notNull(),
  /** Username of the admin who confirmed it; null for a system/test caller. */
  mergedBy: text('mergedBy'),
  /** Rows whose node reference was rewritten. */
  rowsRekeyed: integer('rowsRekeyed').notNull().default(0),
  /** Rows deleted because they collided with an existing row on the survivor. */
  rowsDropped: integer('rowsDropped').notNull().default(0),
  /**
   * False when the journal could not record enough to reverse the merge — see
   * `undoBlockedReason`. The API refuses an undo on a row with this false, and
   * the pre-merge preview says so before the operator confirms.
   */
  undoable: integer('undoable', { mode: 'boolean' }).notNull().default(true),
  /** Machine token explaining a false `undoable` (e.g. `JOURNAL_TOO_LARGE`). */
  undoBlockedReason: text('undoBlockedReason'),
  /** ms epoch the merge was reversed; null while it still stands. */
  undoneAt: integer('undoneAt'),
  undoneBy: text('undoneBy'),
  /** Format version of `journal`, so an old row can be refused rather than misread. */
  journalVersion: integer('journalVersion').notNull().default(1),
  /** JSON undo tape. See `MergeJournal` in the repository. */
  journal: text('journal').notNull(),
}, (table) => ({
  sourceIdx: sqliteIndex('idx_node_identity_merges_source').on(table.sourceId, table.mergedAt),
}));

// ============ PostgreSQL ============

export const nodeIdentityMergesPostgres = pgTable('node_identity_merges', {
  id: pgText('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  // nodeNum is unsigned 32-bit; PG INTEGER is signed 32-bit.
  fromNodeNum: pgBigint('fromNodeNum', { mode: 'number' }).notNull(),
  toNodeNum: pgBigint('toNodeNum', { mode: 'number' }).notNull(),
  fromNodeId: pgText('fromNodeId'),
  toNodeId: pgText('toNodeId'),
  basis: pgText('basis').notNull(),
  // ms-epoch timestamps overflow 32-bit INTEGER.
  mergedAt: pgBigint('mergedAt', { mode: 'number' }).notNull(),
  mergedBy: pgText('mergedBy'),
  rowsRekeyed: pgInteger('rowsRekeyed').notNull().default(0),
  rowsDropped: pgInteger('rowsDropped').notNull().default(0),
  undoable: pgBoolean('undoable').notNull().default(true),
  undoBlockedReason: pgText('undoBlockedReason'),
  undoneAt: pgBigint('undoneAt', { mode: 'number' }),
  undoneBy: pgText('undoneBy'),
  journalVersion: pgInteger('journalVersion').notNull().default(1),
  journal: pgText('journal').notNull(),
}, (table) => ({
  sourceIdx: pgIndex('idx_node_identity_merges_source').on(table.sourceId, table.mergedAt),
}));

// ============ MySQL ============

export const nodeIdentityMergesMysql = mysqlTable('node_identity_merges', {
  // MySQL PK columns must be bounded length, not TEXT.
  id: myVarchar('id', { length: 64 }).primaryKey(),
  sourceId: myVarchar('sourceId', { length: 191 }).notNull(),
  fromNodeNum: myBigint('fromNodeNum', { mode: 'number' }).notNull(),
  toNodeNum: myBigint('toNodeNum', { mode: 'number' }).notNull(),
  fromNodeId: myVarchar('fromNodeId', { length: 32 }),
  toNodeId: myVarchar('toNodeId', { length: 32 }),
  basis: myVarchar('basis', { length: 32 }).notNull(),
  mergedAt: myBigint('mergedAt', { mode: 'number' }).notNull(),
  mergedBy: myVarchar('mergedBy', { length: 191 }),
  rowsRekeyed: myInt('rowsRekeyed').notNull().default(0),
  rowsDropped: myInt('rowsDropped').notNull().default(0),
  undoable: myBoolean('undoable').notNull().default(true),
  undoBlockedReason: myVarchar('undoBlockedReason', { length: 64 }),
  undoneAt: myBigint('undoneAt', { mode: 'number' }),
  undoneBy: myVarchar('undoneBy', { length: 191 }),
  journalVersion: myInt('journalVersion').notNull().default(1),
  /**
   * LONGTEXT, not TEXT. MySQL's TEXT caps at 64 KiB, which a merge of a
   * long-lived node blows straight through — and the failure mode would be a
   * silently truncated undo tape, i.e. an undo that corrupts rather than
   * refuses. SQLite and PostgreSQL TEXT are unbounded.
   */
  journal: myLongtext('journal').notNull(),
}, (table) => ({
  sourceIdx: myIndex('idx_node_identity_merges_source').on(table.sourceId, table.mergedAt),
}));

// ============ Type inference ============

export type NodeIdentityMergeSqlite = typeof nodeIdentityMergesSqlite.$inferSelect;
export type NodeIdentityMergePostgres = typeof nodeIdentityMergesPostgres.$inferSelect;
export type NodeIdentityMergeMysql = typeof nodeIdentityMergesMysql.$inferSelect;
