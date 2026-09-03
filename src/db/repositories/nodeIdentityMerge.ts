/**
 * Node identity merge — re-key one node's history onto another node's number.
 *
 * Meshtastic 2.8 derives `my_node_num` from the node's public key instead of
 * its MAC, so an upgrading node reappears as a brand-new row and every packet,
 * telemetry sample, traceroute and message it ever sent stays orphaned under
 * the old number (issue #5032). This repository is the operator-initiated fix:
 * "these two rows are the same physical node — move the history".
 *
 * It is the most destructive write path in the application, so it is built
 * around five properties, none of which is optional:
 *
 * 1. **One code path for preview and execution.** {@link buildMergePlan} does
 *    all the counting; the dry-run endpoint calls it and stops, the execute
 *    endpoint calls it again *inside the transaction* and then applies exactly
 *    what it described. A preview cannot drift from reality because there is no
 *    second implementation to drift from.
 * 2. **Undo.** Every change is written to a journal in the same transaction —
 *    see {@link MergeJournal}. Re-keys record which rows moved (or, when
 *    cheaper, which rows already belonged to the survivor), deletions record
 *    the whole row, and the single-row edits on `nodes` record the previous
 *    values. {@link undoMerge} replays the inverse in reverse order.
 * 3. **Atomic on all three backends.** Everything runs in one transaction —
 *    see {@link NodeIdentityMergeRepository.inTransaction} for why SQLite and
 *    PostgreSQL/MySQL need different mechanics to get there.
 * 4. **Per-source.** Every statement is scoped by `sourceId` and both nodes must
 *    live on the same source. There is no cross-source merge, not even for an
 *    admin.
 * 5. **Never automatic.** Nothing here is reachable from detection. The service
 *    layer takes an explicit node pair from an authenticated admin.
 *
 * ## The journal, and why it stores what it stores
 *
 * After a merge, nothing in the data distinguishes a re-keyed row from one that
 * always belonged to the survivor: `route_segments` row 91,203 says
 * `fromNodeNum = <new>`, and whether it said `<old>` a minute ago is simply
 * gone. So the merge writes down what it touched as it touches it.
 *
 * Recording every moved row id would be expensive in exactly the case that
 * matters — the predecessor is the one with years of history. So each re-key
 * entry captures **whichever side is smaller**:
 *
 * - `capture: 'moved'` — the primary keys of the rows that were re-keyed. Undo
 *   walks that list and puts them back.
 * - `capture: 'survivor'` — the primary keys of the rows that *already* pointed
 *   at the surviving node. Undo reverts everything now pointing at the survivor
 *   *except* those, and except anything whose auto-increment key is above the
 *   merge-time high-water mark, which is how a row that arrived AFTER the merge
 *   is kept out of the reversal. Only tables with such a key qualify.
 *
 * For a merge onto a days-old 2.8 identity — the normal case — the survivor
 * side is a handful of rows, so the journal stays tiny however long the
 * predecessor's history is.
 *
 * ## `messages` is special: its primary key encodes the sender
 *
 * `messages.id` is `${sourceId}_${fromNodeNum}_${packetId}` (packet id LAST;
 * the format is load-bearing across the app). Re-keying the sender therefore
 * changes the PRIMARY KEY, so those rows cannot simply be UPDATEd on one
 * column — the id has to be rewritten alongside, and two rows can collide when
 * both nodes happen to hold the same packet id. Collisions are resolved before
 * the re-key, by dropping the predecessor's row and snapshotting it whole (see
 * `MERGE_COLLISION_POLICY` below), so the UPDATE can never throw half-way.
 */
import { sql, and, eq, inArray, notInArray, isNull, gt, lte, desc, SQL } from 'drizzle-orm';
import { BaseRepository } from './base.js';
import { logger } from '../../utils/logger.js';

/** Journal format version. Bumped if the shape below ever changes incompatibly. */
export const MERGE_JOURNAL_VERSION = 1;

/**
 * Cap on how many primary keys the whole journal may hold. Past it the merge is
 * still allowed — refusing to fix a huge node's history would be worse — but it
 * is recorded as NOT undoable, the preview says so, and the caller has to pass
 * `acknowledgeNoUndo` to go ahead.
 *
 * 200k keys is roughly 1.5 MB of JSON, which SQLite/PostgreSQL TEXT and MySQL
 * LONGTEXT all hold comfortably.
 */
export const MAX_JOURNAL_PKS = 200_000;

/**
 * Largest survivor-side capture we will use.
 *
 * `capture: 'survivor'` reverts with a single `... NOT IN (<keys>)`, and every
 * key is a bound parameter — SQLite caps those at 32,766 and PostgreSQL at
 * 65,535, so a large survivor list would fail at undo time, i.e. exactly when
 * it matters. `capture: 'moved'` has no such limit because its undo is chunked
 * `IN (...)` statements, so past this size we take the larger-but-chunkable
 * side instead.
 */
export const MAX_SURVIVOR_CAPTURE_PKS = 5_000;

/**
 * Which side of a re-key the journal records. Shared by the plan (so the
 * preview's journal-size estimate is the real one) and the merge.
 *
 * `survivor` is only available on tables with an auto-increment integer key.
 * That key is what lets undo separate "re-keyed by this merge" from "arrived
 * after it" — a row with a key above the merge-time high-water mark is new and
 * must keep the surviving number. Without a monotonic key there is no honest
 * way to draw that line, so those tables always record the moved side.
 */
export function chooseCapture(
  movedCount: number,
  survivorCount: number,
  autoIncrementPk: boolean,
): 'moved' | 'survivor' {
  if (!autoIncrementPk) return 'moved';
  if (survivorCount < movedCount && survivorCount <= MAX_SURVIVOR_CAPTURE_PKS) return 'survivor';
  return 'moved';
}

/** Why a merge could not be journalled well enough to reverse. */
export type UndoBlockedReason = 'JOURNAL_TOO_LARGE';

/**
 * One table+column the merge re-keys.
 *
 * `numColumn` is the node-number column that drives the match. `idColumns` are
 * the `!hex` text mirrors of it that must move in lockstep — leaving a stale
 * `fromNodeId` behind is a silent inconsistency the UI reads from.
 */
interface RekeyTarget {
  /** Key into the active-schema table map. */
  table: string;
  /** Physical table name, for the preview and the journal. */
  label: string;
  numColumn: string;
  /** `!hex` columns rewritten alongside `numColumn`. */
  idColumns: string[];
  /** Primary-key column, used to journal which rows moved. */
  pkColumn: string;
  /**
   * True when `pkColumn` is an auto-increment integer, so a key above the
   * merge-time maximum is provably a row that arrived afterwards. Only these
   * tables can use the cheap survivor-side journal capture; see
   * {@link chooseCapture}. `messages` (string key), `waypoints` (the id comes
   * off the wire) and `atak_contacts` (TAK uid) are not.
   */
  autoIncrementPk?: boolean;
  /**
   * True when re-keying `numColumn` also changes the primary key, because the
   * key encodes the node number. Only `messages.fromNodeNum`.
   */
  rewritesPk?: boolean;
}

