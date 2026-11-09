/**
 * One collector for a source's security issues (#6281 S4).
 *
 * `/issues`, `/export` and the digest all read through `collectSecurityIssues`,
 * so the merge of the key-issue, excessive-packet and time-offset node sets
 * lives in one place (it used to exist in `securityRoutes.ts` and again in
 * `securityDigestService.ts`). A protocol adapter reads each source type; the
 * wire fields of the Meshtastic shape are unchanged, and `nodeKey` / `protocol`
 * are added.
 *
 * Database access is injected so the digest keeps using the service it was
 * initialised with.
 */
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';
import { listSignatureFailures, findNameReuse } from './meshcoreSecurityFindings.js';
import { meshcoreOwnIdentityTracker } from './meshcoreOwnIdentityTracker.js';

export type SecurityProtocol = 'meshtastic' | 'meshcore';

export interface SecurityIssueNode {
  /** `mt:<nodeNum>` or `mc:<64-hex key>`. */
  nodeKey: string;
  protocol: SecurityProtocol;
  nodeNum: number;
  shortName: string | null;
  longName: string | null;
  /** Epoch seconds on both protocols. */
  lastHeard: number | null;
  keyIsLowEntropy: boolean;
  duplicateKeyDetected: boolean;
  keySecurityIssueDetails?: string | null;
  publicKey?: string | null;
  hwModel?: number | null;
  isExcessivePackets: boolean;
  packetRatePerHour: number | null;
  /** Epoch seconds. */
  packetRateLastChecked: number | null;
  isTimeOffsetIssue: boolean;
  /** Receipt minus sender time; positive = the node is behind. */
  timeOffsetSeconds: number | null;
  // MeshCore-only, additive.
  advType?: number | null;
  advertRatePerHour?: number | null;
  timeOffsetSource?: string | null;
  advertSignatureFailed?: boolean;
  /** Set on a node that reuses the name of an older key. */
  nameReused?: boolean;
}

export interface SecurityTopBroadcaster {
  nodeNum: number;
  shortName: string | null;
  longName: string | null;
  packetCount: number;
  nodeKey?: string;
}

export interface SecurityOwnKeyChange {
  currentKey: string | null;
  previousKey: string | null;
  detectedAt: number | null;
}

export interface CollectedSecurityIssues {
  protocol: SecurityProtocol;
  total: number;
  lowEntropyCount: number;
  duplicateKeyCount: number;
  excessivePacketsCount: number;
  timeOffsetCount: number;
  /** MeshCore only (0 on Meshtastic). */
  signatureFailureCount: number;
  nameReuseCount: number;
  counts: {
    lowEntropy: number;
    duplicateKey: number;
    excessivePackets: number;
    timeOffset: number;
    signatureFailure: number;
    nameReuse: number;
    ownKeyChanged: number;
  };
  nodes: SecurityIssueNode[];
  topBroadcasters: SecurityTopBroadcaster[];
  /** MeshCore only: an unacknowledged change of the source's own key. */
  ownKeyChange: SecurityOwnKeyChange | null;
}

/** The slice of DatabaseService the collector reads. */
export interface SecurityIssuesDb {
  getNodesWithKeySecurityIssuesAsync(sourceId?: string): Promise<any[]>;
  getNodesWithExcessivePacketsAsync(sourceId?: string): Promise<any[]>;
  getNodesWithTimeOffsetIssuesAsync(sourceId?: string): Promise<any[]>;
  getTopBroadcastersAsync(limit: number, sourceId?: string): Promise<any[]>;
  meshcore?: {
    getNodesBySource(sourceId: string): Promise<any[]>;
    getSecurityFlaggedNodes(sourceId: string): Promise<any[]>;
  };
}

const EMPTY_COUNTS = {
  lowEntropy: 0,
  duplicateKey: 0,
  excessivePackets: 0,
  timeOffset: 0,
  signatureFailure: 0,
  nameReuse: 0,
  ownKeyChanged: 0,
};

