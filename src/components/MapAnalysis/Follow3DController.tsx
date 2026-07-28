import { useCallback, useEffect, useMemo, useRef } from 'react';
import type maplibregl from 'maplibre-gl';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useAnalysisNodes } from './useAnalysisNodes';
import { averageLatLng, planAutoZoom, type LatLng } from './followMath';

/**
 * Follow/Auto-zoom for the 3D (MapLibre) map (#4371 B).
 *
 * The 3D counterpart of `FollowController`: same context state, same
 * `followMath` plan, same pause-on-manual-move behavior — only the camera
 * calls differ (`jumpTo`/`fitBounds` on a `maplibregl.Map` instead of
 * `setView`/`fitBounds` on a Leaflet one). MapLibre has no `useMap()` child
 * context, so the map arrives as a prop from `Base3DMap`'s `onMapReady` and is
 * `null` until the map's `load` fires.
 *
 * Kept as a sibling of `FollowController` rather than a shared abstraction:
 * the two APIs agree on nothing but the concept, and the 2D file is the
 * behavior of record (its test suite pins the exact `setView` arguments).
 */
export default function Follow3DController({ map }: { map: maplibregl.Map | null }) {
  const { config, followPaused, setFollowPaused } = useMapAnalysisCtx();
  const analysisNodes = useAnalysisNodes();

  const points = useMemo<LatLng[]>(() => {
    const sel = new Set(config.selectedNodeIds);
    return analysisNodes.filter((n) => sel.has(n.key)).map((n) => n.latLng);
  }, [analysisNodes, config.selectedNodeIds]);

  // Position signature — the apply effect keys on THIS, so it fires only when a
  // coordinate actually changes, not on every render/poll that returns identical data.
  const sig = useMemo(() => points.map((p) => `${p[0]},${p[1]}`).join('|'), [points]);
  // Selection-membership signature — position-independent, used to reset pause.
  const selKey = config.selectedNodeIds.join('|');

  const programmaticRef = useRef(false);

  const applyView = useCallback((fn: () => void) => {
    programmaticRef.current = true;
    fn(); // jumpTo/animate:false ⇒ moveend fires synchronously and consumes the flag below
    // Safety net for a move MapLibre treats as a no-op (no moveend fired):
    // clear the stuck flag before any user gesture can occur.
    const raf =
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 0);
    raf(() => {
      programmaticRef.current = false;
    });
  }, []);

  useEffect(() => {
    if (!map) return;
    const onMoveEnd = () => {
      if (programmaticRef.current) {
        programmaticRef.current = false; // our move — consume
        return;
      }
      setFollowPaused(true); // genuine user pan/zoom/rotate ⇒ pause
    };
    map.on('moveend', onMoveEnd);
    return () => {
      map.off('moveend', onMoveEnd);
    };
  }, [map, setFollowPaused]);

  useEffect(() => {
    if (!map) return;
    if (followPaused) return;
    if (!config.followMode && !config.autoZoom) return;

    if (config.autoZoom) {
      const plan = planAutoZoom(points); // Auto-zoom governs when both on
      if (plan.kind === 'none') return;
      if (plan.kind === 'single') {
        applyView(() => map.jumpTo({ center: [plan.center[1], plan.center[0]] }));
        return;
      }
      // Deliberately NOT `map.fitBounds(...)`: it routes through `flyTo`, which
      // ignores `animate:false` and animates anyway (only prefers-reduced-motion
      // makes it jump), and its `cameraForBounds` call defaults bearing to 0 —
      // so a rotated 3D camera would be yanked north-up on every follow update.
      // Resolving the camera ourselves and `jumpTo`-ing it keeps the bearing,
      // keeps the pitch (jumpTo only changes what's in `options`), and fires
      // moveend synchronously the way the 2D controller's animate:false does.
      // planAutoZoom yields [[S,W],[N,E]]; MapLibre wants [[W,S],[E,N]].
      const [[south, west], [north, east]] = plan.bounds;
      const camera = map.cameraForBounds([[west, south], [east, north]], {
        bearing: map.getBearing(),
      });
      if (!camera) return; // MapLibre warns + returns undefined when it can't fit
      applyView(() => map.jumpTo(camera));
      return;
    }

    // Follow only — recenter, keep zoom/pitch/bearing.
    const center = averageLatLng(points);
    if (!center) return;
    const cur = map.getCenter();
    const EPS = 1e-6; // ~0.1 m; skip redundant jumpTo (avoids churn)
    if (Math.abs(cur.lat - center[0]) < EPS && Math.abs(cur.lng - center[1]) < EPS) return;
    applyView(() => map.jumpTo({ center: [center[1], center[0]] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #4371 keyed on sig to fire only on coordinate change (mirrors FollowController)
  }, [sig, followPaused, config.followMode, config.autoZoom, map]);

  // Selection SET changed (not positions) ⇒ user retargeted ⇒ re-engage.
  useEffect(() => {
    setFollowPaused(false);
  }, [selKey, setFollowPaused]);
  // Toggling either mode ⇒ re-engage (turning on follows immediately; turning off is harmless).
  useEffect(() => {
    setFollowPaused(false);
  }, [config.followMode, config.autoZoom, setFollowPaused]);

  return null;
}
