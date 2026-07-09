/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MapAnalysisProvider } from './MapAnalysisContext';
import { useAnalysisNodes } from './useAnalysisNodes';

const MOCK_NODES = [
  {
    // Meshtastic, positioned, visible.
    nodeNum: 1,
    sourceId: 'a',
    nodeId: '!00000001',
    longName: 'Alpha',
    shortName: 'ALP',
    latitude: 30,
    longitude: -90,
    isMeshCore: false,
    sources: [{ sourceId: 'a', sourceName: 'A', protocol: 'Meshtastic' }],
  },
  {
    // MeshCore, positioned, visible.
    nodeNum: 0,
    sourceId: 'b',
    nodeId: 'mc-node',
    publicKey: 'deadbeef',
    longName: 'Bravo',
    shortName: 'BRV',
    latitude: 31,
    longitude: -91,
    isMeshCore: true,
    sources: [{ sourceId: 'b', sourceName: 'B', protocol: 'MeshCore' }],
  },
  {
    // Meshtastic, unpositioned — should be dropped.
    nodeNum: 2,
    sourceId: 'a',
    nodeId: '!00000002',
    longName: 'Charlie',
    shortName: 'CHR',
    isMeshCore: false,
    sources: [{ sourceId: 'a', sourceName: 'A', protocol: 'Meshtastic' }],
  },
  {
    // Meshtastic, positioned, hideFromMap — should be dropped.
    nodeNum: 3,
    sourceId: 'a',
    nodeId: '!00000003',
    longName: 'Delta',
    shortName: 'DLT',
    latitude: 32,
    longitude: -92,
    hideFromMap: true,
    isMeshCore: false,
    sources: [{ sourceId: 'a', sourceName: 'A', protocol: 'Meshtastic' }],
  },
];

const mockUseDashboardUnifiedData = vi.fn();

vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }),
  useDashboardUnifiedData: (...args: unknown[]) => mockUseDashboardUnifiedData(...args),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <MapAnalysisProvider>{children}</MapAnalysisProvider>;
}

describe('useAnalysisNodes', () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseDashboardUnifiedData.mockReturnValue({ nodes: MOCK_NODES });
  });

  it('returns only positioned+visible nodes with mt:/mc: keys', () => {
    const { result } = renderHook(() => useAnalysisNodes(), { wrapper });
    expect(result.current).toHaveLength(2);
    const keys = result.current.map((n) => n.key).sort();
    expect(keys).toEqual(['mc:deadbeef', 'mt:1']);
  });

  it('drops nodes with no position', () => {
    const { result } = renderHook(() => useAnalysisNodes(), { wrapper });
    expect(result.current.some((n) => n.node.nodeNum === 2)).toBe(false);
  });

  it('drops nodes with hideFromMap', () => {
    const { result } = renderHook(() => useAnalysisNodes(), { wrapper });
    expect(result.current.some((n) => n.node.nodeNum === 3)).toBe(false);
  });

  it('offsets a low-precision node within its cell but leaves others centered (#4016)', () => {
    mockUseDashboardUnifiedData.mockReturnValue({
      nodes: [
        // Low precision (16 bits) -> marker offset from the reported center.
        { ...MOCK_NODES[0], nodeNum: 10, nodeId: '!0000000a', latitude: 30, longitude: -90, positionPrecisionBits: 16 },
        // Full precision -> unchanged.
        { ...MOCK_NODES[0], nodeNum: 11, nodeId: '!0000000b', latitude: 40, longitude: -100, positionPrecisionBits: 32 },
        // Missing precision -> unchanged.
        { ...MOCK_NODES[0], nodeNum: 12, nodeId: '!0000000c', latitude: 41, longitude: -101 },
        // Low precision but user-overridden position -> unchanged.
        { ...MOCK_NODES[0], nodeNum: 13, nodeId: '!0000000d', latitude: 42, longitude: -102, positionPrecisionBits: 16, positionIsOverride: true },
      ],
    });
    const { result } = renderHook(() => useAnalysisNodes(), { wrapper });
    const byNum = (num: number) => result.current.find((n) => n.node.nodeNum === num)!;

    // Offset node: moved off the exact center, but still within the ~728m cell (~0.0065deg).
    const offset = byNum(10).latLng;
    expect(offset[0]).not.toBe(30);
    expect(offset[1]).not.toBe(-90);
    expect(Math.abs(offset[0] - 30)).toBeLessThan(0.01);

    // Full-precision, missing-precision, and overridden nodes stay dead-center.
    expect(byNum(11).latLng).toEqual([40, -100]);
    expect(byNum(12).latLng).toEqual([41, -101]);
    expect(byNum(13).latLng).toEqual([42, -102]);
  });

  it('offset is deterministic across renders (#4016)', () => {
    mockUseDashboardUnifiedData.mockReturnValue({
      nodes: [{ ...MOCK_NODES[0], nodeNum: 10, nodeId: '!0000000a', latitude: 30, longitude: -90, positionPrecisionBits: 16 }],
    });
    const first = renderHook(() => useAnalysisNodes(), { wrapper }).result.current[0].latLng;
    const second = renderHook(() => useAnalysisNodes(), { wrapper }).result.current[0].latLng;
    expect(first).toEqual(second);
  });

  it('applies the config.sources allow-list', () => {
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({
        version: 1,
        layers: {
          markers: { enabled: true, lookbackHours: null },
          traceroutes: { enabled: false, lookbackHours: 24 },
          neighbors: { enabled: false, lookbackHours: 24 },
          heatmap: { enabled: false, lookbackHours: 24 },
          trails: { enabled: false, lookbackHours: 24 },
          hopShading: { enabled: false, lookbackHours: null },
          snrOverlay: { enabled: false, lookbackHours: null },
          waypoints: { enabled: true, lookbackHours: null },
          polarGrid: { enabled: false, lookbackHours: null },
        },
        sources: ['a'],
        timeSlider: { enabled: false },
        inspectorOpen: true,
        selectedNodeIds: [],
      }),
    );
    const { result } = renderHook(() => useAnalysisNodes(), { wrapper });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].key).toBe('mt:1');
  });
});
