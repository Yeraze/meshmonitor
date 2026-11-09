/**
 * One DB -> live-contact field merge for MeshCore views (P7a #6254, S8).
 *
 * Several fields live only on the durable node rows (`MeshCoreNode`), not on
 * the live contact records. The Nodes view (map popups) and the Direct
 * Messages view (detail panel) both copied them across with their own code;
 * this is the single implementation. The node row wins for the #5578 advert
 * position fields and the advert signature; battery and first-heard only fill
 * a gap on the contact.
 */
import type { MeshCoreNode } from '../components/MeshCore/hooks/useMeshCore.js';
import type { MeshCoreContact } from './meshcoreHelpers.js';

export type NodeMergeField = 'batteryMv' | 'firstHeard' | 'advertPosition' | 'advertSignatureVerified' | 'clockOffset';

export const ALL_NODE_MERGE_FIELDS: readonly NodeMergeField[] = [
  'batteryMv', 'firstHeard', 'advertPosition', 'advertSignatureVerified', 'clockOffset',
];

export interface NodeFieldIndex {
  batteryMv: Map<string, number>;
  firstHeard: Map<string, number>;
  advertPosition: Map<string, Pick<MeshCoreContact, 'lastAdvertHadPosition' | 'positionSource'>>;
  /** Only keys whose stored value is true or false; null/undefined = not checked. */
  advertSignatureVerified: Map<string, boolean>;
  /** Persisted clock offset in seconds, only for nodes the scan currently flags (#6281). */
  clockOffset: Map<string, number>;
}

/** Index the node rows by public key. */
export function indexNodeFields(nodes: readonly MeshCoreNode[]): NodeFieldIndex {
  const idx: NodeFieldIndex = {
    batteryMv: new Map(),
    firstHeard: new Map(),
    advertPosition: new Map(),
    advertSignatureVerified: new Map(),
    clockOffset: new Map(),
  };
  for (const n of nodes) {
    if (!n.publicKey) continue;
    if (typeof n.batteryMv === 'number') idx.batteryMv.set(n.publicKey, n.batteryMv);
    if (typeof n.firstHeard === 'number') idx.firstHeard.set(n.publicKey, n.firstHeard);
    if (n.lastAdvertHadPosition != null || n.positionSource != null) {
      idx.advertPosition.set(n.publicKey, {
        lastAdvertHadPosition: n.lastAdvertHadPosition,
        positionSource: n.positionSource,
      });
    }
    if (typeof n.clockOffsetSeconds === 'number') idx.clockOffset.set(n.publicKey, n.clockOffsetSeconds);
    // SQLite booleans can arrive as 0/1 from older rows.
    const sig = n.advertSignatureVerified as boolean | number | null | undefined;
    if (sig === true || sig === 1) idx.advertSignatureVerified.set(n.publicKey, true);
    else if (sig === false || sig === 0) idx.advertSignatureVerified.set(n.publicKey, false);
  }
  return idx;
}

/** Copy the chosen node-row fields onto a contact. Returns the input when nothing changes. */
export function mergeNodeFields(
  contact: MeshCoreContact,
  idx: NodeFieldIndex,
  fields: readonly NodeMergeField[] = ALL_NODE_MERGE_FIELDS,
): MeshCoreContact {
  let c = contact;
  const key = contact.publicKey;
  if (fields.includes('batteryMv')) {
    const batteryMv = idx.batteryMv.get(key);
    if (batteryMv !== undefined && c.batteryMv === undefined) c = { ...c, batteryMv };
  }
  if (fields.includes('firstHeard')) {
    const firstHeard = idx.firstHeard.get(key);
    if (firstHeard !== undefined && c.firstHeard === undefined) c = { ...c, firstHeard };
  }
  if (fields.includes('advertPosition')) {
    const advertPosition = idx.advertPosition.get(key);
    if (advertPosition) {
      c = {
        ...c,
        lastAdvertHadPosition: advertPosition.lastAdvertHadPosition ?? c.lastAdvertHadPosition,
        positionSource: advertPosition.positionSource ?? c.positionSource,
      };
    }
  }
  if (fields.includes('advertSignatureVerified')) {
    const sig = idx.advertSignatureVerified.get(key);
    if (sig !== undefined) c = { ...c, advertSignatureVerified: sig };
  }
  if (fields.includes('clockOffset')) {
    const clockOffsetSeconds = idx.clockOffset.get(key);
    if (clockOffsetSeconds !== undefined) c = { ...c, clockOffsetSeconds };
  }
  return c;
}
