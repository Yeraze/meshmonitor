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

  it('leaves a LONE low-precision node at its reported center (#4155)', () => {
    mockUseDashboardUnifiedData.mockReturnValue({
      nodes: [
        // Low precision (16 bits) but ALONE in its cell -> now stays centered
        // (was offset pre-#4155; a lone marker has nothing to declutter).
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

    expect(byNum(10).latLng).toEqual([30, -90]); // lone obscured node -> dead-center
    expect(byNum(11).latLng).toEqual([40, -100]);
    expect(byNum(12).latLng).toEqual([41, -101]);
    expect(byNum(13).latLng).toEqual([42, -102]);
  });

  it('spreads 2+ low-precision nodes that share an accuracy cell (#4155/#4016)', () => {
    mockUseDashboardUnifiedData.mockReturnValue({
      nodes: [
        // Two obscured nodes reporting the SAME snapped cell (same lat/lng + bits).
        { ...MOCK_NODES[0], nodeNum: 10, nodeId: '!0000000a', latitude: 30, longitude: -90, positionPrecisionBits: 16 },
        { ...MOCK_NODES[0], nodeNum: 14, nodeId: '!0000000e', latitude: 30, longitude: -90, positionPrecisionBits: 16 },
      ],
    });
    const { result } = renderHook(() => useAnalysisNodes(), { wrapper });
    const byNum = (num: number) => result.current.find((n) => n.node.nodeNum === num)!;

    const a = byNum(10).latLng;
    const b = byNum(14).latLng;
    // Both pushed off the shared center, to distinct spots, still within the cell.
    expect(a).not.toEqual([30, -90]);
    expect(b).not.toEqual([30, -90]);
    expect(a).not.toEqual(b);
    expect(Math.abs(a[0] - 30)).toBeLessThan(0.01);
    expect(Math.abs(b[0] - 30)).toBeLessThan(0.01);
  });

  it('offset is deterministic across renders for shared-cell nodes (#4016)', () => {
    const shared = [
      { ...MOCK_NODES[0], nodeNum: 10, nodeId: '!0000000a', latitude: 30, longitude: -90, positionPrecisionBits: 16 },
      { ...MOCK_NODES[0], nodeNum: 14, nodeId: '!0000000e', latitude: 30, longitude: -90, positionPrecisionBits: 16 },
    ];
    mockUseDashboardUnifiedData.mockReturnValue({ nodes: shared });
    const first = renderHook(() => useAnalysisNodes(), { wrapper }).result.current.find((n) => n.node.nodeNum === 10)!.latLng;
    mockUseDashboardUnifiedData.mockReturnValue({ nodes: shared });
    const second = renderHook(() => useAnalysisNodes(), { wrapper }).result.current.find((n) => n.node.nodeNum === 10)!.latLng;
    expect(first).toEqual(second);
  });

  it('hides MQTT-transport nodes when Show MQTT is off, keeping RF nodes (#4129)', () => {
    mockUseDashboardUnifiedData.mockReturnValue({
      nodes: [
        // No transportMechanism -> classified RF (stays).
        { ...MOCK_NODES[0], nodeNum: 20, nodeId: '!00000014' },
        // transportMechanism 5 == MQTT (dropped when Show MQTT is off).
        { ...MOCK_NODES[0], nodeNum: 21, nodeId: '!00000015', latitude: 33, longitude: -93, transportMechanism: 5 },
      ],
    });
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({ version: 1, transports: { rf: true, udp: true, mqtt: false } }),
    );
    const { result } = renderHook(() => useAnalysisNodes(), { wrapper });
    const nums = result.current.map((n) => n.node.nodeNum).sort();
    expect(nums).toEqual([20]);
  });

  it('keeps a node visible via its RF class even when MQTT is off (additive union, #4129)', () => {
    mockUseDashboardUnifiedData.mockReturnValue({
      nodes: [
        // Seen via BOTH RF and MQTT across sources -> stays while RF is on.
        { ...MOCK_NODES[0], nodeNum: 22, nodeId: '!00000016', transportMechanism: 5, transportClasses: ['rf', 'mqtt'] },
      ],
    });
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({ version: 1, transports: { rf: true, udp: true, mqtt: false } }),
    );
    const { result } = renderHook(() => useAnalysisNodes(), { wrapper });
    expect(result.current.map((n) => n.node.nodeNum)).toEqual([22]);
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
