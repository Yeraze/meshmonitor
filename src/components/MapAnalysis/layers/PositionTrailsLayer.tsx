/**
 * PositionTrailsLayer — deliberately different visualization from the shared
 * single-node age-gradient position history in `src/utils/mapHelpers.tsx`
 * (`getPositionHistoryColor`/`generatePositionHistoryArrows`). This layer
 * draws *many* nodes' trails at once, each colored by a deterministic hash
 * of `(sourceId, nodeNum)` (see `colorForKey` in `utils/trailColor.ts`), with whole-trail
 * click-to-select — vs. the shared helpers' single selected node with a
 * per-segment age gradient, per-fix dot markers, and heading arrows. There
 * is no shared rendering to extract; this is NOT a fork. See
 * `docs/internal/dev-notes/MAP_CONSOLIDATION_P2_SPEC.md` (§1.4, epic #4047
 * Phase 2) for the full comparison.
 */
import { CircleMarker, Polyline } from 'react-leaflet';
import { useEffect, useMemo, useRef } from 'react';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { usePositions } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { isNodeEmphasized, selectionOpacity } from '../../../utils/nodeIdentity';
import { colorForKey } from '../../../utils/trailColor';
import type { PositionRow } from '../../../services/analysisApi';

const TRAIL_WEIGHT = 4;
const OUTLINE_WEIGHT = 7;
const OUTLINE_COLOR = 'rgba(0,0,0,0.4)';
const DOT_RADIUS = 4;
const DOT_FILL_OPACITY = 0.9;

type PositionRecord = PositionRow;

/** Canonical identity of a position row; MeshCore's synthetic nodeNum is never used. */
function rowNodeKey(p: PositionRecord): string {
  return p.nodeKey ?? `mt:${Number(p.nodeNum)}`;
}

export default function PositionTrailsLayer() {
  const { config, setSelected, setTrailBounds } = useMapAnalysisCtx();
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
    const grouped = new Map<
      string,
      { sourceId: string; nodeKey: string; nodeNum: number; pts: Array<{ ts: number; pos: [number, number] }> }
    >();
    const filtered = (items as PositionRecord[]).filter((p) => inWindow(p.timestamp));
    for (const p of filtered) {
      const nodeKey = rowNodeKey(p);
      const key = `${p.sourceId}|${nodeKey}`;
      let g = grouped.get(key);
      if (!g) {
        g = { sourceId: p.sourceId, nodeKey, nodeNum: Number(p.nodeNum), pts: [] };
        grouped.set(key, g);
      }
      g.pts.push({ ts: p.timestamp, pos: [p.latitude, p.longitude] });
    }
    const out: Array<{
      key: string;
      positions: [number, number][];
      color: string;
      sourceId: string;
      nodeKey: string;
      nodeNum: number;
      pointCount: number;
      startMs: number;
      endMs: number;
    }> = [];
    for (const [key, g] of grouped) {
      const arr = g.pts;
      arr.sort((a, b) => a.ts - b.ts);
      // A current-fix union can repeat a history row: drop consecutive points
      // with identical timestamp and coordinates.
      const uniq = arr.filter((pt, i) => {
        const prev = arr[i - 1];
        return !(prev && prev.ts === pt.ts && prev.pos[0] === pt.pos[0] && prev.pos[1] === pt.pos[1]);
      });
      if (uniq.length < 2) continue;
      out.push({
        key,
        positions: uniq.map((x) => x.pos),
        color: colorForKey(key),
        sourceId: g.sourceId,
        nodeKey: g.nodeKey,
        nodeNum: g.nodeNum,
        pointCount: uniq.length,
        startMs: uniq[0].ts,
        endMs: uniq[uniq.length - 1].ts,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, tsCfg.enabled, tsCfg.windowStartMs, tsCfg.windowEndMs]);

  const selectedSet = useMemo(() => new Set(config.selectedNodeIds), [config.selectedNodeIds]);

  const prevBoundsSig = useRef('');
  useEffect(() => {
    if (!layer.enabled || trails.length === 0 || selectedSet.size === 0) {
      if (prevBoundsSig.current !== '') {
        prevBoundsSig.current = '';
        setTrailBounds(null);
      }
      return;
    }
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    let found = false;
    for (const t of trails) {
      if (!isNodeEmphasized(t.nodeKey, config.selectedNodeIds)) continue;
      for (const [lat, lng] of t.positions) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        found = true;
      }
    }
    const sig = found ? `${minLat},${minLng},${maxLat},${maxLng}` : '';
    if (sig === prevBoundsSig.current) return;
    prevBoundsSig.current = sig;
    setTrailBounds(found ? [[minLat, minLng], [maxLat, maxLng]] : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trails, config.selectedNodeIds]);

  return (
    <>
      {trails.map((t) => {
        const opacity = selectionOpacity(
          0.7,
          isNodeEmphasized(t.nodeKey, config.selectedNodeIds),
        );
        return (
          <span key={t.key}>
            <Polyline
              positions={t.positions}
              pathOptions={{
                color: OUTLINE_COLOR,
                weight: OUTLINE_WEIGHT,
                opacity: opacity * 0.6,
                lineCap: 'round',
                lineJoin: 'round',
              }}
              interactive={false}
            />
            <Polyline
              positions={t.positions}
              pathOptions={{
                color: t.color,
                weight: TRAIL_WEIGHT,
                opacity,
                lineCap: 'round',
                lineJoin: 'round',
              }}
              eventHandlers={{
                click: () =>
                  setSelected({
                    type: 'trail',
                    sourceId: t.sourceId,
                    nodeNum: t.nodeNum,
                    nodeKey: t.nodeKey,
                    pointCount: t.pointCount,
                    startMs: t.startMs,
                    endMs: t.endMs,
                  }),
              }}
            />
            {t.positions.map(([lat, lng], i) => (
              <CircleMarker
                key={i}
                center={[lat, lng]}
                radius={DOT_RADIUS}
                pathOptions={{
                  color: OUTLINE_COLOR,
                  weight: 1,
                  fillColor: t.color,
                  fillOpacity: DOT_FILL_OPACITY * opacity,
                  opacity: opacity * 0.6,
                }}
                interactive={false}
              />
            ))}
          </span>
        );
      })}
    </>
  );
}
