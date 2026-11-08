import type { TracerouteRenderSegment } from './tracerouteSegments.js';
import type { SourcedMeshCoreHopLink } from '../services/analysisApi.js';

/** Subset of the traceroute-layer options a MeshCore link honours. */
export interface HopLinkSegmentOptions {
  directionMode: 'both' | 'inbound' | 'outbound';
  scopeToSelectedNode: boolean;
  minOccurrences: number;
  minSnr: number | null;
  /** Drop links last seen outside this window (the time slider). */
  timeWindow?: { startMs: number; endMs: number } | null;
}

/** Position-map key for a MeshCore node on one source. */
export function meshcorePositionKey(sourceId: string, publicKey: string): string {
  return `${sourceId}|mc:${publicKey.toLowerCase()}`;
}

/**
 * Turn MeshCore per-hop links into the shared traceroute render segments.
 *
 * Only links whose BOTH ends resolved to a public key are drawn (an
 * unresolved or ambiguous path hash has no node to anchor to), and only when
 * both ends have a position. A link runs sender -> receiver ("receiver heard
 * sender"), so for a selected node N: receiver == N is inbound, sender == N is
 * outbound. The weak-link and direction rules mirror `analyzeTraceroutes`.
 *
 * `positionByKey` is keyed by {@link meshcorePositionKey}; `selectedKey` is the
 * unified node key (`mc:<publicKey>`), or null when nothing MeshCore is
 * selected. Identity never uses a node number.
 */
export function hopLinksToRenderSegments(
  links: readonly SourcedMeshCoreHopLink[],
  positionByKey: ReadonlyMap<string, [number, number]>,
  selectedKey: string | null,
  options: HopLinkSegmentOptions,
): TracerouteRenderSegment[] {
  const selected = selectedKey?.startsWith('mc:') ? selectedKey.slice(3).toLowerCase() : null;
  const focus = selected !== null && options.scopeToSelectedNode;
  const out: TracerouteRenderSegment[] = [];
  for (const l of links) {
    const from = l.sender.publicKey?.toLowerCase();
    const to = l.receiver.publicKey?.toLowerCase();
    if (!from || !to || from === to) continue;
    if (l.sender.candidates > 1 || l.receiver.candidates > 1) continue;
    if (options.timeWindow && (l.lastTimestamp < options.timeWindow.startMs || l.lastTimestamp > options.timeWindow.endMs)) continue;
    if (l.count < options.minOccurrences) continue;
    if (options.minSnr !== null && l.avgSnr < options.minSnr) continue;
    let direction: 'inbound' | 'outbound' | 'neutral' = 'neutral';
    if (focus) {
      if (from !== selected && to !== selected) continue;
      direction = to === selected ? 'inbound' : 'outbound';
      if (options.directionMode !== 'both' && options.directionMode !== direction) continue;
    }
    const fromPos = positionByKey.get(meshcorePositionKey(l.sourceId, from));
    const toPos = positionByKey.get(meshcorePositionKey(l.sourceId, to));
    if (!fromPos || !toPos) continue;
    out.push({
      key: `${l.sourceId}:mc:${from}->${to}`,
      from: fromPos,
      to: toPos,
      fromKey: from,
      toKey: to,
      leg: 'neutral',
      direction,
      avgSnr: l.avgSnr,
      isMqtt: false,
      occurrences: l.count,
      timestamp: l.lastTimestamp,
    });
  }
  return out;
}
