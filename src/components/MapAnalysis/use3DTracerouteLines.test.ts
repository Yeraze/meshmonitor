/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider, useMapAnalysisCtx } from './MapAnalysisContext';
import { use3DTracerouteLines } from './use3DTracerouteLines';
import type { AnalyzedSegment } from '../../hooks/useTracerouteAnalysis';
import { getSegmentSnrOpacity, weightByOccurrence } from '../../utils/mapHelpers';

// Mutable mock state, same convention as layers/TraceroutePathsLayer.test.tsx.
const mockState: { segments: AnalyzedSegment[] } = { segments: [] };

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({
    overlayColors: {
      mqttSegment: '#b4befe',
      snrColors: {
        excellent: '#22c55e',
        good: '#eab308',
        fair: '#f97316',
        poor: '#ef4444',
        noData: '#6c7086',
      },
    },
  }),
}));
vi.mock('../../hooks/useMapAnalysisData', () => ({
  useTraceroutes: () => ({
    items: [],
    isLoading: false,
    isError: false,
    error: null,
    progress: { loaded: 0, estimatedTotal: 0, percent: 100 },
  }),
}));
vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({ nodes: [] }),
  UNIFIED_SOURCE_ID: '__unified__',
}));
vi.mock('../../hooks/useTracerouteAnalysis', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useTracerouteAnalysis')>(
    '../../hooks/useTracerouteAnalysis',
  );
  return {
    ...actual,
    useTracerouteAnalysis: () => ({ segments: mockState.segments, summary: null }),
  };
});

const TRACEROUTES_ENABLED_CONFIG = {
  version: 1,
  layers: {
    markers: { enabled: true, lookbackHours: null },
    traceroutes: { enabled: true, lookbackHours: 24 },
    neighbors: { enabled: false, lookbackHours: 24 },
    heatmap: { enabled: false, lookbackHours: 24 },
    trails: { enabled: false, lookbackHours: 24 },
    hopShading: { enabled: false, lookbackHours: null },
    snrOverlay: { enabled: false, lookbackHours: null },
    waypoints: { enabled: true, lookbackHours: null },
    polarGrid: { enabled: false, lookbackHours: null },
  },
  sources: [],
  timeSlider: { enabled: false },
  inspectorOpen: true,
  selectedNodeIds: [],
};

function setConfig(overrides: Record<string, unknown> = {}) {
  localStorage.setItem(
    'mapAnalysis.config.v1',
    JSON.stringify({ ...TRACEROUTES_ENABLED_CONFIG, ...overrides }),
  );
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return createElement(QueryClientProvider, { client: qc }, createElement(MapAnalysisProvider, null, children));
}

/** Renders `use3DTracerouteLines()` after selecting a node (via the shared
 * context), so `colorMode` flips to 'direction' the same way it does when a
 * user clicks a node marker in the real app. */