/**
 * Every per-source Meshtastic table a merge re-keys, and the column that
 * carries the node reference.
 *
 * Deliberately a declarative list rather than hand-written statements: the
 * preview, the execution and the undo all walk this same array, so a table
 * cannot be counted in the preview and then missed by the merge.
 *
 * None of these tables carries a unique constraint that involves its node
 * column, so a plain re-key can never collide — the one exception is
 * `messages.fromNodeNum`, whose primary key encodes the sender, and that is
 * handled by the collision pass before any UPDATE runs.
 */
export const REKEY_TARGETS: readonly RekeyTarget[] = [
  // --- messages -----------------------------------------------------------
  {
    table: 'messages', label: 'messages', numColumn: 'fromNodeNum',
    idColumns: ['fromNodeId'], pkColumn: 'id', rewritesPk: true,
  },
  { table: 'messages', label: 'messages', numColumn: 'toNodeNum', idColumns: ['toNodeId'], pkColumn: 'id' },
  { table: 'messages', label: 'messages', numColumn: 'relayNode', idColumns: [], pkColumn: 'id' },
  { table: 'messages', label: 'messages', numColumn: 'ackFromNode', idColumns: [], pkColumn: 'id' },

  // --- telemetry / positions ----------------------------------------------
  { table: 'telemetry', label: 'telemetry', numColumn: 'nodeNum', idColumns: ['nodeId'], pkColumn: 'id', autoIncrementPk: true },

  // --- traceroutes --------------------------------------------------------
  { table: 'traceroutes', label: 'traceroutes', numColumn: 'fromNodeNum', idColumns: ['fromNodeId'], pkColumn: 'id', autoIncrementPk: true },
  { table: 'traceroutes', label: 'traceroutes', numColumn: 'toNodeNum', idColumns: ['toNodeId'], pkColumn: 'id', autoIncrementPk: true },
  { table: 'routeSegments', label: 'route_segments', numColumn: 'fromNodeNum', idColumns: ['fromNodeId'], pkColumn: 'id', autoIncrementPk: true },
  { table: 'routeSegments', label: 'route_segments', numColumn: 'toNodeNum', idColumns: ['toNodeId'], pkColumn: 'id', autoIncrementPk: true },

  // --- neighbours ---------------------------------------------------------
  { table: 'neighborInfo', label: 'neighbor_info', numColumn: 'nodeNum', idColumns: [], pkColumn: 'id', autoIncrementPk: true },
  { table: 'neighborInfo', label: 'neighbor_info', numColumn: 'neighborNodeNum', idColumns: [], pkColumn: 'id', autoIncrementPk: true },

  // --- packet monitors ----------------------------------------------------
  { table: 'packetLog', label: 'packet_log', numColumn: 'from_node', idColumns: ['from_node_id'], pkColumn: 'id', autoIncrementPk: true },
  { table: 'packetLog', label: 'packet_log', numColumn: 'to_node', idColumns: ['to_node_id'], pkColumn: 'id', autoIncrementPk: true },
  { table: 'packetLog', label: 'packet_log', numColumn: 'relay_node', idColumns: [], pkColumn: 'id', autoIncrementPk: true },
  { table: 'mqttPacketLog', label: 'mqtt_packet_log', numColumn: 'fromNode', idColumns: ['fromNodeId'], pkColumn: 'id', autoIncrementPk: true },
  { table: 'mqttPacketLog', label: 'mqtt_packet_log', numColumn: 'toNode', idColumns: ['toNodeId'], pkColumn: 'id', autoIncrementPk: true },
  { table: 'mqttPacketLog', label: 'mqtt_packet_log', numColumn: 'gatewayNodeNum', idColumns: ['gatewayId'], pkColumn: 'id', autoIncrementPk: true },
  {
    table: 'mqttOkToMqttViolations', label: 'mqtt_ok_to_mqtt_violations',
    numColumn: 'fromNode', idColumns: ['fromNodeId'], pkColumn: 'id', autoIncrementPk: true,
  },
  {
    table: 'mqttOkToMqttViolations', label: 'mqtt_ok_to_mqtt_violations',
    numColumn: 'gatewayNodeNum', idColumns: ['gatewayId'], pkColumn: 'id', autoIncrementPk: true,
  },

  // --- other per-source history ------------------------------------------
  // waypoints.waypointId comes off the wire and atak_contacts.uid is a TAK
  // string: neither is monotonic, so both always journal the moved side.
  { table: 'waypoints', label: 'waypoints', numColumn: 'ownerNodeNum', idColumns: [], pkColumn: 'waypointId' },
  { table: 'atakContacts', label: 'atak_contacts', numColumn: 'nodeNum', idColumns: [], pkColumn: 'uid' },
  { table: 'deadDropMessages', label: 'dead_drop_messages', numColumn: 'senderNodeNum', idColumns: [], pkColumn: 'id', autoIncrementPk: true },
  { table: 'autoTracerouteLog', label: 'auto_traceroute_log', numColumn: 'toNodeNum', idColumns: [], pkColumn: 'id', autoIncrementPk: true },
  { table: 'autoKeyRepairLog', label: 'auto_key_repair_log', numColumn: 'nodeNum', idColumns: [], pkColumn: 'id', autoIncrementPk: true },
];

/**
 * Per-source tables holding at most ONE row per node, whose primary key is the
 * node number itself. A re-key would collide when the survivor already has a
 * row, so these get delete-or-move semantics with a whole-row snapshot.
 */
interface SingletonTarget {
  table: string;
  label: string;
  numColumn: string;
  /** Columns forming the primary key, so undo can address the row again. */
  pkColumns: string[];
}

export const SINGLETON_TARGETS: readonly SingletonTarget[] = [
  { table: 'ignoredNodes', label: 'ignored_nodes', numColumn: 'nodeNum', pkColumns: ['nodeNum', 'sourceId'] },
  { table: 'meshBeaconOffers', label: 'mesh_beacon_offers', numColumn: 'nodeNum', pkColumns: ['sourceId', 'nodeNum'] },
];

/**
 * Tables that carry a node number but are deliberately left alone, with the
 * reason. Surfaced in the preview so the operator is told what will *not*
 * move rather than discovering it later.
 */
