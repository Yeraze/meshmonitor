import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../hooks/useDashboardData';
import { useNeighbors, useMeshCoreNeighbors } from '../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx, type SelectedTarget } from './MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from './nodePositionUtil';
import { classifyNodeTransport, type NodeTransportClass } from '../../utils/nodeTransport';
import { snrToNeighborOpacity } from '../../utils/neighborLinks';
import type { Line3DFeature } from '../map/Base3DMap';

/**
 * 3D neighbor-link data hook (#3826 Phase 3 WP-2, spec §3.2).
 *
 * Reuses the SAME fetch hooks (`useNeighbors`/`useMeshCoreNeighbors`), the
 * same shared pure primitives (`snrToNeighborOpacity`, `classifyNodeTransport`),
 * and the same filters/lookback/time-window the 2D adapters
 * (`layers/NeighborLinksLayer.tsx`, `layers/MeshCoreNeighborLinksLayer.tsx`)
 * use, so 2D and 3D always show the same edges. Those files are off-limits to
 * edit (spec §0); this hook duplicates their thin data-wiring in new 3D-only
 * code, and the `selectionByKey` payloads are locked to the 2D adapters'
 * literal `setSelected(...)` shapes by a parity test
 * (`use3DNeighborLines.test.ts`).
 */

// mirror of layers/NeighborLinksLayer.tsx L16-20 (transportColor)
function transportColor(tc: NodeTransportClass): string {
  if (tc === 'mqtt') return '#22c55e';
  if (tc === 'udp') return '#f97316';
  return '#06b6d4';
}

// mirror of layers/MeshCoreNeighborLinksLayer.tsx L15 (MC_NEIGHBOR_COLOR)
const MC_NEIGHBOR_COLOR = '#06b6d4';

// Per spec §2.2's line-encoding-parity table.
const MT_LINE_WIDTH = 2;
const MT_LINE_DASH = [2, 2];
const MC_LINE_WIDTH = 3;
const MC_LINE_DASH = [3, 2];

interface NeighborEdge {
  id: number | string;
  nodeNum: number;
  neighborNum: number;
  sourceId: string;
  snr: number | null;
  timestamp?: number;
}

interface MeshCoreNeighborEdge {
  id: number;
  publicKey: string;
  neighborPublicKey: string;
  sourceId: string;
  snr: number | null;
  timestamp: number;
  nodeName: string | null;
  neighborName: string | null;
}

interface NodeRecord extends MaybePositionedNode {
  nodeNum: number;
  sourceId?: string;
  isMeshCore?: boolean;
  publicKey?: string;
  transportMechanism?: number | null;
  viaMqtt?: boolean | null;
}

export interface NeighborLines3D {
  lines: Line3DFeature[];
  selectionByKey: Map<string, SelectedTarget>;
}

