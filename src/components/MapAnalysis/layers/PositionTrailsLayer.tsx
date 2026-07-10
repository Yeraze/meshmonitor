/**
 * PositionTrailsLayer — deliberately different visualization from the shared
 * single-node age-gradient position history in `src/utils/mapHelpers.tsx`
 * (`getPositionHistoryColor`/`generatePositionHistoryArrows`). This layer
 * draws *many* nodes' trails at once, each colored by a deterministic hash
 * of `(sourceId, nodeNum)` (see `colorForKey` below), with whole-trail
 * click-to-select — vs. the shared helpers' single selected node with a
 * per-segment age gradient, per-fix dot markers, and heading arrows. There
 * is no shared rendering to extract; this is NOT a fork. See
 * `docs/internal/dev-notes/MAP_CONSOLIDATION_P2_SPEC.md` (§1.4, epic #4047
 * Phase 2) for the full comparison.
 */
import { Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { usePositions } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { isNodeEmphasized, selectionOpacity } from '../../../utils/nodeIdentity';

function colorForKey(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 70%, 55%)`;
}

interface PositionRecord {
  nodeNum: number;
  sourceId: string;
  latitude: number;
  longitude: number;
  timestamp: number;
}

/**
 * Renders a polyline per node connecting that node's recent position fixes
 * (sorted by timestamp). Color is deterministic per (sourceId, nodeNum) key.
 * Nodes with fewer than 2 fixes are skipped.
 */
export default function PositionTrailsLayer() {
  const { config, setSelected } = useMapAnalysisCtx();
  const layer = config.layers.trails;
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;
  const { items } = usePositions({
    enabled: layer.enabled,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
  });

  const tsCfg = config.timeSlider;
  const inWindow = (t: number): boolean =>
    !tsCfg.enabled ||
    tsCfg.windowStartMs === undefined ||
    tsCfg.windowEndMs === undefined ||
    (t >= tsCfg.windowStartMs && t <= tsCfg.windowEndMs);

  const trails = useMemo(() => {
    const grouped = new Map<string, Array<{ ts: number; pos: [number, number] }>>();
    const filtered = (items as PositionRecord[]).filter((p) => inWindow(p.timestamp));
    for (const p of filtered) {
      const key = `${p.sourceId}:${Number(p.nodeNum)}`;
      const arr = grouped.get(key) ?? [];
      arr.push({ ts: p.timestamp, pos: [p.latitude, p.longitude] });
      grouped.set(key, arr);
    }
    const out: Array<{
      key: string;
      positions: [number, number][];
      color: string;
      sourceId: string;
      nodeNum: number;
      pointCount: number;
      startMs: number;
      endMs: number;
    }> = [];
    for (const [key, arr] of grouped) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.ts - b.ts);
      const colonIdx = key.indexOf(':');
      const sourceId = colonIdx >= 0 ? key.slice(0, colonIdx) : '';
      const nodeNum = colonIdx >= 0 ? Number(key.slice(colonIdx + 1)) : 0;
      out.push({
        key,
        positions: arr.map((x) => x.pos),
        color: colorForKey(key),
        sourceId,
        nodeNum,
        pointCount: arr.length,
        startMs: arr[0].ts,
        endMs: arr[arr.length - 1].ts,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, tsCfg.enabled, tsCfg.windowStartMs, tsCfg.windowEndMs]);

  return (
    <>
      {trails.map((t) => (
        <Polyline
          key={t.key}
          positions={t.positions}
          pathOptions={{
            color: t.color,
            weight: 2,
            opacity: selectionOpacity(
              0.7,
              isNodeEmphasized(`mt:${t.nodeNum}`, config.selectedNodeIds),
            ),
          }}
          eventHandlers={{
            click: () =>
              setSelected({
                type: 'trail',
                sourceId: t.sourceId,
                nodeNum: t.nodeNum,
                pointCount: t.pointCount,
                startMs: t.startMs,
                endMs: t.endMs,
              }),
          }}
        />
      ))}
    </>
  );
}
