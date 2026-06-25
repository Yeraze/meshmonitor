/**
 * Tests for useDashboardData hooks
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useDashboardSources,
  useDashboardSourceData,
  useDashboardUnifiedData,
  mergeUnifiedSourceData,
  type DashboardSource,
  type SourceStatus,
} from './useDashboardData';

// Mock ../init to provide a stable appBasename
vi.mock('../init', () => ({
  appBasename: '/meshmonitor',
}));

// Mock AuthContext so the hook doesn't require an AuthProvider in tests
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: true, user: { isAdmin: true } } }),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Helper: create a QueryClientProvider wrapper with retry disabled for tests
function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

// Helper: resolve a fetch mock with JSON data
function mockFetchJson(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

// Helper: reject a fetch mock
function mockFetchError(message = 'Network error') {
  mockFetch.mockRejectedValueOnce(new Error(message));
}

// Sample data
const mockSources: DashboardSource[] = [
  { id: 'src-1', name: 'Source One', type: 'tcp', enabled: true },
  { id: 'src-2', name: 'Source Two', type: 'serial', enabled: false },
];

const mockStatus: SourceStatus = {
  sourceId: 'src-1',
  sourceName: 'Source One',
  sourceType: 'tcp',
  connected: true,
};

describe('useDashboardSources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and returns sources', async () => {
    mockFetchJson(mockSources);

    const { result } = renderHook(() => useDashboardSources(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFetch).toHaveBeenCalledWith(
      '/meshmonitor/api/sources',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].id).toBe('src-1');
    expect(result.current.data![1].id).toBe('src-2');
  });

  it('handles fetch error', async () => {
    // Return a non-ok response
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { result } = renderHook(() => useDashboardSources(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeTruthy();
  });
});

describe('useDashboardSourceData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty defaults when sourceId is null', () => {
    const { result } = renderHook(() => useDashboardSourceData(null), {
      wrapper: createWrapper(),
    });

    expect(result.current.nodes).toEqual([]);
    expect(result.current.traceroutes).toEqual([]);
    expect(result.current.neighborInfo).toEqual([]);
    expect(result.current.channels).toEqual([]);
    expect(result.current.status).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);

    // No fetch calls should have been made
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches data via the bundled dashboard endpoint plus status (#3735)', async () => {
    const mockNodes = [{ num: 1, id: '!abc' }, { num: 2, id: '!def' }];
    const mockTraceroutes = [{ id: 10, fromNodeNum: 1, toNodeNum: 2 }];
    const mockNeighborInfo = [{ nodeId: '!abc', neighbors: [] }];
    const mockChannels = [{ index: 0, name: 'Primary' }];

    // The hook now fires ONE bundled dashboard request (nodes+traceroutes+
    // neighborInfo+channels) plus the lightweight status query, instead of five
    // separate GETs. Insertion order: dashboard, status.
    mockFetchJson({
      sourceId: 'src-1',
      nodes: mockNodes,
      traceroutes: mockTraceroutes,
      neighborInfo: mockNeighborInfo,
      channels: mockChannels,
    });
    mockFetchJson(mockStatus);

    const { result } = renderHook(() => useDashboardSourceData('src-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const calledUrls = mockFetch.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledUrls).toContain('/meshmonitor/api/sources/src-1/dashboard');
    expect(calledUrls).toContain('/meshmonitor/api/sources/src-1/status');

    expect(result.current.nodes).toEqual(mockNodes);
    expect(result.current.traceroutes).toEqual(mockTraceroutes);
    expect(result.current.neighborInfo).toEqual(mockNeighborInfo);
    expect(result.current.channels).toEqual(mockChannels);
    expect(result.current.status).toEqual(mockStatus);
    expect(result.current.isError).toBe(false);
  });
});

describe('mergeUnifiedSourceData', () => {
  it('returns empty arrays when no sources provided', () => {
    const merged = mergeUnifiedSourceData([]);
    expect(merged.nodes).toEqual([]);
    expect(merged.traceroutes).toEqual([]);
    expect(merged.neighborInfo).toEqual([]);
    expect(merged.channels).toEqual([]);
  });

  it('dedupes nodes by nodeNum and prefers field values from the freshest record', () => {
    const merged = mergeUnifiedSourceData([
      {
        nodes: [{ nodeNum: 100, lastHeard: 1000, longName: 'Old' }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
      {
        nodes: [{ nodeNum: 100, lastHeard: 2000, longName: 'New' }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ]);
    expect(merged.nodes).toHaveLength(1);
    expect((merged.nodes[0] as any).longName).toBe('New');
    expect((merged.nodes[0] as any).lastHeard).toBe(2000);
  });

  it('keeps an older source\'s position when the freshest record has none (field-level merge)', () => {
    // Reproduces the "node disappears on Unified" bug: source-1 hears the
    // node most recently but with no GPS; source-2's older record had a
    // valid position. The merged record must retain the position so the
    // map can still draw a marker.
    const merged = mergeUnifiedSourceData([
      {
        nodes: [
          {
            nodeNum: 200,
            lastHeard: 5000,
            longName: 'Roamer',
            position: null,
          },
        ],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
      {
        nodes: [
          {
            nodeNum: 200,
            lastHeard: 1000,
            longName: 'Roamer',
            position: { latitude: 35.0, longitude: -80.0 },
          },
        ],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ]);
    expect((merged.nodes[0] as any).position).toEqual({ latitude: 35.0, longitude: -80.0 });
    expect((merged.nodes[0] as any).lastHeard).toBe(5000);
  });

  it('only marks merged node as ignored when EVERY source has it ignored', () => {
    const oneIgnored = mergeUnifiedSourceData([
      {
        nodes: [{ nodeNum: 300, lastHeard: 100, isIgnored: true }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
      {
        nodes: [{ nodeNum: 300, lastHeard: 200, isIgnored: false }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ]);
    expect((oneIgnored.nodes[0] as any).isIgnored).toBe(false);

    const allIgnored = mergeUnifiedSourceData([
      {
        nodes: [{ nodeNum: 301, lastHeard: 100, isIgnored: true }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
      {
        nodes: [{ nodeNum: 301, lastHeard: 200, isIgnored: true }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ]);
    expect((allIgnored.nodes[0] as any).isIgnored).toBe(true);
  });

  it('marks merged node as favorite when ANY source has it favorited', () => {
    const merged = mergeUnifiedSourceData([
      {
        nodes: [{ nodeNum: 400, lastHeard: 100, isFavorite: false }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
      {
        nodes: [{ nodeNum: 400, lastHeard: 50, isFavorite: true }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ]);
    expect((merged.nodes[0] as any).isFavorite).toBe(true);
  });

  it('keeps distinct nodes from different sources', () => {
    const merged = mergeUnifiedSourceData([
      { nodes: [{ nodeNum: 1, lastHeard: 100 }], traceroutes: [], neighborInfo: [], channels: [] },
      { nodes: [{ nodeNum: 2, lastHeard: 100 }], traceroutes: [], neighborInfo: [], channels: [] },
    ]);
    expect(merged.nodes).toHaveLength(2);
  });

  it('skips records missing a numeric nodeNum', () => {
    const merged = mergeUnifiedSourceData([
      {
        nodes: [{ nodeNum: 1, lastHeard: 100 }, { lastHeard: 100 }, null as any, { nodeNum: 'bad', lastHeard: 100 }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ]);
    expect(merged.nodes).toHaveLength(1);
  });

  it('concatenates traceroutes and neighborInfo across sources', () => {
    const merged = mergeUnifiedSourceData([
      { nodes: [], traceroutes: [{ id: 't1' }], neighborInfo: [{ id: 'n1' }], channels: [] },
      { nodes: [], traceroutes: [{ id: 't2' }], neighborInfo: [{ id: 'n2' }], channels: [] },
    ]);
    expect(merged.traceroutes).toEqual([{ id: 't1' }, { id: 't2' }]);
    expect(merged.neighborInfo).toEqual([{ id: 'n1' }, { id: 'n2' }]);
  });

  it('takes channels from the first source that has any', () => {
    const merged = mergeUnifiedSourceData([
      { nodes: [], traceroutes: [], neighborInfo: [], channels: [] },
      { nodes: [], traceroutes: [], neighborInfo: [], channels: [{ id: 0, name: 'LongFast' }] },
      { nodes: [], traceroutes: [], neighborInfo: [], channels: [{ id: 1, name: 'Other' }] },
    ]);
    expect(merged.channels).toEqual([{ id: 0, name: 'LongFast' }]);
  });

  it('attaches a deduped sources list (id/name/protocol) to each merged node', () => {
    const merged = mergeUnifiedSourceData([
      {
        sourceId: 'src-1',
        sourceName: 'Tower Alpha',
        protocol: 'Meshtastic',
        nodes: [{ nodeNum: 500, lastHeard: 100 }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
      {
        sourceId: 'src-2',
        sourceName: 'Core Bravo',
        protocol: 'MeshCore',
        nodes: [{ nodeNum: 500, lastHeard: 200 }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ]);
    expect(merged.nodes).toHaveLength(1);
    expect((merged.nodes[0] as any).sources).toEqual([
      { sourceId: 'src-1', sourceName: 'Tower Alpha', protocol: 'Meshtastic' },
      { sourceId: 'src-2', sourceName: 'Core Bravo', protocol: 'MeshCore' },
    ]);
  });

  it('omits the sources list when source metadata is not supplied', () => {
    const merged = mergeUnifiedSourceData([
      { nodes: [{ nodeNum: 600, lastHeard: 100 }], traceroutes: [], neighborInfo: [], channels: [] },
    ]);
    expect((merged.nodes[0] as any).sources).toBeUndefined();
  });

  it('merges a MeshCore node across sources by publicKey (not the source-scoped nodeId)', () => {
    // Regression: the server builds MeshCore nodeId as `mc:<sourceId>:<pubkey>`,
    // so the same physical contact heard by two sources had two different
    // nodeIds and never merged — always showing "seen by 1 source". Keying on
    // publicKey must collapse them into one node listing both sources.
    const PUBKEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const merged = mergeUnifiedSourceData([
      {
        sourceId: 'mc-1',
        sourceName: 'Core One',
        protocol: 'MeshCore',
        nodes: [{
          isMeshCore: true,
          nodeNum: 0,
          nodeId: `mc:mc-1:${PUBKEY.substring(0, 12)}`,
          publicKey: PUBKEY,
          lastHeard: 100,
          longName: 'Repeater',
        }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
      {
        sourceId: 'mc-2',
        sourceName: 'Core Two',
        protocol: 'MeshCore',
        nodes: [{
          isMeshCore: true,
          nodeNum: 0,
          nodeId: `mc:mc-2:${PUBKEY.substring(0, 12)}`,
          publicKey: PUBKEY,
          lastHeard: 200,
          longName: 'Repeater',
        }],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ]);
    expect(merged.nodes).toHaveLength(1);
    expect((merged.nodes[0] as any).sources).toEqual([
      { sourceId: 'mc-1', sourceName: 'Core One', protocol: 'MeshCore' },
      { sourceId: 'mc-2', sourceName: 'Core Two', protocol: 'MeshCore' },
    ]);
  });

  it('attaches a union of transport classes across sources (additive map filter)', () => {
    // Same node heard via RF (LORA=1) on source 1 and MQTT (5) on source 2.
    // The whole-record merge keeps the newest transportMechanism (MQTT), but
    // transportClasses must list BOTH so "Show RF" keeps the node visible.
    const merged = mergeUnifiedSourceData([
      {
        sourceId: 's1', sourceName: 'Direct', protocol: 'Meshtastic',
        nodes: [{ nodeNum: 700, lastHeard: 100, transportMechanism: 1 }],
        traceroutes: [], neighborInfo: [], channels: [],
      },
      {
        sourceId: 's2', sourceName: 'MQTT Bridge', protocol: 'Meshtastic',
        nodes: [{ nodeNum: 700, lastHeard: 200, transportMechanism: 5 }],
        traceroutes: [], neighborInfo: [], channels: [],
      },
    ]);
    expect(merged.nodes).toHaveLength(1);
    const classes = (merged.nodes[0] as any).transportClasses;
    expect([...classes].sort()).toEqual(['mqtt', 'rf']);
  });

  it('keeps distinct MeshCore nodes (different publicKeys) separate', () => {
    const merged = mergeUnifiedSourceData([
      {
        sourceId: 'mc-1',
        sourceName: 'Core One',
        protocol: 'MeshCore',
        nodes: [
          { isMeshCore: true, nodeNum: 0, nodeId: 'mc:mc-1:aaaaaaaaaaaa', publicKey: 'aaaa', lastHeard: 100 },
          { isMeshCore: true, nodeNum: 0, nodeId: 'mc:mc-1:bbbbbbbbbbbb', publicKey: 'bbbb', lastHeard: 100 },
        ],
        traceroutes: [],
        neighborInfo: [],
        channels: [],
      },
    ]);
    expect(merged.nodes).toHaveLength(2);
  });
});

describe('useDashboardUnifiedData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const unifiedSources: DashboardSource[] = [
    { id: 'src-1', name: 'Source One', type: 'meshtastic_tcp', enabled: true },
    { id: 'src-2', name: 'Source Two', type: 'meshcore', enabled: true },
  ];

  it('returns empty defaults without fetching when disabled', async () => {
    const { result } = renderHook(
      () => useDashboardUnifiedData(unifiedSources, false),
      { wrapper: createWrapper() },
    );

    // Give React a tick to settle effects
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.nodes).toEqual([]);
    expect(result.current.traceroutes).toEqual([]);
    expect(result.current.neighborInfo).toEqual([]);
    expect(result.current.channels).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('returns empty defaults when no sources are provided even if enabled', async () => {
    const { result } = renderHook(() => useDashboardUnifiedData([], true), {
      wrapper: createWrapper(),
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.nodes).toEqual([]);
  });

  it('fetches the whole unified view in ONE request and merges deduped nodes (#3735)', async () => {
    // The unified hook now hits a single bundled endpoint that returns one
    // per-source bundle each. The same nodeNum is heard by both sources, so the
    // merge should keep the freshest entry.
    mockFetch.mockImplementation((url: string) => {
      const respond = (data: unknown) =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
      if (url.includes('/api/unified/dashboard')) {
        return respond([
          {
            sourceId: 'src-1',
            nodes: [{ nodeNum: 42, lastHeard: 100, longName: 'Old' }],
            traceroutes: [{ id: 'tr-1' }],
            neighborInfo: [{ id: 'ni-1' }],
            channels: [{ id: 0, name: 'LongFast' }],
          },
          {
            sourceId: 'src-2',
            nodes: [{ nodeNum: 42, lastHeard: 200, longName: 'New' }],
            traceroutes: [{ id: 'tr-2' }],
            neighborInfo: [],
            channels: [],
          },
        ]);
      }
      return respond([]);
    });

    const { result } = renderHook(
      () => useDashboardUnifiedData(unifiedSources, true),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // One request for the whole view, scoped to the source list.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/api/unified/dashboard?sources=');
    expect(mockFetch.mock.calls[0][0]).toContain('src-1');
    expect(mockFetch.mock.calls[0][0]).toContain('src-2');
    expect(result.current.nodes).toHaveLength(1);
    expect((result.current.nodes[0] as any).longName).toBe('New');
    expect(result.current.traceroutes).toEqual([{ id: 'tr-1' }, { id: 'tr-2' }]);
    expect(result.current.neighborInfo).toEqual([{ id: 'ni-1' }]);
    expect(result.current.channels).toEqual([{ id: 0, name: 'LongFast' }]);
    // Node 42 was heard by both sources — both should be listed with the
    // protocol derived from each source's type.
    expect((result.current.nodes[0] as any).sources).toEqual([
      { sourceId: 'src-1', sourceName: 'Source One', protocol: 'Meshtastic' },
      { sourceId: 'src-2', sourceName: 'Source Two', protocol: 'MeshCore' },
    ]);
  });
});
