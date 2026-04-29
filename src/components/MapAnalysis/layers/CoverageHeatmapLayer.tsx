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
    const points: Array<[number, number, number]> =
      zoom < ZOOM_THRESHOLD
        ? (gridData?.cells ?? []).map((c) => [
            c.centerLat,
            c.centerLon,
            Math.min(1, c.count / 50),
          ])
        : (positions.items as PositionRecord[])
            .filter((p) => inWindow(p.timestamp))
            .map((p) => [p.latitude, p.longitude, 0.4]);
    if (points.length === 0) return;
    const heat = (L as unknown as {
      heatLayer: (
        pts: Array<[number, number, number]>,
        opts: { radius: number; blur: number; maxZoom: number },
      ) => L.Layer;
    }).heatLayer(points, { radius: 25, blur: 15, maxZoom: 17 });
    heat.addTo(map);
    return () => {
      map.removeLayer(heat);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, layer.enabled, zoom, grid.data, positions.items, ts.enabled, ts.windowStartMs, ts.windowEndMs]);

  return null;
}
