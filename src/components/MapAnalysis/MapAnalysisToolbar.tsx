import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDashboardSources } from '../../hooks/useDashboardData';
import LayerToggleButton from './LayerToggleButton';
import SourceMultiSelect from './SourceMultiSelect';
import NodeTypeFilterControl from './NodeTypeFilterControl';
import TransportFilterControl from './TransportFilterControl';
import NodeSearchControl from './NodeSearchControl';
import NodeMultiSelect from './NodeMultiSelect';
import TracerouteControls from './TracerouteControls';
import { useAnalysisNodes } from './useAnalysisNodes';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useOwnNodePositions } from '../../hooks/useOwnNodePositions';
import { LayerKey } from '../../hooks/useMapAnalysisConfig';
import {
  usePositions,
  useTraceroutes,
  useNeighbors,
  useAggregateProgress,
} from '../../hooks/useMapAnalysisData';

const LOOKBACK_OPTIONS: Array<number | null> = [1, 6, 24, 72, 168, 720];
const SNR_LOOKBACK_OPTIONS: Array<number | null> = [null, 1, 6, 24, 72, 168, 720];

const TIMED_LAYERS: { key: LayerKey; label: string; options: Array<number | null> }[] = [
  { key: 'traceroutes', label: 'Traceroutes', options: LOOKBACK_OPTIONS },
  { key: 'neighbors',   label: 'Neighbors',   options: LOOKBACK_OPTIONS },
  { key: 'heatmap',     label: 'Heatmap',     options: LOOKBACK_OPTIONS },
  { key: 'trails',      label: 'Trails',      options: LOOKBACK_OPTIONS },
  { key: 'snrOverlay',  label: 'SNR Overlay', options: SNR_LOOKBACK_OPTIONS },
];
const UNTIMED_LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'markers',     label: 'Markers' },
  { key: 'hopShading',  label: 'Hop Shading' },
  { key: 'waypoints',   label: 'Waypoints' },
  { key: 'accuracyRegions', label: 'Accuracy Regions' },
];

export default function MapAnalysisToolbar() {
  const navigate = useNavigate();
  const {
    config,
    setLayerEnabled,
    setLayerLookback,
    setSources,
    setSelectedNodeIds,
    setTimeSlider,
    setFollowMode,
    setAutoZoom,
    measureMode,
    setMeasureMode,
    reset,
  } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();

  // Node picker (issue #3788): deduped/sorted options built from the same
  // shared node hook the markers layer uses, so the picker never lists a node
  // the map itself wouldn't render.
  const analysisNodes = useAnalysisNodes();
  const nodeOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const { key, node } of analysisNodes) {
      if (!byKey.has(key)) byKey.set(key, node.longName || node.shortName || node.nodeId || key);
    }
    return [...byKey]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [analysisNodes]);

  // Polar grid (#3971): centered on each active source's own-node position.
  // Disable the toggle when no active source has a resolvable own node.
  const ownNodePositions = useOwnNodePositions(config.sources);
  const hasOwnNode = ownNodePositions.length > 0;

  const sourceIds = config.sources.length === 0
    ? sources.map((s: { id: string }) => s.id)
    : config.sources;

  // Trails / heatmap / SNR overlay all consume /api/analysis/positions. Drive
  // the toolbar's shared positions hook with the longest enabled lookback so
  // the global progress bar reflects whichever fetch will take longest. Layer
  // components fire their own usePositions calls with per-layer lookbacks;
  // identical-args calls share React Query cache. SNR overlay in "Last" mode
  // (lookbackHours === null) skips the positions API entirely — it reads from
  // the unified node table — so don't include it here.
  const snrUsesPositions =
    config.layers.snrOverlay.enabled && config.layers.snrOverlay.lookbackHours !== null;
  const positionsLookback = Math.max(
    config.layers.trails.enabled ? (config.layers.trails.lookbackHours ?? 24) : 0,
    config.layers.heatmap.enabled ? (config.layers.heatmap.lookbackHours ?? 24) : 0,
    snrUsesPositions ? (config.layers.snrOverlay.lookbackHours ?? 24) : 0,
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

  // Spinner shows on a button only when that specific layer is enabled and
  // its data fetch is in flight. Without the .enabled guard the shared
  // positions.isLoading would flash on heatmap/trails/SNR buttons even when
  // only one of them is the actual driver of the fetch (issue #2884 bug 3).
  const layerLoading: Partial<Record<LayerKey, boolean>> = {
    traceroutes: config.layers.traceroutes.enabled && traceroutes.isLoading,
    neighbors:   config.layers.neighbors.enabled   && neighbors.isLoading,
    trails:      config.layers.trails.enabled      && positions.isLoading,
    heatmap:     config.layers.heatmap.enabled     && positions.isLoading,
    snrOverlay:  config.layers.snrOverlay.enabled  && snrUsesPositions && positions.isLoading,
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
      <NodeTypeFilterControl />
      <TransportFilterControl />
      <NodeSearchControl />
      <NodeMultiSelect nodes={nodeOptions} value={config.selectedNodeIds} onChange={setSelectedNodeIds} />
      <button
        type="button"
        className={`map-analysis-layer-btn ${config.followMode ? 'active' : ''}`}
        onClick={() => setFollowMode(!config.followMode)}
        title="Recenter on the selected nodes as they move (keeps zoom)"
      >
        Follow
      </button>
      <button
        type="button"
        className={`map-analysis-layer-btn ${config.autoZoom ? 'active' : ''}`}
        onClick={() => setAutoZoom(!config.autoZoom)}
        title="Zoom to fit the selected nodes as they move"
      >
        Auto-zoom
      </button>
      <button
        type="button"
        className={`map-analysis-layer-btn ${config.timeSlider.enabled ? 'active' : ''}`}
        onClick={() => setTimeSlider({ enabled: !config.timeSlider.enabled })}
      >
        Time Slider
      </button>
      {/* #3636: node-to-node LOS distance measurement tool. Disabled until at
          least two positioned nodes exist, matching the "Features"-panel maps. */}
      <button
        type="button"
        className={`map-analysis-layer-btn ${measureMode ? 'active' : ''}`}
        onClick={() => setMeasureMode(!measureMode)}
        disabled={analysisNodes.length < 2}
        title={analysisNodes.length < 2
          ? 'Need at least two positioned nodes to measure'
          : 'Measure straight-line distance between two nodes'}
      >
        Measure
      </button>
      {UNTIMED_LAYERS.map(({ key, label }) => (
        <LayerToggleButton
          key={key}
          label={label}
          enabled={config.layers[key].enabled}
          onToggle={(next) => setLayerEnabled(key, next)}
        />
      ))}
      <LayerToggleButton
        label="Polar Grid"
        enabled={config.layers.polarGrid.enabled && hasOwnNode}
        onToggle={(next) => setLayerEnabled('polarGrid', next)}
        disabled={!hasOwnNode}
        title={hasOwnNode ? undefined : 'No source has a known own-node position'}
      />
      {TIMED_LAYERS.map(({ key, label, options }) => (
        <LayerToggleButton
          key={key}
          label={label}
          enabled={config.layers[key].enabled}
          onToggle={(next) => setLayerEnabled(key, next)}
          lookbackHours={config.layers[key].lookbackHours}
          lookbackOptions={options}
          onLookbackChange={(h) => setLayerLookback(key, h)}
          loading={layerLoading[key] ?? false}
        />
      ))}
      {config.layers.traceroutes.enabled && <TracerouteControls />}
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