function useTracerouteLinesWithNodeSelected(nodeNum: number, sourceId: string) {
  const { selected, setSelected } = useMapAnalysisCtx();
  useEffect(() => {
    if (!selected) setSelected({ type: 'node', nodeNum, sourceId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  return use3DTracerouteLines();
}

const RF_SEGMENT: AnalyzedSegment = {
  key: 'a:0x1111->0x2222',
  sourceId: 'a',
  from: 0x1111,
  to: 0x2222,
  fromPos: [30, -90],
  toPos: [31, -91],
  direction: 'neutral',
  neighborNum: 0x1111,
  avgSnr: 8,
  occurrences: 3,
  isMqtt: false,
};

const MQTT_SEGMENT: AnalyzedSegment = {
  key: 'a:0x3333->0x4444',
  sourceId: 'a',
  from: 0x3333,
  to: 0x4444,
  fromPos: [32, -92],
  toPos: [33, -93],
  direction: 'neutral',
  neighborNum: 0x3333,
  avgSnr: null,
  occurrences: 1,
  isMqtt: true,
};

describe('use3DTracerouteLines', () => {
  beforeEach(() => {
    localStorage.clear();
    mockState.segments = [RF_SEGMENT];
    setConfig();
  });

  it('produces a straight 2-vertex Line3DFeature for an RF segment (solid, §2.6 no curvature)', () => {
    const { result } = renderHook(() => use3DTracerouteLines(), { wrapper });
    const line = result.current.lines.find((l) => l.key === `tr:${RF_SEGMENT.key}`);
    expect(line).toBeDefined();
    expect(line).toEqual({
      key: `tr:${RF_SEGMENT.key}`,
      from: [30, -90],
      to: [31, -91],
      color: '#22c55e', // snrToColor(8, snrColors) -> excellent (>=5)
      opacity: getSegmentSnrOpacity([{ snr: 8 }], false),
      width: weightByOccurrence(3),
      // no `dash` key: solid line.
    });
  });

  it('PARITY: segment selectionByKey deep-equals the 2D setSelected payload (layers/TraceroutePathsLayer.tsx L165-174)', () => {
    const { result } = renderHook(() => use3DTracerouteLines(), { wrapper });
    expect(result.current.selectionByKey.get(`tr:${RF_SEGMENT.key}`)).toEqual({
      type: 'segment',
      fromNodeNum: RF_SEGMENT.from,
      toNodeNum: RF_SEGMENT.to,
      direction: RF_SEGMENT.direction,
      occurrences: RF_SEGMENT.occurrences,
      avgSnr: RF_SEGMENT.avgSnr,
    });
  });

  it('dashes an MQTT/unknown-SNR segment (dash=[2,2]) and colors it via overlayColors.mqttSegment', () => {
    mockState.segments = [MQTT_SEGMENT];
    const { result } = renderHook(() => use3DTracerouteLines(), { wrapper });
    const line = result.current.lines.find((l) => l.key === `tr:${MQTT_SEGMENT.key}`);
    expect(line?.dash).toEqual([2, 2]);
    expect(line?.color).toBe('#b4befe');
    expect(line?.opacity).toBe(getSegmentSnrOpacity(undefined, true));
  });

  it('flips colorMode to direction colors when a node is selected', () => {
    mockState.segments = [
      { ...RF_SEGMENT, direction: 'outbound' },
      { ...RF_SEGMENT, key: 'a:0x2222->0x1111', from: 0x2222, to: 0x1111, direction: 'inbound' },
    ];
    const { result } = renderHook(() => useTracerouteLinesWithNodeSelected(0x1111, 'a'), { wrapper });
    const outbound = result.current.lines.find((l) => l.key === 'tr:a:0x1111->0x2222');
    const inbound = result.current.lines.find((l) => l.key === 'tr:a:0x2222->0x1111');
    expect(outbound?.color).toBe('#3b82f6'); // OUTBOUND_COLOR (mirror of TraceroutePathsLayer.tsx L25)
    expect(inbound?.color).toBe('#f43f5e'); // INBOUND_COLOR (mirror of TraceroutePathsLayer.tsx L26)
  });

  it('falls back to snrColors.noData for a neutral segment while colorMode is direction', () => {
    mockState.segments = [{ ...RF_SEGMENT, direction: 'neutral' }];
    const { result } = renderHook(() => useTracerouteLinesWithNodeSelected(0x1111, 'a'), { wrapper });
    const line = result.current.lines.find((l) => l.key === `tr:${RF_SEGMENT.key}`);
    expect(line?.color).toBe('#6c7086'); // snrColors.noData
  });

  it('returns empty lines/selectionByKey when the traceroutes layer is disabled', () => {
    setConfig({
      layers: { ...TRACEROUTES_ENABLED_CONFIG.layers, traceroutes: { enabled: false, lookbackHours: 24 } },
    });
    const { result } = renderHook(() => use3DTracerouteLines(), { wrapper });
    expect(result.current.lines).toEqual([]);
    expect(result.current.selectionByKey.size).toBe(0);
  });
});
