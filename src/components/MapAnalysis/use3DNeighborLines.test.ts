/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from './MapAnalysisContext';
import { use3DNeighborLines } from './use3DNeighborLines';

// Mutable mock state so individual tests can vary the edges/nodes, same
// convention as layers/NeighborLinksLayer.test.tsx /
// layers/MeshCoreNeighborLinksLayer.test.tsx.
const mockState: {
  mtEdges: Array<Record<string, unknown>>;
  mcEdges: Array<Record<string, unknown>>;
  nodes: Array<Record<string, unknown>>;
} = { mtEdges: [], mcEdges: [], nodes: [] };

const mockUseNeighbors = vi.fn((args: unknown) => ({ data: { items: mockState.mtEdges }, isLoading: false, args }));
const mockUseMeshCoreNeighbors = vi.fn((args: unknown) => ({ data: { items: mockState.mcEdges }, isLoading: false, args }));

vi.mock('../../hooks/useMapAnalysisData', () => ({
  useNeighbors: (args: unknown) => mockUseNeighbors(args),
  useMeshCoreNeighbors: (args: unknown) => mockUseMeshCoreNeighbors(args),
}));
vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }),
  useDashboardUnifiedData: () => ({ nodes: mockState.nodes }),
  UNIFIED_SOURCE_ID: '__unified__',
}));

const NEIGHBORS_ENABLED_CONFIG = {
  version: 1,
  layers: {
    markers: { enabled: true, lookbackHours: null },
    traceroutes: { enabled: false, lookbackHours: 24 },
    neighbors: { enabled: true, lookbackHours: 24 },
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
    JSON.stringify({ ...NEIGHBORS_ENABLED_CONFIG, ...overrides }),
  );
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient();
  return createElement(QueryClientProvider, { client: qc }, createElement(MapAnalysisProvider, null, children));
}

describe('use3DNeighborLines', () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseNeighbors.mockClear();
    mockUseMeshCoreNeighbors.mockClear();
    mockState.mtEdges = [{ id: 1, nodeNum: 1, neighborNum: 2, sourceId: 'a', snr: 5, timestamp: 0 }];
    mockState.mcEdges = [
      {
        id: 7,
        publicKey: 'aa',
        neighborPublicKey: 'bb',
        sourceId: 'a',
        snr: 5,
        timestamp: 0,
        nodeName: 'Alpha',
        neighborName: 'Beta',
      },
    ];
    mockState.nodes = [
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 2, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
      { sourceId: 'a', isMeshCore: true, publicKey: 'aa', position: { latitude: 30, longitude: -90 } },
      { sourceId: 'a', isMeshCore: true, publicKey: 'bb', position: { latitude: 31, longitude: -91 } },
    ];
    setConfig();
  });

  it('produces a Line3DFeature for a positioned meshtastic edge with §2.2 encoding', () => {
    const { result } = renderHook(() => use3DNeighborLines(), { wrapper });
    const line = result.current.lines.find((l) => l.key === 'mt:1');
    expect(line).toBeDefined();
    expect(line).toEqual({
      key: 'mt:1',
      from: [30, -90],
      to: [31, -91],
      color: '#06b6d4', // transportColor('rf')
      opacity: 0.75, // snrToNeighborOpacity(5) = clamp((5+10)/20, 0.2, 1)
      width: 2,
      dash: [2, 2],
    });
  });

  it('PARITY: meshtastic selectionByKey deep-equals the 2D setSelected payload (layers/NeighborLinksLayer.tsx L164-171)', () => {
    const { result } = renderHook(() => use3DNeighborLines(), { wrapper });
    expect(result.current.selectionByKey.get('mt:1')).toEqual({
      type: 'neighbor',
      sourceId: 'a',
      nodeNum: 1,
      neighborNum: 2,
      snr: 5,
      timestamp: 0,
    });
  });

  it('produces a Line3DFeature for a positioned meshcore edge with §2.2 encoding', () => {
    const { result } = renderHook(() => use3DNeighborLines(), { wrapper });
    const line = result.current.lines.find((l) => l.key === 'mc:7');
    expect(line).toBeDefined();
    expect(line).toEqual({
      key: 'mc:7',
      from: [30, -90],
      to: [31, -91],
      color: '#06b6d4', // MC_NEIGHBOR_COLOR
      opacity: 0.75,
      width: 3,
      dash: [3, 2],
    });
  });

  it('PARITY: meshcore selectionByKey deep-equals the 2D setSelected payload (layers/MeshCoreNeighborLinksLayer.tsx L125-136)', () => {
    const { result } = renderHook(() => use3DNeighborLines(), { wrapper });
    expect(result.current.selectionByKey.get('mc:7')).toEqual({
      type: 'neighbor',
      sourceId: 'a',
      publicKey: 'aa',
      neighborPublicKey: 'bb',
      nodeName: 'Alpha',
      neighborName: 'Beta',
      snr: 5,
      timestamp: 0,
      nodeNum: 0,
      neighborNum: 0,
    });
  });

  it('drops a meshtastic edge when an endpoint has no position anywhere', () => {
    mockState.nodes = [{ nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } }];
    const { result } = renderHook(() => use3DNeighborLines(), { wrapper });
    expect(result.current.lines.some((l) => l.key === 'mt:1')).toBe(false);
  });

  it('drops a meshcore edge when an endpoint has no position anywhere', () => {
    mockState.nodes = [
      { sourceId: 'a', isMeshCore: true, publicKey: 'aa', position: { latitude: 30, longitude: -90 } },
    ];
    const { result } = renderHook(() => use3DNeighborLines(), { wrapper });
    expect(result.current.lines.some((l) => l.key === 'mc:7')).toBe(false);
  });

  it('excludes edges outside the time slider window when the slider is enabled', () => {
    setConfig({ timeSlider: { enabled: true, windowStartMs: 10, windowEndMs: 20 } });
    const { result } = renderHook(() => use3DNeighborLines(), { wrapper });
    expect(result.current.lines).toHaveLength(0);
  });

  it('returns empty lines/selectionByKey AND calls the fetch hooks with enabled:false when the layer is disabled', () => {
    setConfig({
      layers: { ...NEIGHBORS_ENABLED_CONFIG.layers, neighbors: { enabled: false, lookbackHours: 24 } },
    });
    const { result } = renderHook(() => use3DNeighborLines(), { wrapper });
    expect(result.current.lines).toEqual([]);
    expect(result.current.selectionByKey.size).toBe(0);
    expect(mockUseNeighbors).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(mockUseMeshCoreNeighbors).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
