/**
 * Client-side mirror of the `GET /api/nodes/identity-changes` payload
 * (Meshtastic 2.8 node-number change detection, issue #5032).
 *
 * Deliberately a mirror rather than an import: the server-side definitions live
 * in `src/server/services/nodeIdentityChangeService.ts`, which pulls in
 * `databaseService` and must never reach the browser bundle.
 *
 * All timestamps are unix **seconds**. The server normalises `createdAt`, which
 * the `nodes` table stores in milliseconds.
 */

/** One node in an identity-change pair. The public key itself is never sent. */
export interface IdentityChangeNode {
  nodeNum: number;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  hwModel: number | null;
  firmwareVersion: string | null;
  lastHeard: number | null;
  createdAt: number;
  hasPublicKey: boolean;
}

/**
 * One candidate "this new node is that old node" pairing.
 *
 * Advisory only. Nothing in MeshMonitor acts on a detection automatically; the
 * merge tool takes a node pair from an operator, never from this list.
 *
 * Only **key-verified** pairings are reported by default — `derivedNodeNum` and
 * `publicKey`. The server can be asked for `name`-basis guesses too
 * (`includeNameBasis`), but does not volunteer them: two different nodes that
 * happen to share a long and a short name are indistinguishable to a name
 * match, and that is precisely the input that would drive a wrong merge.
 */
export interface IdentityChangeDetection {
  /** The node that turned up with the new number. */
  successor: IdentityChangeNode;
  /** The node that fell silent as it appeared — where the history lives. */
  predecessor: IdentityChangeNode;
  /**
   * `derivedNodeNum` — the old row's public key CRC-32s to the new row's node
   * number, which is the firmware's own 2.8 rule, so this is verification.
   * `publicKey` — both rows carry the same key.
   * `name` — long and short names match; a heuristic, and **not reported
   * unless the caller asks for it**.
   */
  basis: 'derivedNodeNum' | 'publicKey' | 'name';
  confidence: 'high' | 'medium';
  derivedFromPredecessorKey: boolean;
  successorNodeNumIsKeyDerived: boolean;
  predecessorNodeNumIsKeyDerived: boolean;
  publicKeyMatches: boolean;
  nameMatches: boolean;
  hwModelMatches: boolean;
  successorFirmwareIs28OrLater: boolean;
  predecessorQuietForSeconds: number;
  handoverGapSeconds: number;
  /** Other nodes that also matched. Greater than 0 means the pick is ambiguous. */
  otherCandidateCount: number;
}

export interface IdentityChangeReport {
  sourceId: string;
  detections: IdentityChangeDetection[];
  /** True when the server clipped the list at its hard cap. */
  truncated: boolean;
  options: {
    appearWindowSeconds: number;
    quietLookbackSeconds: number;
    graceSeconds: number;
    minQuietSeconds: number;
    /** False on every normal request: name-only guesses are not reported. */
    includeNameBasis: boolean;
  };
}

// ---------------------------------------------------------------------------
// Merge tool (issue #5032)
// ---------------------------------------------------------------------------

/** One line of the dry-run preview: what happens to one table's rows. */
export interface MergePlanEntry {
  /** Physical table name, as it appears in the database. */
  table: string;
  /** The node-number column being re-keyed, or a pseudo-column for row ops. */
  column: string;
  action:
    | 'rekey'
    | 'dropCollision'
    | 'dropSelfLoop'
    | 'moveRow'
    | 'dropRow'
    | 'deleteNodeRow'
    | 'patchNodeRow';
  rows: number;
  note?: string;
}

/**
 * The dry run. Produced by the same code the merge itself runs, so what is
 * shown here is what will happen — not a separate estimate of it.
 */
export interface MergePreview {
  sourceId: string;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string | null;
  toNodeId: string | null;
  entries: MergePlanEntry[];
  totalRowsRekeyed: number;
  totalRowsDropped: number;
  /** How many primary keys the undo journal will hold. */
  journalPkCount: number;
  /** False when the merge is too large to record a complete undo for. */
  undoable: boolean;
  undoBlockedReason: string | null;
  /** Tables that deliberately keep the old node number, with the reason. */
  notRekeyed: { table: string; reason: string }[];
  warnings: string[];
  /**
   * `derivedNodeNum` / `publicKey` when a key-verified detection backs this
   * exact pair; `manual` when the operator supplied it themselves.
   */
  detectionBasis: 'derivedNodeNum' | 'publicKey' | 'manual';
}

/** One row of the merge history, and the handle an undo is aimed at. */
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

export interface MergeResult {
  mergeId: string;
  plan: Omit<MergePreview, 'detectionBasis'>;
  detectionBasis: MergePreview['detectionBasis'];
}
