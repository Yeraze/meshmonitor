/**
 * GNSS DOP overlay (#4729).
 *
 * A child of `MapContainer`. Draws a translucent GDOP heatmap over the current
 * viewport: each cell is colored by how good the satellite geometry is there
 * (green ≈ good, red ≈ poor). Unlike the RF Site Planner this is NOT a
 * terrain product — GDOP depends on where and *when* you are, so the overlay
 * refetches as the map moves and as the panel's time control changes, and does
 * NOT change with elevation.
 *
 * The fetch is server-side compute over cached TLEs (see `getDopGrid`); it
 * sends no mesh traffic. It is debounced so a pan/zoom drag issues one request
 * at rest rather than a stream of them.
 */
import { useEffect, useRef, useState } from 'react';
import { Rectangle, useMap, useMapEvents } from 'react-leaflet';
import apiService, { type DopGridResult } from '../../../services/api';
import {
  computeDopStepDeg,
  dopCellBounds,
  dopCellKey,
  gdopToColor,
  type GnssDopMeta,
  type GnssDopUiParams,
} from './gnssDopGeometry';

export interface GnssDopLayerProps {
  visible: boolean;
  params: GnssDopUiParams;
  /** Reports fetch state + clamp result up so the panel can show the notice. */
  onMeta?: (meta: GnssDopMeta) => void;
  /** Debounce for map-move/param-change refetch (ms). Overridable for tests. */
  debounceMs?: number;
  /** Cell fill opacity — low so basemap + node markers stay legible. */
  fillOpacity?: number;
}

function clampLat(v: number): number {
  return Math.max(-90, Math.min(90, v));
}
function clampLon(v: number): number {
  return Math.max(-180, Math.min(180, v));
}

export default function GnssDopLayer({
  visible,
  params,
  onMeta,
  debounceMs = 400,
  fillOpacity = 0.4,
}: GnssDopLayerProps) {
  const map = useMap();
  const [result, setResult] = useState<DopGridResult | null>(null);

  // Bump on move so the fetch effect re-runs; the actual bounds are read fresh
  // from `map` at fetch time rather than stored, so a rapid pan doesn't queue
  // stale viewports.
  const [moveNonce, setMoveNonce] = useState(0);
  useMapEvents({
    moveend: () => setMoveNonce((n) => n + 1),
    zoomend: () => setMoveNonce((n) => n + 1),
  });

  // Latest onMeta without re-arming the fetch effect when the parent passes a
  // fresh callback identity each render.
  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;

  const reqIdRef = useRef(0);
  const constKey = params.constellations.join(',');

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const b = map.getBounds();
      const minLat = clampLat(b.getSouth());
      const maxLat = clampLat(b.getNorth());
      const minLon = clampLon(b.getWest());
      const maxLon = clampLon(b.getEast());
      if (minLat >= maxLat || minLon >= maxLon) return; // degenerate viewport
      const stepDeg = computeDopStepDeg(maxLat - minLat, maxLon - minLon);
      const reqId = ++reqIdRef.current;
      onMetaRef.current?.({
        clamped: false,
        stepDeg,
        requestedStepDeg: stepDeg,
        // 0 while loading — the previous fetch's cellCount would be misleading here.
        cellCount: 0,
        loading: true,
        error: null,
      });
      void (async () => {
        try {
          const res = await apiService.getDopGrid({
            bbox: { minLat, minLon, maxLat, maxLon },
            stepDeg,
            timeMs: params.timeMs,
            elevationMaskDeg: params.maskDeg,
            constellations: params.constellations,
          });
          if (cancelled || reqId !== reqIdRef.current) return;
          setResult(res);
          onMetaRef.current?.({
            clamped: res.clamped,
            stepDeg: res.stepDeg,
            requestedStepDeg: res.requestedStepDeg,
            cellCount: res.cellCount,
            loading: false,
            error: null,
          });
        } catch (e) {
          if (cancelled || reqId !== reqIdRef.current) return;
          const message = e instanceof Error ? e.message : 'Failed to load DOP grid.';
          onMetaRef.current?.({
            clamped: false,
            stepDeg,
            requestedStepDeg: stepDeg,
            cellCount: 0,
            loading: false,
            error: message,
          });
        }
      })();
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `result?.cellCount` intentionally excluded — it would refetch on every
    // response. bounds are read fresh via `moveNonce`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, params.timeMs, params.maskDeg, constKey, moveNonce, debounceMs, map]);

  if (!visible || !result || result.points.length === 0) return null;

  return (
    <>
      {result.points.map((p) => (
        <Rectangle
          key={dopCellKey(p)}
          bounds={dopCellBounds(p.lat, p.lon, result.stepDeg)}
          pathOptions={{
            stroke: false,
            fill: true,
            fillColor: gdopToColor(p.gdop),
            fillOpacity: p.gdop == null ? fillOpacity * 0.5 : fillOpacity,
          }}
          className="gnss-dop-cell"
        />
      ))}
    </>
  );
}
