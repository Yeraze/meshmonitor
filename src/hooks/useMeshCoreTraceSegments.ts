import { useMemo } from 'react';
import { useMeshCoreTraceLinks } from './useMapAnalysisData';
import {
  hopLinksToRenderSegments,
  meshcorePositionKey,
  type HopLinkSegmentOptions,
} from '../utils/meshcoreTraceSegments';
import { resolveNodeLatLng, type MaybePositionedNode } from '../components/MapAnalysis/nodePositionUtil';
import type { TracerouteRenderSegment } from '../utils/tracerouteSegments';

interface MeshCoreNodeLike extends MaybePositionedNode {
  sourceId?: string;
  isMeshCore?: boolean | null;
  publicKey?: string | null;
  hideFromMap?: boolean | null;
}

export interface UseMeshCoreTraceSegmentsParams {
  enabled: boolean;
  sourceIds: string[];
  lookbackHours: number;
  /** Unified node list (positions come from here, like the Meshtastic layer). */
  nodes: readonly unknown[] | undefined;
  /** Unified key of the selected node, or null. */
  selectedKey: string | null;
  options: HopLinkSegmentOptions;
}

/**
 * MeshCore hop-link render segments for Map Analysis, shared by the 2D layer
 * and the 3D line hook so both draw the same links.
 */
export function useMeshCoreTraceSegments(p: UseMeshCoreTraceSegmentsParams): TracerouteRenderSegment[] {
  const { data } = useMeshCoreTraceLinks(p.sourceIds, p.lookbackHours, p.enabled);
  const links = data?.links;
  const positionByKey = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const n of (p.nodes ?? []) as MeshCoreNodeLike[]) {
      if (!n.isMeshCore || !n.publicKey || n.hideFromMap) continue;
      const ll = resolveNodeLatLng(n);
      if (ll) m.set(meshcorePositionKey(n.sourceId ?? '', n.publicKey), ll);
    }
    return m;
  }, [p.nodes]);
  const { directionMode, scopeToSelectedNode, minOccurrences, minSnr, timeWindow } = p.options;
  const startMs = timeWindow?.startMs;
  const endMs = timeWindow?.endMs;
  return useMemo(() => {
    if (!p.enabled || !links) return [];
    return hopLinksToRenderSegments(links, positionByKey, p.selectedKey, {
      directionMode,
      scopeToSelectedNode,
      minOccurrences,
      minSnr,
      timeWindow: startMs !== undefined && endMs !== undefined ? { startMs, endMs } : null,
    });
  }, [p.enabled, links, positionByKey, p.selectedKey, directionMode, scopeToSelectedNode, minOccurrences, minSnr, startMs, endMs]);
}
