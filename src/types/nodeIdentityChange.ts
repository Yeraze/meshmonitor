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
 * Advisory only. Nothing in MeshMonitor acts on a detection automatically —
 * a name match in particular is a guess, and two genuinely different nodes can
 * share a name.
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
   * `name` — long and short names match; a heuristic.
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
  };
}
