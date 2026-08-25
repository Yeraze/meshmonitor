/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { use3DTracerouteLines, type Use3DTracerouteLinesParams } from './use3DTracerouteLines';
import type { SelectedTarget } from './MapAnalysisContext';
import type { AnalyzedSegment } from '../../hooks/useTracerouteAnalysis';
import { getSegmentSnrOpacity, weightByOccurrence } from '../../utils/mapHelpers';

// Mutable mock state, same convention as layers/TraceroutePathsLayer.test.tsx.
const mockState: { segments: AnalyzedSegment[]; lastAnalysisArgs?: unknown } = { segments: [] };

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
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
    useTracerouteAnalysis: (args: unknown) => {
      mockState.lastAnalysisArgs = args;
      return { segments: mockState.segments, summary: null };
    },
  };
});

/**
 * Build the explicit params the hook now takes (previously read from
 * `useMapAnalysisCtx()`). `sources: []` = "all sources"; `selected: null` =
 * SNR color mode.
 */
function makeParams(overrides: Partial<Use3DTracerouteLinesParams> = {}): Use3DTracerouteLinesParams {
  return {
    layer: { enabled: true, lookbackHours: 24 },
    sources: [],
    timeSlider: { enabled: false },
    selected: null,
    nodeFilter: '',
    ...overrides,
  };
}

/** A node selection, so `colorMode` flips to 'direction' the same way it does
 * when a user clicks a node marker in the real app. */
function nodeSelected(nodeNum: number, sourceId: string): SelectedTarget {
  return { type: 'node', nodeNum, sourceId };
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
    mockState.segments = [RF_SEGMENT];
  });

  it('produces a straight 2-vertex Line3DFeature for an RF segment (solid, §2.6 no curvature)', () => {
    const { result } = renderHook(() => use3DTracerouteLines(makeParams()));
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
    const { result } = renderHook(() => use3DTracerouteLines(makeParams()));
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
    const { result } = renderHook(() => use3DTracerouteLines(makeParams()));
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
    const { result } = renderHook(() =>
      use3DTracerouteLines(makeParams({ selected: nodeSelected(0x1111, 'a') })),
    );
    const outbound = result.current.lines.find((l) => l.key === 'tr:a:0x1111->0x2222');
    const inbound = result.current.lines.find((l) => l.key === 'tr:a:0x2222->0x1111');
    expect(outbound?.color).toBe('#3b82f6'); // OUTBOUND_COLOR (mirror of TraceroutePathsLayer.tsx L25)
    expect(inbound?.color).toBe('#f43f5e'); // INBOUND_COLOR (mirror of TraceroutePathsLayer.tsx L26)
  });

  it('falls back to snrColors.noData for a neutral segment while colorMode is direction', () => {
    mockState.segments = [{ ...RF_SEGMENT, direction: 'neutral' }];
    const { result } = renderHook(() =>
      use3DTracerouteLines(makeParams({ selected: nodeSelected(0x1111, 'a') })),
    );
    const line = result.current.lines.find((l) => l.key === `tr:${RF_SEGMENT.key}`);
    expect(line?.color).toBe('#6c7086'); // snrColors.noData
  });

  it('returns empty lines/selectionByKey when the traceroutes layer is disabled', () => {
    const { result } = renderHook(() =>
      use3DTracerouteLines(makeParams({ layer: { enabled: false, lookbackHours: 24 } })),
    );
    expect(result.current.lines).toEqual([]);
    expect(result.current.selectionByKey.size).toBe(0);
  });

  describe('visibleNodeNums gate (#4808)', () => {
    it('feeds the caller gate into useTracerouteAnalysis so segments are limited to visible nodes', () => {
      renderHook(() => use3DTracerouteLines(makeParams({ visibleNodeNums: new Set([1, 2]) })));
      // nodeFilter is '' (→ null "all"), so the combined gate is the caller set.
      expect((mockState.lastAnalysisArgs as { visibleNodeNums?: Set<number> }).visibleNodeNums).toEqual(
        new Set([1, 2]),
      );
    });

    it('leaves useTracerouteAnalysis ungated (null) when no caller gate is passed (MapAnalysis)', () => {
      renderHook(() => use3DTracerouteLines(makeParams()));
      expect((mockState.lastAnalysisArgs as { visibleNodeNums?: Set<number> | null }).visibleNodeNums).toBeNull();
    });
  });
});
