import { useCallback, useEffect, useMemo, useRef } from 'react';
import type * as maplibregl from 'maplibre-gl';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useAnalysisNodes } from './useAnalysisNodes';
import { averageLatLng, planAutoZoom, type LatLng } from './followMath';

export default function Follow3DController({ map }: { map: maplibregl.Map | null }) {
  const { config, followPaused, setFollowPaused, trailBounds } = useMapAnalysisCtx();
  const analysisNodes = useAnalysisNodes();

  const points = useMemo<LatLng[]>(() => {
    const sel = new Set(config.selectedNodeIds);
    const pts: LatLng[] = analysisNodes.filter((n) => sel.has(n.key)).map((n) => n.latLng);
    if (config.autoZoom && config.layers.trails.enabled && trailBounds) {
      pts.push(trailBounds[0], trailBounds[1]);
    }
    return pts;
  }, [analysisNodes, config.selectedNodeIds, config.autoZoom, config.layers.trails.enabled, trailBounds]);

  const sig = useMemo(() => points.map((p) => `${p[0]},${p[1]}`).join('|'), [points]);
  const selKey = config.selectedNodeIds.join('|');

  const programmaticRef = useRef(false);

  const applyView = useCallback((fn: () => void) => {
    programmaticRef.current = true;
    fn();
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
        programmaticRef.current = false;
        return;
      }
      setFollowPaused(true);
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
      const plan = planAutoZoom(points);
      if (plan.kind === 'none') return;
      if (plan.kind === 'single') {
        applyView(() => map.jumpTo({ center: [plan.center[1], plan.center[0]] }));
        return;
      }
      const [[south, west], [north, east]] = plan.bounds;
      const camera = map.cameraForBounds([[west, south], [east, north]], {
        bearing: map.getBearing(),
      });
      if (!camera) return;
      applyView(() => map.jumpTo(camera));
      return;
    }

    const nodePoints: LatLng[] = (() => {
      const sel = new Set(config.selectedNodeIds);
      return analysisNodes.filter((n) => sel.has(n.key)).map((n) => n.latLng);
    })();
    const center = averageLatLng(nodePoints);
    if (!center) return;
    const cur = map.getCenter();
    const EPS = 1e-6;
    if (Math.abs(cur.lat - center[0]) < EPS && Math.abs(cur.lng - center[1]) < EPS) return;
    applyView(() => map.jumpTo({ center: [center[1], center[0]] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on sig to fire only on coordinate change
  }, [sig, followPaused, config.followMode, config.autoZoom, map]);

  useEffect(() => {
    setFollowPaused(false);
  }, [selKey, setFollowPaused]);
  useEffect(() => {
    setFollowPaused(false);
  }, [config.followMode, config.autoZoom, setFollowPaused]);

  return null;
}
