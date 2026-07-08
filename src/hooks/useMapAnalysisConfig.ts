import { useCallback, useEffect, useState } from 'react';
import { NODE_TYPE_CATEGORIES, type NodeTypeCategory } from '../utils/nodeTypeCategory';

export type LayerKey =
  | 'markers'
  | 'traceroutes'
  | 'neighbors'
  | 'heatmap'
  | 'trails'
  | 'hopShading'
  | 'snrOverlay'
  | 'waypoints'
  | 'polarGrid';

export interface LayerConfig {
  enabled: boolean;
  lookbackHours: number | null;
  options?: Record<string, unknown>;
}

/** Persisted options for the traceroutes layer (issue #3399). */
export interface TracerouteLayerOptions {
  /** When a node is selected, which directions to render. */
  directionMode: 'both' | 'inbound' | 'outbound';
  /** When a node is selected, restrict traceroutes to ones involving it. */
  scopeToSelectedNode: boolean;
  /** Hide links observed fewer than this many times (weak-link filter). */
  minOccurrences: number;
  /** Hide links whose mean SNR (dB) is below this; null = off. */
  minSnr: number | null;
}

export const DEFAULT_TRACEROUTE_OPTIONS: TracerouteLayerOptions = {
  directionMode: 'both',
  scopeToSelectedNode: true,
  minOccurrences: 1,
  minSnr: null,
};

export interface MapAnalysisConfig {
  version: 1;
  layers: Record<LayerKey, LayerConfig>;
  /** Per-category marker visibility (issue #3546); missing key = visible. */
  nodeTypes: Record<NodeTypeCategory, boolean>;
  sources: string[]; // empty = "all"
  timeSlider: {
    enabled: boolean;
    windowStartMs?: number;
    windowEndMs?: number;
  };
  inspectorOpen: boolean;
  /** Unified node keys (`mt:<nodeNum>` / `mc:<publicKey>`) currently selected/followed; empty = no selection (issue #3788). */
  selectedNodeIds: string[];
  /** Follow: recenter to the selected nodes' average position each update, keep zoom (issue #3788 P2). */
  followMode: boolean;
  /** Auto-zoom: fit the selected nodes' bounds (+15% margin) each update (issue #3788 P2). */
  autoZoom: boolean;
}

const ALL_NODE_TYPES_VISIBLE = Object.fromEntries(
  NODE_TYPE_CATEGORIES.map((c) => [c, true]),
) as Record<NodeTypeCategory, boolean>;

export const DEFAULT_CONFIG: MapAnalysisConfig = {
  version: 1,
  layers: {
    markers:    { enabled: true,  lookbackHours: null },
    traceroutes:{ enabled: false, lookbackHours: 24, options: { ...DEFAULT_TRACEROUTE_OPTIONS } },
    neighbors:  { enabled: false, lookbackHours: 24 },
    heatmap:    { enabled: false, lookbackHours: 24 },
    trails:     { enabled: false, lookbackHours: 24 },
    hopShading: { enabled: false, lookbackHours: null },
    snrOverlay: { enabled: false, lookbackHours: null },
    waypoints:  { enabled: true,  lookbackHours: null },
    polarGrid:  { enabled: false, lookbackHours: null },
  },
  nodeTypes: { ...ALL_NODE_TYPES_VISIBLE },
  sources: [],
  timeSlider: { enabled: false },
  inspectorOpen: true,
  selectedNodeIds: [],
  followMode: false,
  autoZoom: false,
};

/** Read the traceroute options off a config, layering stored values over defaults. */
export function getTracerouteOptions(config: MapAnalysisConfig): TracerouteLayerOptions {
  return {
    ...DEFAULT_TRACEROUTE_OPTIONS,
    ...(config.layers.traceroutes.options as Partial<TracerouteLayerOptions> | undefined),
  };
}

const STORAGE_KEY = 'mapAnalysis.config.v1';

function load(): MapAnalysisConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return DEFAULT_CONFIG;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      layers: { ...DEFAULT_CONFIG.layers, ...(parsed.layers ?? {}) },
      nodeTypes: { ...ALL_NODE_TYPES_VISIBLE, ...(parsed.nodeTypes ?? {}) },
      timeSlider: { ...DEFAULT_CONFIG.timeSlider, ...(parsed.timeSlider ?? {}) },
      selectedNodeIds: Array.isArray(parsed.selectedNodeIds) ? parsed.selectedNodeIds : [],
      followMode: typeof parsed.followMode === 'boolean' ? parsed.followMode : false,
      autoZoom: typeof parsed.autoZoom === 'boolean' ? parsed.autoZoom : false,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function save(config: MapAnalysisConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* quota */
  }
}

export function useMapAnalysisConfig() {
  const [config, setConfig] = useState<MapAnalysisConfig>(load);

  useEffect(() => {
    save(config);
  }, [config]);

  const setLayerEnabled = useCallback((layer: LayerKey, enabled: boolean) => {
    setConfig((prev) => ({
      ...prev,
      layers: { ...prev.layers, [layer]: { ...prev.layers[layer], enabled } },
    }));
  }, []);

  const setLayerLookback = useCallback((layer: LayerKey, hours: number | null) => {
    setConfig((prev) => ({
      ...prev,
      layers: { ...prev.layers, [layer]: { ...prev.layers[layer], lookbackHours: hours } },
    }));
  }, []);

  const setLayerOptions = useCallback((layer: LayerKey, options: Record<string, unknown>) => {
    setConfig((prev) => ({
      ...prev,
      layers: {
        ...prev.layers,
        [layer]: {
          ...prev.layers[layer],
          options: { ...prev.layers[layer].options, ...options },
        },
      },
    }));
  }, []);

  const setNodeTypeEnabled = useCallback((category: NodeTypeCategory, enabled: boolean) => {
    setConfig((prev) => ({
      ...prev,
      nodeTypes: { ...prev.nodeTypes, [category]: enabled },
    }));
  }, []);

  const setSources = useCallback((sources: string[]) => {
    setConfig((prev) => ({ ...prev, sources }));
  }, []);

  const setSelectedNodeIds = useCallback((ids: string[]) => {
    setConfig((prev) => ({ ...prev, selectedNodeIds: ids }));
  }, []);

  const setFollowMode = useCallback((v: boolean) => {
    setConfig((prev) => ({ ...prev, followMode: v }));
  }, []);

  const setAutoZoom = useCallback((v: boolean) => {
    setConfig((prev) => ({ ...prev, autoZoom: v }));
  }, []);

  const setTimeSlider = useCallback((ts: Partial<MapAnalysisConfig['timeSlider']>) => {
    setConfig((prev) => ({ ...prev, timeSlider: { ...prev.timeSlider, ...ts } }));
  }, []);

  const setInspectorOpen = useCallback((open: boolean) => {
    setConfig((prev) => ({ ...prev, inspectorOpen: open }));
  }, []);

  const reset = useCallback(() => setConfig(DEFAULT_CONFIG), []);

  return {
    config,
    setLayerEnabled,
    setLayerLookback,
    setLayerOptions,
    setNodeTypeEnabled,
    setSources,
    setSelectedNodeIds,
    setFollowMode,
    setAutoZoom,
    setTimeSlider,
    setInspectorOpen,
    reset,
  };
}