export function use3DNeighborLines(): NeighborLines3D {
  const { config } = useMapAnalysisCtx();
  const layer = config.layers.neighbors;
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;

  const { data: mtData } = useNeighbors({
    enabled: layer.enabled,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
  });
  const { data: mcData } = useMeshCoreNeighbors({
    enabled: layer.enabled,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
  });
  const { nodes } = useDashboardUnifiedData(sourceIds, sourceIds.length > 0);

  // Meshtastic endpoint resolution — mirrors layers/NeighborLinksLayer.tsx
  // L67-106 (positionByKey/transportByKey + the #3792 cross-source fallback
  // maps keyed by nodeNum alone).
  const positionByKey = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      const ll = resolveNodeLatLng(n);
      if (ll) map.set(`${n.sourceId ?? ''}:${Number(n.nodeNum)}`, ll);
    }
    return map;
  }, [nodes]);

  const transportByKey = useMemo(() => {
    const map = new Map<string, NodeTransportClass>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      map.set(`${n.sourceId ?? ''}:${Number(n.nodeNum)}`, classifyNodeTransport(n));
    }
    return map;
  }, [nodes]);

  const positionByNode = useMemo(() => {
    const map = new Map<number, [number, number]>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      const ll = resolveNodeLatLng(n);
      if (ll && !map.has(Number(n.nodeNum))) map.set(Number(n.nodeNum), ll);
    }
    return map;
  }, [nodes]);

  const transportByNode = useMemo(() => {
    const map = new Map<number, NodeTransportClass>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      if (!map.has(Number(n.nodeNum))) map.set(Number(n.nodeNum), classifyNodeTransport(n));
    }
    return map;
  }, [nodes]);

  // MeshCore endpoint resolution — mirrors layers/MeshCoreNeighborLinksLayer.tsx
  // L62-70 (positionByKey keyed by publicKey).
  const mcPositionByKey = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const n of (nodes ?? []) as NodeRecord[]) {
      if (!n.isMeshCore || !n.publicKey) continue;
      const ll = resolveNodeLatLng(n);
      if (ll) map.set(`${n.sourceId ?? ''}:${n.publicKey}`, ll);
    }
    return map;
  }, [nodes]);

  const ts = config.timeSlider;

  return useMemo(() => {
    if (!layer.enabled) return { lines: [], selectionByKey: new Map<string, SelectedTarget>() };

    const inWindow = (t: number): boolean =>
      !ts.enabled ||
      ts.windowStartMs === undefined ||
      ts.windowEndMs === undefined ||
      (t >= ts.windowStartMs && t <= ts.windowEndMs);

    const lines: Line3DFeature[] = [];
    const selectionByKey = new Map<string, SelectedTarget>();

    // --- Meshtastic edges — mirrors layers/NeighborLinksLayer.tsx L115-175.
    const mtItems = (mtData as { items?: NeighborEdge[] } | undefined)?.items ?? [];
    for (const e of mtItems.filter((edge) => inWindow(edge.timestamp ?? 0))) {
      const aKey = `${e.sourceId}:${Number(e.nodeNum)}`;
      const bKey = `${e.sourceId}:${Number(e.neighborNum)}`;
      const a = positionByKey.get(aKey) ?? positionByNode.get(Number(e.nodeNum));
      const b = positionByKey.get(bKey) ?? positionByNode.get(Number(e.neighborNum));
      if (!a || !b) continue;
      const aTx = transportByKey.get(aKey) ?? transportByNode.get(Number(e.nodeNum)) ?? 'rf';
      const bTx = transportByKey.get(bKey) ?? transportByNode.get(Number(e.neighborNum)) ?? 'rf';
      const tc: NodeTransportClass =
        aTx === 'mqtt' || bTx === 'mqtt' ? 'mqtt' : aTx === 'udp' || bTx === 'udp' ? 'udp' : 'rf';

      const key = `mt:${String(e.id)}`;
      lines.push({
        key,
        from: a,
        to: b,
        color: transportColor(tc),
        opacity: snrToNeighborOpacity(e.snr),
        width: MT_LINE_WIDTH,
        dash: MT_LINE_DASH,
      });
      // PARITY: literal shape of the `setSelected(...)` call in
      // layers/NeighborLinksLayer.tsx L164-171.
      selectionByKey.set(key, {
        type: 'neighbor',
        sourceId: e.sourceId,
        nodeNum: Number(e.nodeNum),
        neighborNum: Number(e.neighborNum),
        snr: e.snr,
        timestamp: e.timestamp,
      });
    }

    // --- MeshCore edges — mirrors layers/MeshCoreNeighborLinksLayer.tsx L79-140.
    const mcItems = (mcData as { items?: MeshCoreNeighborEdge[] } | undefined)?.items ?? [];
    for (const e of mcItems.filter((edge) => inWindow(edge.timestamp))) {
      const aKey = `${e.sourceId}:${e.publicKey}`;
      const bKey = `${e.sourceId}:${e.neighborPublicKey}`;
      const a = mcPositionByKey.get(aKey);
      const b = mcPositionByKey.get(bKey);
      if (!a || !b) continue;

      const key = `mc:${String(e.id)}`;
      lines.push({
        key,
        from: a,
        to: b,
        color: MC_NEIGHBOR_COLOR,
        opacity: snrToNeighborOpacity(e.snr),
        width: MC_LINE_WIDTH,
        dash: MC_LINE_DASH,
      });
      // PARITY: literal shape of the `setSelected(...)` call in
      // layers/MeshCoreNeighborLinksLayer.tsx L125-136 (incl. the
      // `nodeNum:0, neighborNum:0` sentinels — carried verbatim).
      selectionByKey.set(key, {
        type: 'neighbor',
        sourceId: e.sourceId,
        publicKey: e.publicKey,
        neighborPublicKey: e.neighborPublicKey,
        nodeName: e.nodeName,
        neighborName: e.neighborName,
        snr: e.snr,
        timestamp: e.timestamp,
        nodeNum: 0,
        neighborNum: 0,
      });
    }

    return { lines, selectionByKey };
    // Unlike the 2D adapters (which need an eslint-disable here because their
    // dep array omits raw `data`/`ts.enabled` etc.), this dep list is fully
    // exhaustive — `inWindow` is declared inline above and captured by
    // closure, not as a separate dep.
  }, [
    mtData,
    mcData,
    positionByKey,
    positionByNode,
    transportByKey,
    transportByNode,
    mcPositionByKey,
    layer.enabled,
    ts.enabled,
    ts.windowStartMs,
    ts.windowEndMs,
  ]);
}