function mtNode(node: any, flags: 'key' | 'other'): SecurityIssueNode {
  const n = node;
  return {
    nodeKey: `mt:${Number(n.nodeNum)}`,
    protocol: 'meshtastic',
    nodeNum: n.nodeNum,
    shortName: n.shortName || 'Unknown',
    longName: n.longName || 'Unknown',
    lastHeard: n.lastHeard,
    keyIsLowEntropy: flags === 'key' ? n.keyIsLowEntropy : n.keyIsLowEntropy || false,
    duplicateKeyDetected: flags === 'key' ? n.duplicateKeyDetected : n.duplicateKeyDetected || false,
    keySecurityIssueDetails: n.keySecurityIssueDetails,
    publicKey: n.publicKey,
    hwModel: n.hwModel,
    isExcessivePackets: n.isExcessivePackets || false,
    packetRatePerHour: n.packetRatePerHour || null,
    packetRateLastChecked: n.packetRateLastChecked || null,
    isTimeOffsetIssue: n.isTimeOffsetIssue || false,
    timeOffsetSeconds: n.timeOffsetSeconds || null,
  };
}

async function collectMeshtastic(db: SecurityIssuesDb, sourceId: string, topN: number): Promise<CollectedSecurityIssues> {
  const [keyIssue, excessive, timeOffset] = await Promise.all([
    db.getNodesWithKeySecurityIssuesAsync(sourceId),
    db.getNodesWithExcessivePacketsAsync(sourceId),
    db.getNodesWithTimeOffsetIssuesAsync(sourceId),
  ]);

  const all = new Map<number, SecurityIssueNode>();
  for (const node of keyIssue) all.set(node.nodeNum, mtNode(node, 'key'));
  for (const node of excessive) {
    const existing = all.get(node.nodeNum);
    if (!existing) {
      all.set(node.nodeNum, { ...mtNode(node, 'other'), isExcessivePackets: true });
    } else {
      // The row came from the excessive-packets query, so it is flagged.
      existing.isExcessivePackets = true;
      existing.packetRatePerHour = node.packetRatePerHour || null;
      existing.packetRateLastChecked = node.packetRateLastChecked || null;
    }
  }
  for (const node of timeOffset) {
    const existing = all.get(node.nodeNum);
    if (!existing) {
      all.set(node.nodeNum, mtNode(node, 'other'));
    } else {
      existing.isTimeOffsetIssue = node.isTimeOffsetIssue || false;
      existing.timeOffsetSeconds = node.timeOffsetSeconds || null;
    }
  }

  const nodes = Array.from(all.values());
  const topBroadcasters = (await db.getTopBroadcastersAsync(topN, sourceId)) as SecurityTopBroadcaster[];
  return finish('meshtastic', nodes, topBroadcasters, null);
}

