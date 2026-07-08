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
