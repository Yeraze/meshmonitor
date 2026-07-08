import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMap } from 'react-leaflet';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useAnalysisNodes } from './useAnalysisNodes';
import { averageLatLng, planAutoZoom, type LatLng } from './followMath';

/**
 * `useMap()` view controller for Follow/Auto-zoom (issue #3788 P2 WP-C).
 * Renders nothing; recenters/fits the map onto the selected nodes' current
 * positions on each live update, and pauses on manual pan/zoom until the
 * user hits Resume (WP-D) or retargets the selection.
 */
export default function FollowController() {
  const map = useMap();
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
    fn(); // animate:false ⇒ moveend fires synchronously and consumes the flag below
    // Safety net: if the move was a no-op (setView to the current center/zoom fires
    // NO moveend in Leaflet), clear the stuck flag before any user interaction can
    // occur (a frame is far shorter than any human gesture).
    const raf =
      typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 0);
    raf(() => {
      programmaticRef.current = false;
    });
  }, []);

  useEffect(() => {
    const onMoveEnd = () => {
      if (programmaticRef.current) {
        programmaticRef.current = false; // our move — consume
        return;
      }
      setFollowPaused(true); // genuine user pan/zoom ⇒ pause
    };
    map.on('moveend', onMoveEnd);
    return () => {
      map.off('moveend', onMoveEnd);
    };
  }, [map, setFollowPaused]);

  useEffect(() => {
    if (followPaused) return;
    if (!config.followMode && !config.autoZoom) return;

    if (config.autoZoom) {
      const plan = planAutoZoom(points); // Auto-zoom governs when both on
      if (plan.kind === 'none') return;
      if (plan.kind === 'single') {
        applyView(() => map.setView(plan.center, map.getZoom(), { animate: false }));
        return;
      }
      applyView(() => map.fitBounds(plan.bounds, { animate: false }));
      return;
    }

    // Follow only
    const center = averageLatLng(points);
    if (!center) return;
    const cur = map.getCenter();
    const EPS = 1e-6; // ~0.1 m; skip redundant setView (avoids churn + Leaflet no-op-move quirk)
    if (Math.abs(cur.lat - center[0]) < EPS && Math.abs(cur.lng - center[1]) < EPS) return;
    applyView(() => map.setView(center, map.getZoom(), { animate: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #3788 keyed on sig to fire only on coordinate change
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