export const NOT_REKEYED: readonly { table: string; reason: string }[] = [
  {
    table: 'estimated_positions',
    reason:
      'Global by design — one row per physical node number pooled across every source (#3271). ' +
      'A per-source merge must not rewrite a row another source shares. The position ' +
      'estimator regenerates it on its next scheduled run.',
  },
  {
    table: 'estimated_position_anchors',
    reason: 'Global by design, and regenerated with estimated_positions.',
  },
  {
    table: 'auto_key_repair_state',
    reason: 'Global (no sourceId) and keyed on the node number. Self-heals on the next key-repair pass.',
  },
  {
    table: 'geofence_cooldowns',
    reason: 'Global (no sourceId). A stale cooldown expires on its own.',
  },
  {
    table: 'mesh_issues',
    reason: 'Global (no sourceId). Issues are re-derived from live data.',
  },
  {
    table: 'automation_home_anchors',
    reason:
      'Automations are global by design (#3653) and an anchor is unique per (automation, node). ' +
      'Re-point the anchor in the automation editor if you used one.',
  },
  {
    table: 'auto_traceroute_nodes / auto_time_sync_nodes / auto_favorite_targets',
    reason:
      'Forward-looking operator preference lists, not history. Re-add the node to them after the merge — ' +
      're-keying them risks colliding with an entry the surviving node already has.',
  },
  {
    table: 'user_notification_preferences.monitored_nodes',
    reason: 'A per-user JSON list of node numbers. Re-select the node in your notification settings.',
  },
  {
    table: 'source_pki_keys',
    reason: "The local node's own key material, not another node's history.",
  },
  {
    table: 'backup_history',
    reason: 'An immutable record of what a past backup contained.',
  },
];

/** Collision policy, documented here because the preview and the docs both cite it. */
export const MERGE_COLLISION_POLICY = {
  messages:
    'messages.id is `${sourceId}_${fromNodeNum}_${packetId}`, so re-keying the sender changes the ' +
    'primary key. When both nodes hold the same packet id the resulting ids collide: the SURVIVING ' +
    "node's row is kept and the predecessor's copy is dropped, whole-row snapshotted into the undo " +
    'journal first. Keeping the survivor is the deterministic choice — the two rows are the same ' +
    'packet observed twice, so neither is more correct, and "keep the row already under the id" ' +
    'needs no tie-break rule that could differ between the preview and the merge.',
  neighborInfo:
    'Re-keying both nodeNum and neighborNodeNum can turn a row recording "old heard new" into a ' +
    'self-loop (node is its own neighbour). Those rows are dropped, snapshotted first.',
  singletons:
    'ignored_nodes and mesh_beacon_offers hold at most one row per node. If the survivor already ' +
    "has one, the predecessor's row is dropped (snapshotted); otherwise it is moved across.",
  nodes:
    "The predecessor's `nodes` row is deleted and snapshotted whole. The survivor keeps all its own " +
    'fields except `createdAt`, which takes the earlier of the two so the node\'s first-seen date ' +
    'survives, and except `notes` / `isFavorite` / `favoriteLocked`, which are carried over only ' +
    'when the survivor has none — operator-entered data must not vanish silently.',
} as const;

// ---------------------------------------------------------------------------
// Plan (shared by preview and execution)
// ---------------------------------------------------------------------------

export interface MergePlanEntry {
  /** Physical table name. */
  table: string;
  /** The node-number column being re-keyed, or a pseudo-column for row ops. */
  column: string;
  action: 'rekey' | 'dropCollision' | 'dropSelfLoop' | 'moveRow' | 'dropRow' | 'deleteNodeRow' | 'patchNodeRow';
  /** How many rows this entry affects. */
  rows: number;
  note?: string;
}

export interface MergePlan {
  sourceId: string;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string | null;
  toNodeId: string | null;
  entries: MergePlanEntry[];
  /** Rows whose node reference will be rewritten. */
  totalRowsRekeyed: number;
  /** Rows that will be deleted (collisions, self-loops, the old `nodes` row). */
  totalRowsDropped: number;
  /** Primary keys the undo journal will need to hold. */
  journalPkCount: number;
  undoable: boolean;
  undoBlockedReason: UndoBlockedReason | null;
  notRekeyed: readonly { table: string; reason: string }[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

type PkValue = number | string;

interface RekeyJournalEntry {
  kind: 'rekey';
  table: string;
  label: string;
  numColumn: string;
  idColumns: string[];
  rewritesPk: boolean;
  pkColumn: string;
  capture: 'moved' | 'survivor';
  pks: PkValue[];
  movedCount: number;
  /**
   * Only for `capture: 'survivor'`. Rows created after the merge must not be
   * reverted; for auto-increment tables anything above this key is newer.
   * Null for `messages`, which uses `mergedAt` against `createdAt` instead.
   */
  pkHighWater: number | null;
}

interface DeleteJournalEntry {
  kind: 'delete';
  table: string;
  label: string;
  /** Whole rows, exactly as they were. Undo re-inserts them verbatim. */
  rows: Record<string, unknown>[];
}

interface PatchJournalEntry {
  kind: 'patch';
  table: string;
  label: string;
  /** Column → value pairs identifying the row. */
  where: Record<string, PkValue>;
  /** The values these columns held before the merge. */
  before: Record<string, unknown>;
}

export type MergeJournalEntry = RekeyJournalEntry | DeleteJournalEntry | PatchJournalEntry;

export interface MergeJournal {
  version: number;
  sourceId: string;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string | null;
  toNodeId: string | null;
  mergedAt: number;
  /** Applied in order by the merge; undone in reverse. */
  entries: MergeJournalEntry[];
}

export interface MergeRecord {
  id: string;
  sourceId: string;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string | null;
  toNodeId: string | null;
  basis: string;
  mergedAt: number;
  mergedBy: string | null;
  rowsRekeyed: number;
  rowsDropped: number;
  undoable: boolean;
  undoBlockedReason: string | null;
  undoneAt: number | null;
  undoneBy: string | null;
}

export interface ExecuteMergeOptions {
  sourceId: string;
  /** The node being retired. Its `nodes` row is deleted. */
  fromNodeNum: number;
  /** The node that survives. Everything is re-keyed onto it. */
  toNodeNum: number;
  /** What justified the pairing, for the audit row. */
  basis: string;
  /** Username of the confirming admin. */
  mergedBy: string | null;
  /** Required when the plan reports `undoable: false`. */
  acknowledgeNoUndo?: boolean;
}

export interface ExecuteMergeResult {
  mergeId: string;
  plan: MergePlan;
}

/** Thrown for every refusal, with a machine code the route maps to an HTTP status. */
export class NodeIdentityMergeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NodeIdentityMergeError';
  }
}

