import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.heat';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { useCoverageGrid, usePositions } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

const ZOOM_THRESHOLD = 13;

interface GridCell {
  centerLat: number;
  centerLon: number;
  count: number;
}

interface PositionRecord {
  sourceId: string;
  nodeNum: number;
  latitude: number;
  longitude: number;
  timestamp: number;
}

/**
 * Heatmap of position density. At low zoom (< 13), uses the server-side
 * coverage grid (cells with counts). At high zoom (>= 13), falls back to raw
 * paginated positions for finer detail.
 */
export default function CoverageHeatmapLayer() {
  const map = useMap();
  const { config } = useMapAnalysisCtx();
  const layer = config.layers.heatmap;
  const { data: sources = [] } = useDashboardSources();
  const sourceIds =
    config.sources.length === 0
      ? (sources as { id: string }[]).map((s) => s.id)
      : config.sources;
  const zoom = (map as { getZoom?: () => number }).getZoom?.() ?? 12;

  const grid = useCoverageGrid({
    enabled: layer.enabled && zoom < ZOOM_THRESHOLD,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
    zoom,
  });
  const positions = usePositions({
    enabled: layer.enabled && zoom >= ZOOM_THRESHOLD,
    sources: sourceIds,
    lookbackHours: layer.lookbackHours ?? 24,
  });

  const ts = config.timeSlider;
  const inWindow = (t: number): boolean =>
    !ts.enabled ||
    ts.windowStartMs === undefined ||
    ts.windowEndMs === undefined ||
    (t >= ts.windowStartMs && t <= ts.windowEndMs);

  useEffect(() => {
    if (!layer.enabled) return;
    const gridData = grid.data as { cells?: GridCell[] } | undefined;
    // Note: at low zoom (< 13) the heatmap uses the server-binned coverage
    // grid which has no per-fix timestamps; the time-slider has no effect on
    // the cell counts. At high zoom (>= 13) the layer uses raw positions and
    // the slider filters them client-side.
    let points: Array<[number, number, number]>;
    if (zoom < ZOOM_THRESHOLD) {
      const cells = gridData?.cells ?? [];
      // Normalize against the max cell count so the busiest cell always
      // hits 1.0 (red on the default gradient). A fixed divisor (e.g. /50)
      // means tiny meshes never produce visible heat, and busy meshes
      // saturate everywhere.
      const maxCount = cells.reduce((m, c) => Math.max(m, c.count), 0);
      const denom = Math.max(1, maxCount);
      points = cells.map((c) => [c.centerLat, c.centerLon, c.count / denom]);
    } else {
      // High-zoom equivalent of "unique nodes per cell": dedupe by (sourceId,
      // nodeNum) at ~11m precision (4 decimal places). A stationary node that
      // reports 200 times from the same spot contributes 1 dot, not 200.
      const seen = new Set<string>();
      const dedupedPoints: Array<[number, number, number]> = [];
      for (const p of positions.items as PositionRecord[]) {
        if (!inWindow(p.timestamp)) continue;
        const lat4 = Math.round(p.latitude * 1e4) / 1e4;
        const lon4 = Math.round(p.longitude * 1e4) / 1e4;
        const key = `${p.sourceId}:${p.nodeNum}:${lat4}:${lon4}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedPoints.push([p.latitude, p.longitude, 1.0]);
      }
      points = dedupedPoints;
    }
    if (points.length === 0) return;

    // Custom gradient: more saturated at the low end so isolated fixes are
    // still readable instead of nearly transparent. Default leaflet.heat
    // gradient has a long faint blue ramp that disappears against dark tiles.
    const gradient = {
      0.2: '#3b82f6', // blue
      0.4: '#22d3ee', // cyan
      0.6: '#84cc16', // lime
      0.8: '#fbbf24', // amber
      1.0: '#ef4444', // red
    };

    const heat = (L as unknown as {
      heatLayer: (
        pts: Array<[number, number, number]>,
        opts: {
          radius: number;
          blur: number;
          maxZoom: number;
          minOpacity?: number;
          gradient?: Record<number, string>;
        },
      ) => L.Layer;
    }).heatLayer(points, {
      radius: 35,
      blur: 25,
      maxZoom: 17,
      minOpacity: 0.4,
      gradient,
    });
    heat.addTo(map);
    return () => {
      map.removeLayer(heat);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, layer.enabled, zoom, grid.data, positions.items, ts.enabled, ts.windowStartMs, ts.windowEndMs]);

  return null;
}
