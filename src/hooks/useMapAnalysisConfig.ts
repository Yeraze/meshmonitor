import { useCallback, useEffect, useState } from 'react';

export type LayerKey =
  | 'markers'
  | 'traceroutes'
  | 'neighbors'
  | 'heatmap'
  | 'trails'
  | 'hopShading'
  | 'snrOverlay'
  | 'waypoints';

export interface LayerConfig {
  enabled: boolean;
  lookbackHours: number | null;
  options?: Record<string, unknown>;
}

export interface MapAnalysisConfig {
  version: 1;
  layers: Record<LayerKey, LayerConfig>;
  sources: string[]; // empty = "all"
  timeSlider: {
    enabled: boolean;
    windowStartMs?: number;
    windowEndMs?: number;
  };
  inspectorOpen: boolean;
}

export const DEFAULT_CONFIG: MapAnalysisConfig = {
  version: 1,
  layers: {
    markers:    { enabled: true,  lookbackHours: null },
    traceroutes:{ enabled: false, lookbackHours: 24 },
    neighbors:  { enabled: false, lookbackHours: 24 },
    heatmap:    { enabled: false, lookbackHours: 24 },
    trails:     { enabled: false, lookbackHours: 24 },
    hopShading: { enabled: false, lookbackHours: null },
    snrOverlay: { enabled: false, lookbackHours: null },
    waypoints:  { enabled: true,  lookbackHours: null },
  },
  sources: [],
  timeSlider: { enabled: false },
  inspectorOpen: true,
};

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
      timeSlider: { ...DEFAULT_CONFIG.timeSlider, ...(parsed.timeSlider ?? {}) },
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

  const setSources = useCallback((sources: string[]) => {
    setConfig((prev) => ({ ...prev, sources }));
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
    setSources,
    setTimeSlider,
    setInspectorOpen,
    reset,
  };
}
