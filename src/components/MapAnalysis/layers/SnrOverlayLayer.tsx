import { CircleMarker } from 'react-leaflet';
import { useMemo } from 'react';
import {
  useDashboardSources,
  useDashboardUnifiedData,
} from '../../../hooks/useDashboardData';
import { usePositions } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { resolveNodeLatLng, type MaybePositionedNode } from '../nodePositionUtil';
import { unifiedNodeKey, type IdentifiableNode } from '../../../utils/nodeIdentity';
import type { PositionRow } from '../../../services/analysisApi';

type PositionRecord = PositionRow;

interface NodeRecord extends MaybePositionedNode, IdentifiableNode {
  nodeNum: number;
  sourceId?: string;
  snr?: number | null;
  hideFromMap?: boolean | null;
}

interface SnrDot {
  /** Canonical identity (`mt:<n>` / `mc:<pk>`); MeshCore's nodeNum is synthetic. */
  nodeKey: string;
  nodeNum: number;
  latitude: number;
  longitude: number;
  timestamp: number;
}

/**
 * SNR Overlay: one dot per node colored by the node's most recent SNR
 * (sourced from the unified node table; the analysis positions endpoint
 * doesn't carry per-fix SNR yet).
 *
 * Lookback semantics:
 *   - null  -> "Last": one dot per node from the unified node table
 *              (latest known position regardless of when it was recorded).
 *   - >0    -> Latest position per node within the rolling window.
 *
 * Color thresholds match the MapLegend's "SNR (dB)" section:
 *   ≥5 excellent, 0..5 good, -5..0 fair, <-5 poor, missing → noData.
 *
 * The dot is clickable and selects the node in MapAnalysisContext. The click
 * payload omits sourceId because the unified merge collapses cross-source
 * duplicates and AnalysisInspectorPanel falls back to nodeNum-only matching
 * when sourceId is undefined.
 */
const SNR_COLORS = {
  excellent: '#22c55e',
  good:      '#eab308',
  fair:      '#f97316',
  poor:      '#ef4444',
  noData:    '#888',
} as const;

function colorForSnr(snr: number | null | undefined): string {
  if (typeof snr !== 'number' || Number.isNaN(snr)) return SNR_COLORS.noData;
  if (snr >= 5) return SNR_COLORS.excellent;
  if (snr >= 0) return SNR_COLORS.good;
  if (snr >= -5) return SNR_COLORS.fair;
  return SNR_COLORS.poor;
}

export default function SnrOverlayLayer() {
  const { config, setSelected } = useMapAnalysisCtx();
  const layer = config.layers.snrOverlay;
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;

  const isLastMode = layer.lookbackHours === null;

  // Windowed mode: pull positions from analysis API and dedupe to latest per node.
  const { items: positionItems } = usePositions({
    enabled: layer.enabled && !isLastMode,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
  });

  // Unified node table is the source of truth for the latest SNR per node
  // (and also provides positions for "Last" mode). React Query caches across
  // layers so this is shared with NodeMarkersLayer / inspector.
  const unified = useDashboardUnifiedData(
    sourceIds,
    layer.enabled && sourceIds.length > 0,
  );

  const snrByNode = useMemo(() => {
    const m = new Map<string, number | null | undefined>();
    for (const n of (unified.nodes ?? []) as NodeRecord[]) {
      const k = unifiedNodeKey(n);
      if (k !== null && !m.has(k)) m.set(k, n.snr ?? undefined);
    }
    return m;
  }, [unified.nodes]);

  // nodeKey -> merged node record. The SNR dot ALWAYS renders at the merged
  // node's position (`resolveNodeLatLng`), the same coordinate NodeMarkersLayer
  // and the trail endpoints use — so the dot can never detach from the marker.
  // (#4166: the old windowed path picked a raw per-fix position by highest
  // packet timestamp with no source priority, which for a node heard over both
  // LoRa and MQTT with diverging positions could land on the other source's
  // fix instead of the merged/marker position.)
  const nodeByKey = useMemo(() => {
    const m = new Map<string, NodeRecord>();
    for (const n of (unified.nodes ?? []) as NodeRecord[]) {
      const k = unifiedNodeKey(n);
      if (k !== null && !m.has(k)) m.set(k, n);
    }
    return m;
  }, [unified.nodes]);

  const ts = config.timeSlider;
  const dots: SnrDot[] = useMemo(() => {
    if (isLastMode) {
      const seen = new Set<string>();
      const out: SnrDot[] = [];
      for (const n of (unified.nodes ?? []) as NodeRecord[]) {
        const k = unifiedNodeKey(n);
        if (k === null || seen.has(k)) continue;
        // #4163-class: a "Hide from Map" node has no marker, so no SNR dot.
        if (n.hideFromMap) continue;
        const ll = resolveNodeLatLng(n);
        if (!ll) continue;
        seen.add(k);
        out.push({ nodeKey: k, nodeNum: Number(n.nodeNum), latitude: ll[0], longitude: ll[1], timestamp: 0 });
      }
      return out;
    }
    // Windowed: `positionItems` decides only WHICH nodes had a fix in the
    // window (and the newest such fix's timestamp, for the time-slider filter);
    // the dot POSITION comes from the merged node record so it stays pinned to
    // the marker. A node with in-window fixes but no merged record / no
    // resolvable position / hidden has no marker, so it gets no dot either.
    const latestTs = new Map<string, number>();
    for (const p of positionItems as PositionRecord[]) {
      const k = p.nodeKey ?? `mt:${Number(p.nodeNum)}`;
      const prev = latestTs.get(k);
      if (prev === undefined || p.timestamp > prev) latestTs.set(k, p.timestamp);
    }
    const out: SnrDot[] = [];
    for (const [k, timestamp] of latestTs) {
      const node = nodeByKey.get(k);
      if (!node || node.hideFromMap) continue;
      const ll = resolveNodeLatLng(node);
      if (!ll) continue;
      out.push({ nodeKey: k, nodeNum: Number(node.nodeNum), latitude: ll[0], longitude: ll[1], timestamp });
    }
    if (
      !ts.enabled ||
      ts.windowStartMs === undefined ||
      ts.windowEndMs === undefined
    ) {
      return out;
    }
    return out.filter(
      (d) => d.timestamp >= ts.windowStartMs! && d.timestamp <= ts.windowEndMs!,
    );
  }, [
    isLastMode,
    positionItems,
    unified.nodes,
    nodeByKey,
    ts.enabled,
    ts.windowStartMs,
    ts.windowEndMs,
  ]);

  return (
    <>
      {dots.map((d) => {
        const color = colorForSnr(snrByNode.get(d.nodeKey));
        return (
          <CircleMarker
            key={d.nodeKey}
            center={[d.latitude, d.longitude]}
            radius={6}
            pathOptions={{ color, fillColor: color, fillOpacity: 0.85, weight: 1 }}
            eventHandlers={{
              click: () => setSelected({ type: 'node', nodeNum: d.nodeNum, nodeKey: d.nodeKey }),
            }}
          />
        );
      })}
    </>
  );
}
