/**
 * Wire shapes for the Security tab sections (P7a, #6254). Mirror the
 * `/api/security/dead-nodes` and `/api/security/meshcore/findings` responses.
 */

/** One dead node row. `lastHeard` is always SECONDS, for both protocols. */
export interface DeadNode {
  /** `mt:<nodeNum>` or `mc:<publicKey>`: the selection and delete key. */
  nodeKey: string;
  protocol?: 'meshtastic' | 'meshcore';
  nodeNum: number;
  nodeId: string;
  publicKey?: string;
  longName: string | null;
  shortName: string | null;
  hwModel: number | null;
  /** MeshCore advert type (1 chat, 2 repeater, 3 room, 4 sensor). */
  role?: number | null;
  lastHeard: number | null;
  inDeviceDb: boolean;
}

export interface DeadNodesResponse {
  nodes: DeadNode[];
  count: number;
  thresholdDays: number;
}

/** A MeshCore node as the findings route reports it (times in ms). */
export interface FindingNode {
  publicKey: string;
  nodeKey: string;
  name: string | null;
  advType: number | null;
  lastHeard: number | null;
  firstHeard: number | null;
  advertSignatureVerified: boolean | null;
}

export interface PathHashCollisionGroup {
  hash: string;
  nodes: FindingNode[];
}

export interface NameReuseGroup {
  name: string;
  original: FindingNode;
  suspects: FindingNode[];
}

export interface MeshcoreFindings {
  pathHashCollisions: {
    width: 1 | 2 | 3;
    countsByWidth: Record<1 | 2 | 3, number>;
    groups: PathHashCollisionGroup[];
  };
  signatureFailures: FindingNode[];
  nameReuse: NameReuseGroup[];
  ownKey: {
    currentKey: string | null;
    previousKey: string | null;
    detectedAt: number | null;
    pkiKeyMismatch: boolean;
  };
}

/** The `ok()` envelope the findings route returns. */
export interface MeshcoreFindingsResponse {
  success: boolean;
  data: MeshcoreFindings;
}

/** Opens a node by `mt:`/`mc:` key (Meshtastic DM thread, MeshCore Node Details). */
export type OpenNode = (nodeKey: string) => void;

/** 8 hex chars of a key, for compact display. */
export function keyPrefix(key: string | null | undefined): string {
  return key ? key.slice(0, 8) : '';
}
