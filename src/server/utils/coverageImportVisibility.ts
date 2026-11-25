/**
 * Row gate for the Coverage Report read path (#5891 Phase 3, spec §2.5 / §3.7).
 *
 * Wraps the two position filters with the rule for imported rows. Live rows
 * (`importId == null`) get exactly the expressions the routes used before. An
 * imported row whose node RESOLVES on its source (a `nodes` / `meshcore_nodes`
 * row exists) keeps the per-node filter, so an import never shows a hidden or
 * private node. An imported row whose node is unknown there is visible to
 * admins and holders of the source's base map grant: `channel_0:viewOnMap` on a
 * Meshtastic source, `nodes:viewOnMap` on a MeshCore one (Resolution Q2).
 */
import type { DbNode } from '../../db/types.js';
import type { DbMeshCoreNode } from '../../db/repositories/meshcore.js';
import type { SourcePermissions } from './sourcePermissions.js';
import { isMeshCorePubKeyId, isMeshCoreReceptionRow } from '../../utils/coverage.js';

interface Subject {
  sourceId: string;
  meshcore: boolean;
  id: string;
  nodeNum: number | null;
}

export interface CoverageRowGate {
  senderVisible(row: {
    sourceId: string; protocol: string; senderId: string; senderNodeNum: number | null; importId?: string | null;
  }): boolean;
  receiverVisible(row: {
    sourceId: string; protocol: string; receiverId: string; receiverNodeNum: number | null; importId?: string | null;
  }): boolean;
  /** `/senders` group (rows carry no `protocol`; MeshCore is told by key shape). */
  senderGroupVisible(row: {
    sourceId: string; senderId: string; senderNodeNum: number | null; importedRows: number;
  }): boolean;
  /** `/receivers` group. */
  receiverGroupVisible(row: {
    sourceId: string; protocol: string; receiverId: string; receiverNodeNum: number | null; importedRows: number;
  }): boolean;
}

export function buildCoverageRowGate(args: {
  user: { isAdmin?: boolean } | null | undefined;
  posFilter: (r: { sourceId: string; nodeNum: number }) => boolean;
  mcFilter: ((r: { sourceId: string; publicKey: string }) => boolean) | null;
  nodesBySource: Map<string, DbNode[]>;
  mcNodesBySource: Map<string, DbMeshCoreNode[]>;
  grants: SourcePermissions;
}): CoverageRowGate {
  const { user, posFilter, mcFilter, grants } = args;
  const isAdmin = !!user?.isAdmin;

  const nodeKeys = new Set<string>();
  for (const [sourceId, nodes] of args.nodesBySource) {
    for (const n of nodes) nodeKeys.add(`${sourceId}:${Number(n.nodeNum)}`);
  }
  const mcKeys = new Set<string>();
  for (const [sourceId, nodes] of args.mcNodesBySource) {
    for (const n of nodes) mcKeys.add(`${sourceId}:${n.publicKey.toLowerCase()}`);
  }

  const resolved = (s: Subject): boolean =>
    s.meshcore
      ? mcKeys.has(`${s.sourceId}:${s.id.toLowerCase()}`)
      : s.nodeNum != null && nodeKeys.has(`${s.sourceId}:${s.nodeNum}`);

  const passFilter = (s: Subject): boolean =>
    s.meshcore
      ? !!mcFilter && mcFilter({ sourceId: s.sourceId, publicKey: s.id })
      : s.nodeNum != null && posFilter({ sourceId: s.sourceId, nodeNum: s.nodeNum });

  const unknownOk = (s: Subject): boolean =>
    isAdmin || grants.can(s.meshcore ? 'nodes' : 'channel_0', 'viewOnMap', s.sourceId);

  const rowVisible = (s: Subject, imported: boolean): boolean => {
    if (!imported) {
      // Today's rule, including the Meshtastic "no node number is kept" carve-out.
      if (s.meshcore) return passFilter(s);
      return s.nodeNum == null || passFilter(s);
    }
    return resolved(s) ? passFilter(s) : unknownOk(s);
  };

  const groupVisible = (s: Subject, importedRows: number): boolean => {
    if (resolved(s)) return passFilter(s);
    if (!s.meshcore && s.nodeNum == null) return true; // live carve-out, as before
    return importedRows > 0 && unknownOk(s);
  };

  const subject = (
    sourceId: string, meshcore: boolean, id: string, nodeNum: number | null,
  ): Subject => ({ sourceId, meshcore, id, nodeNum });

  return {
    senderVisible: (r) =>
      rowVisible(subject(r.sourceId, isMeshCoreReceptionRow(r), r.senderId, r.senderNodeNum), r.importId != null),
    receiverVisible: (r) =>
      rowVisible(subject(r.sourceId, isMeshCoreReceptionRow(r), r.receiverId, r.receiverNodeNum), r.importId != null),
    senderGroupVisible: (r) =>
      groupVisible(subject(r.sourceId, isMeshCorePubKeyId(r.senderId), r.senderId, r.senderNodeNum), r.importedRows),
    receiverGroupVisible: (r) =>
      groupVisible(subject(r.sourceId, isMeshCoreReceptionRow(r), r.receiverId, r.receiverNodeNum), r.importedRows),
  };
}

interface ReceiverGroupRow {
  sourceId: string;
  protocol: string;
  receiverKind: string;
  receiverId: string;
  receiverNodeNum: number | null;
  lastReceivedAt: number;
  receiverLatitude: number | null;
  receiverLongitude: number | null;
  receptionCount: number;
  importedRows: number;
  liveRows: number;
}

/**
 * Merge `getReceivers` rows (the repository returns a receiver's live and
 * imported rows as SEPARATE groups) into one row per receiver, gating each
 * part on its own rule so imported rows never unmask live data:
 *  - imported part visible, live part not: the live part is dropped, so count,
 *    last-seen time and position snapshot come from imported rows only;
 *  - imported part hidden from the viewer: it is dropped (live behaviour as before);
 *  - both visible: counts add, the live snapshot wins when it has one.
 */
export function mergeReceiverGroups<T extends ReceiverGroupRow>(rows: T[], gate: CoverageRowGate): T[] {
  const byKey = new Map<string, { live?: T; imported?: T }>();
  for (const r of rows) {
    const key = `${r.sourceId}|${r.receiverKind}|${r.receiverId}|${r.receiverNodeNum ?? ''}`;
    const entry = byKey.get(key) ?? {};
    if (r.importedRows > 0) entry.imported = r;
    else entry.live = r;
    byKey.set(key, entry);
  }
  const out: T[] = [];
  for (const { live, imported } of byKey.values()) {
    const keepImported = imported && gate.receiverGroupVisible(imported) ? imported : undefined;
    const keepLive = live && !(keepImported && !gate.receiverGroupVisible(live)) ? live : undefined;
    if (keepLive && keepImported) {
      const snap = keepLive.receiverLatitude != null ? keepLive : keepImported;
      out.push({
        ...keepLive,
        lastReceivedAt: Math.max(keepLive.lastReceivedAt, keepImported.lastReceivedAt),
        receiverLatitude: snap.receiverLatitude,
        receiverLongitude: snap.receiverLongitude,
        receptionCount: keepLive.receptionCount + keepImported.receptionCount,
        importedRows: keepImported.importedRows,
        liveRows: keepLive.liveRows,
      });
    } else if (keepLive || keepImported) {
      out.push((keepLive ?? keepImported) as T);
    }
  }
  return out;
}
