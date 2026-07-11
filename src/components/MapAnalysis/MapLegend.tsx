/**
 * Map Analysis legend — a floating, layer-driven key whose sections are
 * gated by which analysis layers are currently enabled (Markers/Hop
 * Shading/SNR/Neighbors/Coverage Heatmap/Trails/Node Types).
 *
 * This is intentionally distinct from the shared static legend
 * (`src/components/MapLegend.tsx`), which is a fixed, prop-driven,
 * localStorage-persisted overlay used by NodesTab/MeshCoreMap/DashboardMap.
 * The two are ~90% disjoint in content and chrome — this is NOT a fork of
 * the shared legend. See `docs/internal/dev-notes/MAP_CONSOLIDATION_P2_SPEC.md`
 * (§0/§1.6) for the full drift-vs-functional analysis (epic #4047 Phase 2).
 * The one genuine drift — the Node-Types glyph — was deduped onto the
 * shared `roleGlyphMarkerSvg` helper below; everything else here stays.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useVisibleNodeTypeCategories } from './useVisibleNodeTypeCategories';
import { roleGlyphMarkerSvg } from '../../utils/mapIcons';
import {
  categoryGlyphFamily,
  NODE_TYPE_CATEGORY_META,
} from '../../utils/nodeTypeCategory';
import { useSettings } from '../../contexts/SettingsContext';

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
  const { t } = useTranslation();
  const { overlayColors } = useSettings();
  const [collapsed, setCollapsed] = useState(false);
  const visibleCategories = useVisibleNodeTypeCategories();
  // Only categories with a distinct glyph deserve a legend row; client/standard
  // buckets render as the default pin and would be a meaningless swatch.
  const legendCategories = visibleCategories.filter(
    (c) => categoryGlyphFamily(c) !== 'standard',
  );

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
          {showMarkers && legendCategories.length > 0 && (
            <section>
              <h4>{t('map.nodeType.legendTitle', 'Node Types')}</h4>
              {legendCategories.map((c) => (
                <div className="row" key={c}>
                  <span
                    className="map-analysis-legend-swatch"
                    style={{ background: 'transparent', width: 20, height: 20, display: 'inline-block' }}
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: roleGlyphMarkerSvg(c, '#6698f5', 20) }}
                  />{' '}
                  {t(NODE_TYPE_CATEGORY_META[c].labelKey, NODE_TYPE_CATEGORY_META[c].label)}
                </div>
              ))}
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
              <div className="row"><Swatch color={overlayColors.snrColors.excellent} /> ≥ 5 (excellent)</div>
              <div className="row"><Swatch color={overlayColors.snrColors.good} /> 0 to 5 (good)</div>
              <div className="row"><Swatch color={overlayColors.snrColors.fair} /> -5 to 0 (fair)</div>
              <div className="row"><Swatch color={overlayColors.snrColors.poor} /> &lt; -5 (poor)</div>
              {showSnr && (
                <div className="row"><Swatch color={overlayColors.snrColors.noData} /> Unknown</div>
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
