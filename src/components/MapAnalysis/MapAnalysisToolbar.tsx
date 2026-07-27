import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, LocateFixed, Maximize, Clock, Ruler, Mountain, RotateCcw,
  MapPin, Palette, Flag, CircleDashed, Radar, Route, Share2, Flame, Spline, Signal, Box, Users,
} from 'lucide-react';
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
import { useElevationEnabled } from '../../hooks/useElevationEnabled';
import { useTerrainCapabilities } from '../../hooks/useTerrainCapabilities';
import { LayerKey } from '../../hooks/useMapAnalysisConfig';
import {
  usePositions,
  useTraceroutes,
  useNeighbors,
  useAggregateProgress,
} from '../../hooks/useMapAnalysisData';

const LOOKBACK_OPTIONS: Array<number | null> = [1, 6, 24, 72, 168, 720];
const SNR_LOOKBACK_OPTIONS: Array<number | null> = [null, 1, 6, 24, 72, 168, 720];

const ICON = 16;
const TIMED_LAYERS: { key: LayerKey; label: string; options: Array<number | null>; icon: ReactNode }[] = [
  { key: 'traceroutes', label: 'Traceroutes', options: LOOKBACK_OPTIONS,     icon: <Route size={ICON} /> },
  { key: 'neighbors',   label: 'Neighbors',   options: LOOKBACK_OPTIONS,     icon: <Share2 size={ICON} /> },
  { key: 'heatmap',     label: 'Heatmap',     options: LOOKBACK_OPTIONS,     icon: <Flame size={ICON} /> },
  { key: 'trails',      label: 'Trails',      options: LOOKBACK_OPTIONS,     icon: <Spline size={ICON} /> },
  { key: 'snrOverlay',  label: 'SNR Overlay', options: SNR_LOOKBACK_OPTIONS, icon: <Signal size={ICON} /> },
];
const UNTIMED_LAYERS: { key: LayerKey; label: string; icon: ReactNode }[] = [
  { key: 'markers',     label: 'Markers',          icon: <MapPin size={ICON} /> },
  { key: 'hopShading',  label: 'Hop Shading',      icon: <Palette size={ICON} /> },
  { key: 'waypoints',   label: 'Waypoints',        icon: <Flag size={ICON} /> },
  { key: 'accuracyRegions', label: 'Accuracy Regions', icon: <CircleDashed size={ICON} /> },
  { key: 'atakContacts', label: 'ATAK Contacts',    icon: <Users size={ICON} /> },
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
    setViewMode,
    measureMode,
    setMeasureMode,
    linkProfileMode,
    setLinkProfileMode,
    reset,
  } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();
  const elevationEnabled = useElevationEnabled();
  // #3826 Phase 2 WP-D: 2D/3D toggle gating. `useTerrainCapabilities` (not
  // `useElevationEnabled`) because the toggle must also distinguish a
  // configured JSON elevation source (no DEM tiles available) from the
  // simple enabled/disabled flag the Link Profile button above uses.
  const terrainCaps = useTerrainCapabilities();
  const threeDUnavailableReason = terrainCaps.isLoading
    ? null
    : !terrainCaps.enabled
      ? 'Elevation is disabled'
      : !terrainCaps.terrainTiles
        ? '3D terrain is unavailable with the configured elevation source'
        : null;
  const threeDDisabled = terrainCaps.isLoading || threeDUnavailableReason !== null;
  const threeDTitle = threeDUnavailableReason
    ?? (terrainCaps.isLoading
      ? 'Checking 3D availability…'
      : config.viewMode === '3d' ? 'Switch to 2D map' : 'Switch to 3D map (pitched terrain)');

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
        className="map-analysis-back icon-only"
        onClick={() => navigate('/')}
        title="Back to Sources"
        aria-label="Back to Sources"
      >
        <ArrowLeft size={ICON} />
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
        className={`map-analysis-layer-btn icon-only ${config.followMode ? 'active' : ''}`}
        onClick={() => setFollowMode(!config.followMode)}
        title="Follow — recenter on the selected nodes as they move (keeps zoom)"
        aria-label="Follow"
      >
        <LocateFixed size={ICON} />
      </button>
      <button
        type="button"
        className={`map-analysis-layer-btn icon-only ${config.autoZoom ? 'active' : ''}`}
        onClick={() => setAutoZoom(!config.autoZoom)}
        title="Auto-zoom — zoom to fit the selected nodes as they move"
        aria-label="Auto-zoom"
      >
        <Maximize size={ICON} />
      </button>
      <button
        type="button"
        className={`map-analysis-layer-btn icon-only ${config.timeSlider.enabled ? 'active' : ''}`}
        onClick={() => setTimeSlider({ enabled: !config.timeSlider.enabled })}
        title="Time Slider"
        aria-label="Time Slider"
      >
        <Clock size={ICON} />
      </button>
      {/* #3826 Phase 2 WP-D: 2D/3D toggle. Disabled with a tooltip when the
          server can't serve DEM terrain tiles (elevation disabled, or a
          configured JSON elevation source — spec §3.11); neutral-disabled
          while the capabilities check is in flight. */}
      <button
        type="button"
        className={`map-analysis-layer-btn icon-only ${config.viewMode === '3d' ? 'active' : ''}`}
        onClick={() => setViewMode(config.viewMode === '3d' ? '2d' : '3d')}
        disabled={threeDDisabled}
        title={threeDTitle}
        aria-label="3D View"
      >
        <Box size={ICON} />
      </button>
      {/* #3636: node-to-node LOS distance measurement tool. Disabled until at
          least two positioned nodes exist, matching the "Features"-panel maps. */}
      <button
        type="button"
        className={`map-analysis-layer-btn icon-only ${measureMode ? 'active' : ''}`}
        onClick={() => {
          setMeasureMode(!measureMode);
          // Mutually exclusive with the Link Profile picker (#4111 Phase 2).
          if (!measureMode) setLinkProfileMode(false);
        }}
        disabled={analysisNodes.length < 2}
        title={analysisNodes.length < 2
          ? 'Measure — need at least two positioned nodes'
          : 'Measure straight-line distance between two nodes'}
        aria-label="Measure"
      >
        <Ruler size={ICON} />
      </button>
      {/* #4111 Phase 2: terrain link profile two-point picker. Hidden entirely
          when the server has elevation sampling disabled (nothing to profile);
          disabled until at least two positioned nodes exist for UX parity
          with Measure, even though the controller itself also accepts an
          arbitrary (non-node) map point as either endpoint. */}
      {elevationEnabled && (
        <button
          type="button"
          className={`map-analysis-layer-btn icon-only ${linkProfileMode ? 'active' : ''}`}
          onClick={() => {
            setLinkProfileMode(!linkProfileMode);
            // Mutually exclusive with the Measure tool.
            if (!linkProfileMode) setMeasureMode(false);
          }}
          disabled={analysisNodes.length < 2}
          title={analysisNodes.length < 2
            ? 'Link Profile — need at least two positioned nodes'
            : 'Link Profile — terrain, Fresnel clearance, and link budget between two points'}
          aria-label="Link Profile"
        >
          <Mountain size={ICON} />
        </button>
      )}
      {UNTIMED_LAYERS.map(({ key, label, icon }) => (
        <LayerToggleButton
          key={key}
          label={label}
          icon={icon}
          enabled={config.layers[key].enabled}
          onToggle={(next) => setLayerEnabled(key, next)}
        />
      ))}
      <LayerToggleButton
        label="Polar Grid"
        icon={<Radar size={ICON} />}
        enabled={config.layers.polarGrid.enabled && hasOwnNode}
        onToggle={(next) => setLayerEnabled('polarGrid', next)}
        disabled={!hasOwnNode}
        title={hasOwnNode ? undefined : 'Polar Grid — no source has a known own-node position'}
      />
      {TIMED_LAYERS.map(({ key, label, options, icon }) => (
        <LayerToggleButton
          key={key}
          label={label}
          icon={icon}
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
        className="map-analysis-reset icon-only"
        onClick={reset}
        style={{ marginLeft: 'auto' }}
        title="Reset"
        aria-label="Reset"
      >
        <RotateCcw size={ICON} />
      </button>
    </div>
  );
}