/** `!hex` form of a node number, matching the rest of the app. */
export function nodeNumToNodeId(nodeNum: number): string {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * `nodes.createdAt` is milliseconds while `nodes.lastHeard` is unix seconds, and
 * legacy rows exist in both units. Normalising before comparing is the
 * difference between "which row is older" and a ~56,000-year answer.
 */
function toSeconds(value: number): number {
  return value > 1e11 ? Math.floor(value / 1000) : value;
}

export class NodeIdentityMergeRepository extends BaseRepository {
  // -------------------------------------------------------------------------
  // Small dialect helpers
  // -------------------------------------------------------------------------

  /**
   * `messages.id` rewrite expression: keep the packet-id suffix, swap the
   * node-number segment. `substr` exists on all three dialects; string
   * concatenation does not, so MySQL takes `CONCAT` and the others `||`.
   */
  private messageIdRewrite(sourceId: string, toNodeNum: number, prefixLength: number): SQL {
    const idCol = sql`id`;
    const newPrefix = `${sourceId}_${toNodeNum}_`;
    if (this.isMySQL()) {
      return sql`CONCAT(${newPrefix}, SUBSTR(${idCol}, ${prefixLength + 1}))`;
    }
    return sql`${newPrefix} || SUBSTR(${idCol}, ${prefixLength + 1})`;
  }

  private table(name: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any -- ActiveSchema entries are dialect-specific Drizzle tables
    const t = (this.tables as Record<string, unknown>)[name];
    if (!t) throw new Error(`nodeIdentityMerge: unknown table '${name}'`);
    return t;
  }

  /** Count rows on one source where `column` equals `value`. */
  private async countWhere(
    db: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- may be the db or a transaction handle
    tableName: string,
    column: string,
    value: number,
    sourceId: string,
  ): Promise<number> {
    const t = this.table(tableName);
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .where(and(eq(t[column], value), eq(t.sourceId, sourceId)));
    return Number(rows[0]?.n ?? 0);
  }

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------

  /**
   * Count everything the merge would do, without writing anything.
   *
   * The dry-run endpoint calls this and stops. {@link executeMerge} calls it
   * again inside its transaction and then applies exactly these entries, so the
   * preview and the merge can never describe different work.
   */
  async buildMergePlan(
    sourceId: string,
    fromNodeNum: number,
    toNodeNum: number,
    db?: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction handle when called from executeMerge
  ): Promise<MergePlan> {
    const conn = db ?? this.db;
    const from = Number(fromNodeNum);
    const to = Number(toNodeNum);

    const nodesTable = this.table('nodes');
    const [fromRow] = await conn
      .select()
      .from(nodesTable)
      .where(and(eq(nodesTable.nodeNum, from), eq(nodesTable.sourceId, sourceId)))
      .limit(1);
    const [toRow] = await conn
      .select()
      .from(nodesTable)
      .where(and(eq(nodesTable.nodeNum, to), eq(nodesTable.sourceId, sourceId)))
      .limit(1);

    if (!fromRow) {
      throw new NodeIdentityMergeError(
        'NODE_NOT_FOUND',
        `Node ${nodeNumToNodeId(from)} does not exist on this source.`,
      );
    }
    if (!toRow) {
      throw new NodeIdentityMergeError(
        'NODE_NOT_FOUND',
        `Node ${nodeNumToNodeId(to)} does not exist on this source.`,
      );
    }

    const entries: MergePlanEntry[] = [];
    const warnings: string[] = [];
    let totalRowsRekeyed = 0;
    let totalRowsDropped = 0;
    let journalPkCount = 0;

    // --- messages: id collisions come first, they change the re-key count ---
    const collidingMessageIds = await this.findCollidingMessageIds(conn, sourceId, from, to);
    if (collidingMessageIds.length > 0) {
      entries.push({
        table: 'messages',
        column: 'id',
        action: 'dropCollision',
        rows: collidingMessageIds.length,
        note: 'Same packet id held by both nodes; the surviving node\'s row is kept.',
      });
      totalRowsDropped += collidingMessageIds.length;
      journalPkCount += collidingMessageIds.length;
      warnings.push(
        `${collidingMessageIds.length} message(s) exist under both node numbers with the same packet id. ` +
          'The duplicate copy from the retired node will be dropped (recoverable by undo).',
      );
    }

    // --- neighbour self-loops ---
    const selfLoopCount = await this.countNeighborSelfLoops(conn, sourceId, from, to);
    if (selfLoopCount > 0) {
      entries.push({
        table: 'neighbor_info',
        column: 'nodeNum/neighborNodeNum',
        action: 'dropSelfLoop',
        rows: selfLoopCount,
        note: 'Would become "node is its own neighbour" after the re-key.',
      });
      totalRowsDropped += selfLoopCount;
      journalPkCount += selfLoopCount;
    }

    // --- re-key targets ---
    for (const target of REKEY_TARGETS) {
      const movedCount = await this.countWhere(conn, target.table, target.numColumn, from, sourceId);
      if (movedCount === 0) continue;
      const survivorCount = await this.countWhere(conn, target.table, target.numColumn, to, sourceId);
      entries.push({
        table: target.label,
        column: target.numColumn,
        action: 'rekey',
        rows: movedCount,
      });
      totalRowsRekeyed += movedCount;
      journalPkCount +=
        chooseCapture(movedCount, survivorCount, Boolean(target.autoIncrementPk)) === 'survivor'
          ? survivorCount
          : movedCount;
    }

    // --- singletons ---
    for (const target of SINGLETON_TARGETS) {
      const fromCount = await this.countWhere(conn, target.table, target.numColumn, from, sourceId);
      if (fromCount === 0) continue;
      const toCount = await this.countWhere(conn, target.table, target.numColumn, to, sourceId);
      if (toCount > 0) {
        entries.push({
          table: target.label,
          column: target.numColumn,
          action: 'dropRow',
          rows: fromCount,
          note: 'The surviving node already has a row here; the retired node\'s is dropped.',
        });
        totalRowsDropped += fromCount;
      } else {
        entries.push({ table: target.label, column: target.numColumn, action: 'moveRow', rows: fromCount });
        totalRowsRekeyed += fromCount;
      }
      journalPkCount += fromCount;
    }

    // --- the nodes rows themselves ---
    const patch = this.buildNodePatch(fromRow, toRow);
    if (Object.keys(patch).length > 0) {
      entries.push({
        table: 'nodes',
        column: Object.keys(patch).join(', '),
        action: 'patchNodeRow',
        rows: 1,
        note: 'Carried over from the retired node so operator-entered data is not lost.',
      });
    }
    entries.push({
      table: 'nodes',
      column: 'nodeNum',
      action: 'deleteNodeRow',
      rows: 1,
      note: `The ${nodeNumToNodeId(from)} row is removed; a whole-row snapshot goes into the undo journal.`,
    });
    totalRowsDropped += 1;
    journalPkCount += 1;

    const undoable = journalPkCount <= MAX_JOURNAL_PKS;
    if (!undoable) {
      warnings.push(
        `This merge touches too many rows to record a complete undo (${journalPkCount.toLocaleString()} ` +
          `keys, limit ${MAX_JOURNAL_PKS.toLocaleString()}). It can still be performed, but it CANNOT be reversed.`,
      );
    }

    return {
      sourceId,
      fromNodeNum: from,
      toNodeNum: to,
      fromNodeId: (fromRow.nodeId as string) ?? null,
      toNodeId: (toRow.nodeId as string) ?? null,
      entries,
      totalRowsRekeyed,
      totalRowsDropped,
      journalPkCount,
      undoable,
      undoBlockedReason: undoable ? null : 'JOURNAL_TOO_LARGE',
      notRekeyed: NOT_REKEYED,
      warnings,
    };
  }

  /**
   * Message rows whose re-keyed id would land on an id the surviving node
   * already holds.
   *
   * Driven from the SURVIVOR's ids, not the predecessor's: an id is
   * `${sourceId}_${fromNodeNum}_${packetId}`, so a collision is simply the same
   * packet id present under both numbers. Reading the survivor's ids and
   * probing for the predecessor's counterparts keeps this bounded by the new
   * node's short history rather than the old node's long one — and it runs in
   * the dry-run preview, where a full scan of years of messages would be felt.
   *
   * No correlated subquery, so no dialect-specific identifier quoting and no
   * raw SQL beyond the id-rewrite expression the UPDATE needs anyway.
   */
  private async findCollidingMessageIds(
    db: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- db or transaction
    sourceId: string,
    from: number,
    to: number,
  ): Promise<string[]> {
    const messages = this.table('messages');
    const survivorRows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.fromNodeNum, to), eq(messages.sourceId, sourceId)));
    if (survivorRows.length === 0) return [];

    // Map each surviving id back to what the predecessor's copy would be called.
    const candidates = survivorRows
      .map((r: { id: string }) => this.rewriteMessageId(String(r.id), sourceId, to, from))
      .filter((id: string) => id.startsWith(`${sourceId}_${from}_`));
    if (candidates.length === 0) return [];

    const found: string[] = [];
    for (const batch of this.chunk(candidates, 500)) {
      const rows = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(inArray(messages.id, batch), eq(messages.fromNodeNum, from)));
      for (const row of rows) found.push(String(row.id));
    }
    return found;
  }

  /** Rows in `neighbor_info` that would become a self-loop once both columns move. */
  private neighborSelfLoopCondition(from: number, to: number, sourceId: string): SQL {
    const t = this.table('neighborInfo');
    return and(
      eq(t.sourceId, sourceId),
      sql`(${t.nodeNum} = ${from} OR ${t.nodeNum} = ${to})`,
      sql`(${t.neighborNodeNum} = ${from} OR ${t.neighborNodeNum} = ${to})`,
    ) as SQL;
  }

  private async countNeighborSelfLoops(
    db: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- db or transaction
    sourceId: string,
    from: number,
    to: number,
  ): Promise<number> {
    const t = this.table('neighborInfo');
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .where(this.neighborSelfLoopCondition(from, to, sourceId));
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Fields carried from the retired row onto the survivor: the earlier
   * first-seen date, and operator-entered data the survivor does not have.
   * Anything not listed here stays as the survivor has it — and the retired
   * row is snapshotted whole regardless, so nothing is unrecoverable.
   */
  private buildNodePatch(
    fromRow: Record<string, unknown>,
    toRow: Record<string, unknown>,
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {};

    const fromCreated = Number(fromRow.createdAt ?? 0);
    const toCreated = Number(toRow.createdAt ?? 0);
    if (fromCreated > 0 && (toCreated === 0 || toSeconds(fromCreated) < toSeconds(toCreated))) {
      patch.createdAt = fromRow.createdAt;
    }

    const fromNotes = typeof fromRow.notes === 'string' ? fromRow.notes.trim() : '';
    const toNotes = typeof toRow.notes === 'string' ? toRow.notes.trim() : '';
    if (fromNotes.length > 0 && toNotes.length === 0) patch.notes = fromRow.notes;

    if (this.truthy(fromRow.isFavorite) && !this.truthy(toRow.isFavorite)) {
      patch.isFavorite = fromRow.isFavorite;
      if (this.truthy(fromRow.favoriteLocked)) patch.favoriteLocked = fromRow.favoriteLocked;
    }

    return patch;
  }

  /** SQLite stores booleans as 0/1, PostgreSQL as true/false. */
  private truthy(value: unknown): boolean {
    return value === true || value === 1;
  }

  // -------------------------------------------------------------------------
  // Execute
  // -------------------------------------------------------------------------

  /**
   * Perform the merge. Everything below happens in ONE transaction: if any
   * statement throws, nothing at all is written — a half-applied merge is worse
   * than one that refuses to start.
   */
  async executeMerge(options: ExecuteMergeOptions): Promise<ExecuteMergeResult> {
    const { sourceId, basis, mergedBy } = options;
    const from = Number(options.fromNodeNum);
    const to = Number(options.toNodeNum);

    if (!sourceId) {
      throw new NodeIdentityMergeError('SOURCE_REQUIRED', 'sourceId is required; a merge never crosses sources.');
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new NodeIdentityMergeError('INVALID_NODE', 'Both node numbers must be numeric.');
    }
    if (from === to) {
      throw new NodeIdentityMergeError('SAME_NODE', 'A node cannot be merged into itself.');
    }

    const mergeId = this.newMergeId();
    const mergedAt = Date.now();
    let plan!: MergePlan;

    const run = async (tx: any): Promise<void> => { // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction handle
      plan = await this.buildMergePlan(sourceId, from, to, tx);

      if (!plan.undoable && !options.acknowledgeNoUndo) {
        throw new NodeIdentityMergeError(
          'UNDO_UNAVAILABLE',
          'This merge is too large to record an undo for. Re-submit with acknowledgeNoUndo to proceed anyway.',
        );
      }

      const journal: MergeJournal = {
        version: MERGE_JOURNAL_VERSION,
        sourceId,
        fromNodeNum: from,
        toNodeNum: to,
        fromNodeId: plan.fromNodeId,
        toNodeId: plan.toNodeId,
        mergedAt,
        entries: [],
      };

      // 1. Deletions FIRST, so the re-key captures below never contain a row
      //    that no longer exists — that ordering is what makes the undo replay
      //    (reverse order: re-key back, then re-insert) come out right.
      await this.dropMessageCollisions(tx, sourceId, from, to, journal);
      await this.dropNeighborSelfLoops(tx, sourceId, from, to, journal);

      // 2. Re-keys.
      for (const target of REKEY_TARGETS) {
        await this.applyRekey(tx, target, sourceId, from, to, journal);
      }

      // 3. Singleton rows (ignored_nodes, mesh_beacon_offers).
      for (const target of SINGLETON_TARGETS) {
        await this.applySingleton(tx, target, sourceId, from, to, journal);
      }

      // 4. The `nodes` rows themselves, last: the survivor picks up the
      //    retired row's first-seen date and any operator-entered data it
      //    lacks, then the retired row goes.
      await this.applyNodeRows(tx, sourceId, from, to, journal);

      // 5. The audit + undo record, in the same transaction as the work it
      //    describes. A journal that could be lost while the merge stood would
      //    be an unreversible merge labelled reversible.
      const mergesTable = this.table('nodeIdentityMerges');
      await tx.insert(mergesTable).values({
        id: mergeId,
        sourceId,
        fromNodeNum: from,
        toNodeNum: to,
        fromNodeId: plan.fromNodeId,
        toNodeId: plan.toNodeId,
        basis,
        mergedAt,
        mergedBy,
        rowsRekeyed: plan.totalRowsRekeyed,
        rowsDropped: plan.totalRowsDropped,
        undoable: plan.undoable,
        undoBlockedReason: plan.undoBlockedReason,
        undoneAt: null,
        undoneBy: null,
        journalVersion: MERGE_JOURNAL_VERSION,
        journal: JSON.stringify(plan.undoable ? journal : { ...journal, entries: [] }),
      });
    };

    await this.inTransaction(run);

    logger.info(
      `[nodeIdentityMerge] merged ${nodeNumToNodeId(from)} into ${nodeNumToNodeId(to)} on source ${sourceId}: ` +
        `${plan.totalRowsRekeyed} row(s) re-keyed, ${plan.totalRowsDropped} dropped, ` +
        `undo ${plan.undoable ? 'available' : 'UNAVAILABLE'} (merge ${mergeId})`,
    );

    return { mergeId, plan };
  }

  /**
   * Run `body` in ONE transaction on whichever backend is active. If anything
   * throws, nothing is written.
   *
   * The two branches are not interchangeable, and the difference is not
   * cosmetic:
   *
   * - **SQLite** uses better-sqlite3, which is synchronous, and Drizzle's
   *   sqlite-core `transaction()` refuses a Promise-returning callback outright
   *   — an `await` inside it yields to the microtask queue, the callback
   *   returns, and the transaction commits with the body half-run. So SQLite
   *   drives `BEGIN` / `COMMIT` / `ROLLBACK` explicitly instead. That is safe
   *   here precisely because better-sqlite3 has a single connection: every
   *   statement necessarily lands inside the transaction we opened.
   * - **PostgreSQL / MySQL** must use Drizzle's `transaction()`, because
   *   node-postgres pools: an explicit `BEGIN` through `db.execute()` grabs one
   *   pool client and the next statement grabs a different one, leaving the
   *   first idle-in-transaction for ever (#2780).
   */
  private async inTransaction(body: (tx: any) => Promise<void>): Promise<void> { // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction handle
    if (this.isSQLite()) {
      await this.db.run(sql`BEGIN`);
      try {
        await body(this.db);
      } catch (error) {
        try {
          await this.db.run(sql`ROLLBACK`);
        } catch (rollbackError) {
          logger.error('[nodeIdentityMerge] ROLLBACK failed after a merge error:', rollbackError);
        }
        throw error;
      }
      await this.db.run(sql`COMMIT`);
      return;
    }
    await (this.db as any).transaction(async (tx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- drizzle pg/mysql tx
      await body(tx);
    });
  }

  private newMergeId(): string {
    // randomUUID via globalThis.crypto — available on every supported Node.
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
    return `merge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  // -------------------------------------------------------------------------
  // Merge steps
  // -------------------------------------------------------------------------

  private async dropMessageCollisions(
    tx: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction
    sourceId: string,
    from: number,
    to: number,
    journal: MergeJournal,
  ): Promise<void> {
    const ids = await this.findCollidingMessageIds(tx, sourceId, from, to);
    if (ids.length === 0) return;
    const messages = this.table('messages');
    const rows = await tx.select().from(messages).where(inArray(messages.id, ids));
    journal.entries.push({ kind: 'delete', table: 'messages', label: 'messages', rows: this.plain(rows) });
    await tx.delete(messages).where(inArray(messages.id, ids));
  }

  private async dropNeighborSelfLoops(
    tx: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction
    sourceId: string,
    from: number,
    to: number,
    journal: MergeJournal,
  ): Promise<void> {
    const t = this.table('neighborInfo');
    const condition = this.neighborSelfLoopCondition(from, to, sourceId);
    const rows = await tx.select().from(t).where(condition);
    if (rows.length === 0) return;
    journal.entries.push({
      kind: 'delete',
      table: 'neighborInfo',
      label: 'neighbor_info',
      rows: this.plain(rows),
    });
    await tx.delete(t).where(condition);
  }

  private async applyRekey(
    tx: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction
    target: RekeyTarget,
    sourceId: string,
    from: number,
    to: number,
    journal: MergeJournal,
  ): Promise<void> {
    const t = this.table(target.table);
    const scope = and(eq(t[target.numColumn], from), eq(t.sourceId, sourceId));
    const survivorScope = and(eq(t[target.numColumn], to), eq(t.sourceId, sourceId));

    // Counts first, keys second: the predecessor's side can be hundreds of
    // thousands of rows, and pulling those keys into memory when the journal
    // is going to record the survivor's handful instead would be the one
    // avoidable memory blow-up in this path.
    const movedCount = await this.countWhere(tx, target.table, target.numColumn, from, sourceId);
    if (movedCount === 0) return;
    const survivorCount = await this.countWhere(tx, target.table, target.numColumn, to, sourceId);
    const capture = chooseCapture(movedCount, survivorCount, Boolean(target.autoIncrementPk));

    const pkRows = await tx
      .select({ pk: t[target.pkColumn] })
      .from(t)
      .where(capture === 'survivor' ? survivorScope : scope);
    const pks: PkValue[] = pkRows.map((r: { pk: PkValue }) => r.pk);

    // For a survivor capture, undo has to tell "was re-keyed by this merge"
    // from "arrived afterwards". The auto-increment key gives that for free —
    // and `chooseCapture` only picks `survivor` when there is one.
    const pkHighWater =
      capture === 'survivor' ? await this.maxIntPk(tx, target.table, target.pkColumn) : null;

    journal.entries.push({
      kind: 'rekey',
      table: target.table,
      label: target.label,
      numColumn: target.numColumn,
      idColumns: target.idColumns,
      rewritesPk: Boolean(target.rewritesPk),
      pkColumn: target.pkColumn,
      capture,
      pks,
      movedCount,
      pkHighWater,
    });

    const set: Record<string, unknown> = { [target.numColumn]: to };
    for (const col of target.idColumns) set[col] = nodeNumToNodeId(to);
    if (target.rewritesPk) {
      const prefixLength = `${sourceId}_${from}_`.length;
      set[target.pkColumn] = this.messageIdRewrite(sourceId, to, prefixLength);
    }
    await tx.update(t).set(set).where(scope);
  }

  /** Highest auto-increment key currently in a table, or null when it is empty. */
  private async maxIntPk(
    tx: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction
    tableName: string,
    pkColumn: string,
  ): Promise<number | null> {
    const t = this.table(tableName);
    const rows = await tx.select({ m: sql<number>`max(${t[pkColumn]})` }).from(t);
    const max = rows[0]?.m;
    return max == null ? null : Number(max);
  }

  private async applySingleton(
    tx: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction
    target: SingletonTarget,
    sourceId: string,
    from: number,
    to: number,
    journal: MergeJournal,
  ): Promise<void> {
    const t = this.table(target.table);
    const fromScope = and(eq(t[target.numColumn], from), eq(t.sourceId, sourceId));
    const fromRows = await tx.select().from(t).where(fromScope);
    if (fromRows.length === 0) return;

    const toRows = await tx
      .select()
      .from(t)
      .where(and(eq(t[target.numColumn], to), eq(t.sourceId, sourceId)));

    // Either way the old row leaves; the journal keeps it whole so undo can put
    // it back exactly as it was, whichever branch ran.
    journal.entries.push({
      kind: 'delete',
      table: target.table,
      label: target.label,
      rows: this.plain(fromRows),
    });
    await tx.delete(t).where(fromScope);

    if (toRows.length === 0) {
      // Nothing to collide with: re-insert the row under the surviving number.
      const moved = this.plain(fromRows).map((row) => ({
        ...row,
        [target.numColumn]: to,
        ...(Object.prototype.hasOwnProperty.call(row, 'nodeId') ? { nodeId: nodeNumToNodeId(to) } : {}),
      }));
      await tx.insert(t).values(moved);
    }
  }

  private async applyNodeRows(
    tx: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction
    sourceId: string,
    from: number,
    to: number,
    journal: MergeJournal,
  ): Promise<void> {
    const nodes = this.table('nodes');
    const fromScope = and(eq(nodes.nodeNum, from), eq(nodes.sourceId, sourceId));
    const [fromRow] = await tx.select().from(nodes).where(fromScope).limit(1);
    const [toRow] = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.nodeNum, to), eq(nodes.sourceId, sourceId)))
      .limit(1);
    if (!fromRow || !toRow) {
      throw new NodeIdentityMergeError('NODE_NOT_FOUND', 'One of the nodes disappeared mid-merge.');
    }

    const patch = this.buildNodePatch(fromRow, toRow);
    if (Object.keys(patch).length > 0) {
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(patch)) before[key] = (toRow as Record<string, unknown>)[key];
      journal.entries.push({
        kind: 'patch',
        table: 'nodes',
        label: 'nodes',
        where: { nodeNum: to, sourceId },
        before,
      });
      await tx
        .update(nodes)
        .set(patch)
        .where(and(eq(nodes.nodeNum, to), eq(nodes.sourceId, sourceId)));
    }

    journal.entries.push({
      kind: 'delete',
      table: 'nodes',
      label: 'nodes',
      rows: this.plain([fromRow]),
    });
    await tx.delete(nodes).where(fromScope);
  }

  /** Strip Drizzle row prototypes / BigInt so the journal serializes cleanly. */
  private plain(rows: unknown[]): Record<string, unknown>[] {
    return rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
        out[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      return out;
    });
  }

  // -------------------------------------------------------------------------
  // Undo
  // -------------------------------------------------------------------------

  /**
   * Reverse a merge, replaying the journal backwards in one transaction.
   *
   * Refuses rather than guesses: an already-undone merge, an unreadable or
   * absent journal, a merge that was recorded as not undoable, a later merge on
   * the same source still standing that touches either node number, or a
   * re-appeared `nodes` row under the retired number all stop it.
   */
  async undoMerge(
    mergeId: string,
    undoneBy: string | null,
    expectedSourceId: string,
  ): Promise<MergeRecord> {
    const mergesTable = this.table('nodeIdentityMerges');
    const [record] = await this.db
      .select()
      .from(mergesTable)
      .where(eq(mergesTable.id, mergeId))
      .limit(1);
    if (!record) {
      throw new NodeIdentityMergeError('MERGE_NOT_FOUND', 'No such merge.');
    }
    // The caller's permission was checked against `expectedSourceId`, so the
    // merge must belong to that source. Checked BEFORE anything is written —
    // a 403 after the undo has already run is not a check.
    if (String(record.sourceId) !== expectedSourceId) {
      throw new NodeIdentityMergeError(
        'WRONG_SOURCE',
        'That merge belongs to a different source.',
      );
    }
    if (record.undoneAt != null) {
      throw new NodeIdentityMergeError('ALREADY_UNDONE', 'That merge has already been undone.');
    }
    if (!this.truthy(record.undoable)) {
      throw new NodeIdentityMergeError(
        'UNDO_UNAVAILABLE',
        record.undoBlockedReason === 'JOURNAL_TOO_LARGE'
          ? 'This merge was too large to record an undo for and cannot be reversed.'
          : 'This merge cannot be reversed.',
      );
    }
    if (Number(record.journalVersion) !== MERGE_JOURNAL_VERSION) {
      throw new NodeIdentityMergeError(
        'JOURNAL_VERSION',
        `Undo journal version ${record.journalVersion} cannot be read by this build.`,
      );
    }

    // A later merge that still stands may have moved these same rows again.
    // Undoing out of order would put them back under a number that no longer
    // means what it meant. Strictly last-in-first-out, per node pair.
    const laterRows = await this.db
      .select({ id: mergesTable.id, fromNodeNum: mergesTable.fromNodeNum, toNodeNum: mergesTable.toNodeNum })
      .from(mergesTable)
      .where(
        and(
          eq(mergesTable.sourceId, record.sourceId),
          gt(mergesTable.mergedAt, Number(record.mergedAt)),
          isNull(mergesTable.undoneAt),
        ),
      );
    const touched = new Set([Number(record.fromNodeNum), Number(record.toNodeNum)]);
    const blocker = laterRows.find(
      (r: { fromNodeNum: number; toNodeNum: number }) =>
        touched.has(Number(r.fromNodeNum)) || touched.has(Number(r.toNodeNum)),
    );
    if (blocker) {
      throw new NodeIdentityMergeError(
        'LATER_MERGE_PENDING',
        'A newer merge involving one of these nodes is still in place. Undo that one first.',
      );
    }

    let journal: MergeJournal;
    try {
      journal = JSON.parse(String(record.journal)) as MergeJournal;
    } catch {
      throw new NodeIdentityMergeError('JOURNAL_UNREADABLE', 'The undo journal for this merge is unreadable.');
    }
    if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
      throw new NodeIdentityMergeError('JOURNAL_UNREADABLE', 'The undo journal for this merge is empty.');
    }

    const sourceId = String(record.sourceId);
    const from = Number(record.fromNodeNum);
    const to = Number(record.toNodeNum);

    const nodesTable = this.table('nodes');
    const [resurrected] = await this.db
      .select({ nodeNum: nodesTable.nodeNum })
      .from(nodesTable)
      .where(and(eq(nodesTable.nodeNum, from), eq(nodesTable.sourceId, sourceId)))
      .limit(1);
    if (resurrected) {
      throw new NodeIdentityMergeError(
        'NODE_REAPPEARED',
        `Node ${nodeNumToNodeId(from)} exists again on this source. Undoing would collide with it.`,
      );
    }

    const undoneAt = Date.now();
    await this.inTransaction(async (tx) => {
      for (let i = journal.entries.length - 1; i >= 0; i--) {
        await this.revertEntry(tx, journal.entries[i], sourceId, from, to);
      }
      await tx
        .update(mergesTable)
        .set({ undoneAt, undoneBy })
        .where(eq(mergesTable.id, mergeId));
    });

    logger.info(
      `[nodeIdentityMerge] undid merge ${mergeId}: ${nodeNumToNodeId(to)} → ${nodeNumToNodeId(from)} ` +
        `restored on source ${sourceId}`,
    );

    return { ...(this.plain([record])[0] as unknown as MergeRecord), undoneAt, undoneBy };
  }

  private async revertEntry(
    tx: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- transaction
    entry: MergeJournalEntry,
    sourceId: string,
    from: number,
    to: number,
  ): Promise<void> {
    if (entry.kind === 'delete') {
      if (entry.rows.length === 0) return;
      await tx.insert(this.table(entry.table)).values(entry.rows);
      return;
    }

    if (entry.kind === 'patch') {
      const t = this.table(entry.table);
      const conditions = Object.entries(entry.where).map(([col, value]) => eq(t[col], value));
      await tx.update(t).set(entry.before).where(and(...conditions));
      return;
    }

    // kind === 'rekey'
    const t = this.table(entry.table);
    const set: Record<string, unknown> = { [entry.numColumn]: from };
    for (const col of entry.idColumns) set[col] = nodeNumToNodeId(from);
    if (entry.rewritesPk) {
      // Put the primary key back the way the merge found it. The rewrite is a
      // pure function of the node number, so it inverts exactly — no per-row
      // statements needed.
      const prefixLength = `${sourceId}_${to}_`.length;
      set[entry.pkColumn] = this.messageIdRewrite(sourceId, from, prefixLength);
    }

    if (entry.capture === 'moved') {
      // The journal holds the keys the rows had BEFORE the merge. When the
      // merge also rewrote the key (messages), those keys no longer exist —
      // but the rewrite is deterministic, so the current key follows from the
      // recorded one.
      const currentPks: PkValue[] = entry.rewritesPk
        ? entry.pks.map((pk) => this.rewriteMessageId(String(pk), sourceId, from, to))
        : entry.pks;
      for (const batch of this.chunk(currentPks, 500)) {
        await tx.update(t).set(set).where(inArray(t[entry.pkColumn], batch));
      }
      return;
    }

    // capture === 'survivor': revert everything now pointing at the surviving
    // node EXCEPT the rows that already did before the merge, and except
    // anything created since (which must keep the new number).
    const conditions: SQL[] = [eq(t[entry.numColumn], to), eq(t.sourceId, sourceId)];
    if (entry.pks.length > 0) {
      conditions.push(notInArray(t[entry.pkColumn], entry.pks));
    }
    if (entry.pkHighWater != null) {
      conditions.push(lte(t[entry.pkColumn], entry.pkHighWater));
    } else {
      // Belt and braces: a survivor capture without a high-water mark cannot
      // separate old rows from new ones, and `chooseCapture` never produces one.
      // Refuse rather than revert rows that arrived after the merge.
      throw new NodeIdentityMergeError(
        'JOURNAL_UNREADABLE',
        `Undo journal for ${entry.label}.${entry.numColumn} is missing its high-water mark.`,
      );
    }
    await tx.update(t).set(set).where(and(...conditions));
  }

  /**
   * Swap the node-number segment of a `messages.id`.
   *
   * The format is `${sourceId}_${nodeNum}_${packetId}` — packet id LAST — and
   * the source id may itself contain underscores, so the split is by known
   * prefix length, never by `split('_')`.
   */
  private rewriteMessageId(id: string, sourceId: string, fromNum: number, toNum: number): string {
    const prefix = `${sourceId}_${fromNum}_`;
    if (!id.startsWith(prefix)) return id;
    return `${sourceId}_${toNum}_${id.slice(prefix.length)}`;
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /** Merges recorded for one source, newest first. */
  async listMerges(sourceId: string, limit = 50): Promise<MergeRecord[]> {
    const t = this.table('nodeIdentityMerges');
    const rows = await this.db
      .select({
        id: t.id,
        sourceId: t.sourceId,
        fromNodeNum: t.fromNodeNum,
        toNodeNum: t.toNodeNum,
        fromNodeId: t.fromNodeId,
        toNodeId: t.toNodeId,
        basis: t.basis,
        mergedAt: t.mergedAt,
        mergedBy: t.mergedBy,
        rowsRekeyed: t.rowsRekeyed,
        rowsDropped: t.rowsDropped,
        undoable: t.undoable,
        undoBlockedReason: t.undoBlockedReason,
        undoneAt: t.undoneAt,
        undoneBy: t.undoneBy,
      })
      .from(t)
      .where(eq(t.sourceId, sourceId))
      .orderBy(desc(t.mergedAt))
      .limit(limit);

    return rows.map((row: Record<string, unknown>) => ({
      ...row,
      fromNodeNum: Number(row.fromNodeNum),
      toNodeNum: Number(row.toNodeNum),
      mergedAt: Number(row.mergedAt),
      rowsRekeyed: Number(row.rowsRekeyed),
      rowsDropped: Number(row.rowsDropped),
      undoable: this.truthy(row.undoable),
      undoneAt: row.undoneAt == null ? null : Number(row.undoneAt),
    })) as MergeRecord[];
  }
}
