import { useState } from 'react';
import { useMapAnalysisCtx } from './MapAnalysisContext';

interface SwatchProps {
  color: string;
  /** Optional opacity 0-1 */
  alpha?: number;
}

function Swatch({ color, alpha = 1 }: SwatchProps) {
  return (
    <span
      className="map-analysis-legend-swatch"
      style={{ background: color, opacity: alpha }}
    />
  );
}

function GradientBar({ stops }: { stops: string[] }) {
  return (
    <span
      className="map-analysis-legend-bar"
      style={{ background: `linear-gradient(to right, ${stops.join(', ')})` }}
    />
  );
}

/**
 * Floating bottom-left legend that explains the color encoding for whichever
 * layers are currently enabled. Hidden when no enabled layer needs a legend.
 */
export default function MapLegend() {
  const { config } = useMapAnalysisCtx();
  const [collapsed, setCollapsed] = useState(false);

  const showTraceroutes = config.layers.traceroutes.enabled;
  const showNeighbors = config.layers.neighbors.enabled;
  const showHopShading = config.layers.hopShading.enabled;
  const showHeatmap = config.layers.heatmap.enabled;
  const showSnr = config.layers.snrOverlay.enabled;
  const showTrails = config.layers.trails.enabled;
  const showMarkers = config.layers.markers.enabled && !showHopShading;

  const anyShown =
    showTraceroutes || showNeighbors || showHopShading || showHeatmap ||
    showSnr || showTrails || showMarkers;

  if (!anyShown) return null;

  return (
    <div className={`map-analysis-legend ${collapsed ? 'collapsed' : ''}`}>
      <div className="map-analysis-legend-header">
        <span>Legend</span>
        <button
          type="button"
          aria-label={collapsed ? 'Expand legend' : 'Collapse legend'}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div className="map-analysis-legend-body">
          {showMarkers && (
            <section>
              <h4>Markers</h4>
              <div className="row"><Swatch color="#6698f5" /> Node</div>
            </section>
          )}
          {showHopShading && (
            <section>
              <h4>Hop Shading</h4>
              <div className="row"><Swatch color="#22c55e" /> 0 hops (local)</div>
              <div className="row"><Swatch color="#84cc16" /> 1 hop</div>
              <div className="row"><Swatch color="#eab308" /> 2 hops</div>
              <div className="row"><Swatch color="#f97316" /> 3 hops</div>
              <div className="row"><Swatch color="#ef4444" /> 4+ hops</div>
              <div className="row"><Swatch color="#6b7280" /> Unknown</div>
            </section>
          )}
          {(showTraceroutes || showSnr) && (
            <section>
              <h4>SNR (dB)</h4>
              <div className="row"><Swatch color="#22c55e" /> ≥ 5 (excellent)</div>
              <div className="row"><Swatch color="#eab308" /> 0 to 5 (good)</div>
              <div className="row"><Swatch color="#f97316" /> -5 to 0 (fair)</div>
              <div className="row"><Swatch color="#ef4444" /> &lt; -5 (poor)</div>
              {showSnr && (
                <div className="row"><Swatch color="#888" /> Unknown</div>
              )}
            </section>
          )}
          {showNeighbors && (
            <section>
              <h4>Neighbor Links</h4>
              <div className="row"><Swatch color="#06b6d4" alpha={0.4} /> Low SNR (faint)</div>
              <div className="row"><Swatch color="#06b6d4" alpha={1} /> High SNR (solid)</div>
              <div className="row caption">Dashed cyan; opacity scales with SNR</div>
            </section>
          )}
          {showHeatmap && (
            <section>
              <h4>Coverage Heatmap</h4>
              <div className="row">
                <GradientBar stops={['#3b82f6', '#22d3ee', '#84cc16', '#fbbf24', '#ef4444']} />
              </div>
              <div className="row caption">Density of position fixes (low → high)</div>
            </section>
          )}
          {showTrails && (
            <section>
              <h4>Position Trails</h4>
              <div className="row caption">Each node gets a unique color</div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