async function collectMeshcore(db: SecurityIssuesDb, sourceId: string, topN: number): Promise<CollectedSecurityIssues> {
  const repo = db.meshcore;
  if (!repo) return finish('meshcore', [], [], null);
  const [flagged, allNodes, change, currentKey] = await Promise.all([
    repo.getSecurityFlaggedNodes(sourceId),
    repo.getNodesBySource(sourceId),
    meshcoreOwnIdentityTracker.getChange(sourceId),
    meshcoreOwnIdentityTracker.getCurrentKey(sourceId),
  ]);

  const toNode = (n: any): SecurityIssueNode => {
    const pk = String(n.publicKey).toLowerCase();
    const checkedMs = n.packetRateLastChecked != null ? Number(n.packetRateLastChecked) : null;
    return {
      nodeKey: `mc:${pk}`,
      protocol: 'meshcore',
      nodeNum: nodeNumFromPubkey(pk),
      shortName: n.name || 'Unknown',
      longName: n.name || 'Unknown',
      // MeshCore stores ms; the issue contract is seconds.
      lastHeard: n.lastHeard ? Math.floor(Number(n.lastHeard) / 1000) : null,
      keyIsLowEntropy: false,
      duplicateKeyDetected: false,
      keySecurityIssueDetails: null,
      publicKey: pk,
      hwModel: null,
      isExcessivePackets: !!n.isExcessivePackets,
      packetRatePerHour: n.packetRatePerHour != null ? Number(n.packetRatePerHour) : null,
      packetRateLastChecked: checkedMs != null ? Math.floor(checkedMs / 1000) : null,
      isTimeOffsetIssue: !!n.isTimeOffsetIssue,
      timeOffsetSeconds: n.timeOffsetSeconds != null ? Number(n.timeOffsetSeconds) : null,
      advType: n.advType ?? null,
      advertRatePerHour: n.advertRatePerHour != null ? Number(n.advertRatePerHour) : null,
      timeOffsetSource: n.timeOffsetSource ?? null,
      advertSignatureFailed: false,
      nameReused: false,
    };
  };

  const byKey = new Map<string, SecurityIssueNode>();
  for (const n of flagged) byKey.set(String(n.publicKey).toLowerCase(), toNode(n));
  const ensure = (n: any): SecurityIssueNode => {
    const pk = String(n.publicKey).toLowerCase();
    let e = byKey.get(pk);
    if (!e) {
      e = toNode(n);
      byKey.set(pk, e);
    }
    return e;
  };
  for (const n of listSignatureFailures(allNodes)) ensure(n).advertSignatureFailed = true;
  for (const g of findNameReuse(allNodes)) for (const s of g.suspects) ensure(s).nameReused = true;

  const nodes = Array.from(byKey.values());
  const topBroadcasters: SecurityTopBroadcaster[] = flagged
    .filter((n) => n.packetRatePerHour != null)
    .sort((a, b) => Number(b.packetRatePerHour) - Number(a.packetRatePerHour))
    .slice(0, topN)
    .map((n) => {
      const pk = String(n.publicKey).toLowerCase();
      return {
        nodeNum: nodeNumFromPubkey(pk),
        nodeKey: `mc:${pk}`,
        shortName: n.name ?? null,
        longName: n.name ?? null,
        packetCount: Number(n.packetRatePerHour),
      };
    });
  const own: SecurityOwnKeyChange | null = change
    ? { currentKey: change.currentKey ?? currentKey ?? null, previousKey: change.previousKey ?? null, detectedAt: change.detectedAt ?? null }
    : null;
  return finish('meshcore', nodes, topBroadcasters, own);
}

function finish(
  protocol: SecurityProtocol,
  nodes: SecurityIssueNode[],
  topBroadcasters: SecurityTopBroadcaster[],
  ownKeyChange: SecurityOwnKeyChange | null,
): CollectedSecurityIssues {
  const counts = {
    ...EMPTY_COUNTS,
    lowEntropy: nodes.filter((n) => n.keyIsLowEntropy).length,
    duplicateKey: nodes.filter((n) => n.duplicateKeyDetected).length,
    excessivePackets: nodes.filter((n) => n.isExcessivePackets).length,
    timeOffset: nodes.filter((n) => n.isTimeOffsetIssue).length,
    signatureFailure: nodes.filter((n) => n.advertSignatureFailed).length,
    nameReuse: nodes.filter((n) => n.nameReused).length,
    ownKeyChanged: ownKeyChange ? 1 : 0,
  };
  return {
    protocol,
    total: nodes.length,
    lowEntropyCount: counts.lowEntropy,
    duplicateKeyCount: counts.duplicateKey,
    excessivePacketsCount: counts.excessivePackets,
    timeOffsetCount: counts.timeOffset,
    signatureFailureCount: counts.signatureFailure,
    nameReuseCount: counts.nameReuse,
    counts,
    nodes,
    topBroadcasters,
    ownKeyChange,
  };
}

export async function collectSecurityIssues(
  db: SecurityIssuesDb,
  sourceId: string,
  opts: { protocol: SecurityProtocol; topBroadcasters?: number },
): Promise<CollectedSecurityIssues> {
  const topN = opts.topBroadcasters ?? 5;
  return opts.protocol === 'meshcore' ? collectMeshcore(db, sourceId, topN) : collectMeshtastic(db, sourceId, topN);
}
