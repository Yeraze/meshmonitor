import { useDashboardSources } from '../../hooks/useDashboardData';
import LayerToggleButton from './LayerToggleButton';
import SourceMultiSelect from './SourceMultiSelect';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { LayerKey } from '../../hooks/useMapAnalysisConfig';

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
  { key: 'rangeRings',  label: 'Range Rings' },
  { key: 'hopShading',  label: 'Hop Shading' },
];

export default function MapAnalysisToolbar() {
  const { config, setLayerEnabled, setLayerLookback, setSources, setTimeSlider, reset } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();

  return (
    <div className="map-analysis-toolbar-row">
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
        />
      ))}
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
