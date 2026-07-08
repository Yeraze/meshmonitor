import { useMapAnalysisCtx } from './MapAnalysisContext';

/**
 * Overlay affordance shown while Follow/Auto-zoom is active but paused by a
 * manual pan/zoom (issue #3788 P2 WP-D). Sibling of `<MapContainer>`, like
 * `MapLegend` — not rendered inside the map so it isn't affected by Leaflet's
 * pane stacking. Clicking it clears the pause, which re-runs FollowController's
 * apply effect and snaps back to the current follow/auto-zoom view.
 */
export default function FollowResumeButton() {
  const { config, followPaused, setFollowPaused } = useMapAnalysisCtx();
  const active = config.followMode || config.autoZoom;
  if (!active || !followPaused) return null;
  return (
    <button
      type="button"
      className="map-analysis-follow-resume"
      onClick={() => setFollowPaused(false)}
    >
      ⟳ Resume follow
    </button>
  );
}
