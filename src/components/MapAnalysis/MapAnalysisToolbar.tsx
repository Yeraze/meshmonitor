import { useNavigate } from 'react-router-dom';
import { useDashboardSources } from '../../hooks/useDashboardData';
import LayerToggleButton from './LayerToggleButton';
import SourceMultiSelect from './SourceMultiSelect';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { LayerKey } from '../../hooks/useMapAnalysisConfig';
import {
  usePositions,
  useTraceroutes,
  useNeighbors,
  useAggregateProgress,
} from '../../hooks/useMapAnalysisData';

const LOOKBACK_OPTIONS = [1, 6, 24, 72, 168, 720];

const TIMED_LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'traceroutes', label: 'Traceroutes' },
  { key: 'neighbors',   label: 'Neighbors' },
  { key: 'heatmap',     label: 'Heatmap' },
  { key: 'trails',      label: 'Trails' },
  { key: 'snrOverlay',  label: 'SNR Overlay' },
];
const UNTIMED_LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'markers',     label: 'Markers' },
  { key: 'hopShading',  label: 'Hop Shading' },
];

export default function MapAnalysisToolbar() {
  const navigate = useNavigate();
  const { config, setLayerEnabled, setLayerLookback, setSources, setTimeSlider, reset } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();

  const sourceIds = config.sources.length === 0
    ? sources.map((s: { id: string }) => s.id)
    : config.sources;

  // Trails / heatmap / SNR overlay all consume /api/analysis/positions. Drive
  // the toolbar's shared positions hook with the longest enabled lookback so
  // the global progress bar reflects whichever fetch will take longest. Layer
  // components fire their own usePositions calls with per-layer lookbacks;
  // identical-args calls share React Query cache.
  const positionsLookback = Math.max(
    config.layers.trails.enabled ? (config.layers.trails.lookbackHours ?? 24) : 0,
    config.layers.heatmap.enabled ? (config.layers.heatmap.lookbackHours ?? 24) : 0,
    config.layers.snrOverlay.enabled ? (config.layers.snrOverlay.lookbackHours ?? 24) : 0,
  );

  const positions = usePositions({
    enabled: positionsLookback > 0 && sourceIds.length > 0,
    sources: sourceIds,
    lookbackHours: positionsLookback || 24,
  });
  const traceroutes = useTraceroutes({
    enabled: config.layers.traceroutes.enabled && sourceIds.length > 0,
    sources: sourceIds,
    lookbackHours: config.layers.traceroutes.lookbackHours ?? 24,
  });
  const neighbors = useNeighbors({
    enabled: config.layers.neighbors.enabled && sourceIds.length > 0,
    sources: sourceIds,
    lookbackHours: config.layers.neighbors.lookbackHours ?? 24,
  });

  const aggregate = useAggregateProgress([
    positions,
    traceroutes,
    { isLoading: neighbors.isLoading },
  ]);

  const layerLoading: Partial<Record<LayerKey, boolean>> = {
    traceroutes: traceroutes.isLoading,
    neighbors: neighbors.isLoading,
    trails: positions.isLoading,
    heatmap: positions.isLoading,
    snrOverlay: positions.isLoading,
  };

  return (
    <div className="map-analysis-toolbar-row">
      <button
        type="button"
        className="map-analysis-back"
        onClick={() => navigate('/')}
        title="Back to Sources"
      >
        ← Sources
      </button>
      <SourceMultiSelect
        sources={sources.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name }))}
        value={config.sources}
        onChange={setSources}
      />
      <button
        type="button"
        className={`map-analysis-layer-btn ${config.timeSlider.enabled ? 'active' : ''}`}
        onClick={() => setTimeSlider({ enabled: !config.timeSlider.enabled })}
      >
        Time Slider
      </button>
      {UNTIMED_LAYERS.map(({ key, label }) => (
        <LayerToggleButton
          key={key}
          label={label}
          enabled={config.layers[key].enabled}
          onToggle={(next) => setLayerEnabled(key, next)}
        />
      ))}
      {TIMED_LAYERS.map(({ key, label }) => (
        <LayerToggleButton
          key={key}
          label={label}
          enabled={config.layers[key].enabled}
          onToggle={(next) => setLayerEnabled(key, next)}
          lookbackHours={config.layers[key].lookbackHours}
          lookbackOptions={LOOKBACK_OPTIONS}
          onLookbackChange={(h) => setLayerLookback(key, h)}
          loading={layerLoading[key] ?? false}
        />
      ))}
      {aggregate !== null && (
        <div
          className="map-analysis-progress"
          role="progressbar"
          aria-valuenow={aggregate}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div style={{ width: `${aggregate}%` }} />
        </div>
      )}
      <button
        type="button"
        className="map-analysis-reset"
        onClick={reset}
        style={{ marginLeft: 'auto' }}
      >
        Reset
      </button>
    </div>
  );
}
