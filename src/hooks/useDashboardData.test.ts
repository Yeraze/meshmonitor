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

  it('fetches all data for a valid sourceId', async () => {
    const mockNodes = [{ num: 1, id: '!abc' }, { num: 2, id: '!def' }];
    const mockTraceroutes = [{ id: 10, fromNodeNum: 1, toNodeNum: 2 }];
    const mockNeighborInfo = [{ nodeId: '!abc', neighbors: [] }];
    const mockChannels = [{ index: 0, name: 'Primary' }];

    // The hook fires 5 parallel queries — provide responses for each.
    // useQuery fires them in insertion order: nodes, traceroutes, neighborInfo, status, channels
    mockFetchJson(mockNodes);
    mockFetchJson(mockTraceroutes);
    mockFetchJson(mockNeighborInfo);
    mockFetchJson(mockStatus);
    mockFetchJson(mockChannels);

    const { result } = renderHook(() => useDashboardSourceData('src-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(5);

    // Verify at least some expected URLs were called
    const calledUrls = mockFetch.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledUrls).toContain('/meshmonitor/api/sources/src-1/nodes');
    expect(calledUrls).toContain('/meshmonitor/api/sources/src-1/traceroutes');
    expect(calledUrls).toContain('/meshmonitor/api/sources/src-1/neighbor-info');
    expect(calledUrls).toContain('/meshmonitor/api/sources/src-1/status');
    expect(calledUrls).toContain('/meshmonitor/api/sources/src-1/channels');

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
});

describe('useDashboardUnifiedData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty defaults without fetching when disabled', async () => {
    const { result } = renderHook(
      () => useDashboardUnifiedData(['src-1', 'src-2'], false),
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

  it('fans out 4 fetches per source when enabled and merges deduped nodes', async () => {
    // For each source we expect 4 endpoints: nodes, traceroutes, neighbor-info, channels.
    // Returns whatever shape the URL implies; the same nodeNum is heard by both sources
    // so the merge should keep the freshest entry.
    mockFetch.mockImplementation((url: string) => {
      const respond = (data: unknown) =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
      if (url.endsWith('/sources/src-1/nodes')) return respond([{ nodeNum: 42, lastHeard: 100, longName: 'Old' }]);
      if (url.endsWith('/sources/src-2/nodes')) return respond([{ nodeNum: 42, lastHeard: 200, longName: 'New' }]);
      if (url.endsWith('/sources/src-1/traceroutes')) return respond([{ id: 'tr-1' }]);
      if (url.endsWith('/sources/src-2/traceroutes')) return respond([{ id: 'tr-2' }]);
      if (url.endsWith('/sources/src-1/neighbor-info')) return respond([{ id: 'ni-1' }]);
      if (url.endsWith('/sources/src-2/neighbor-info')) return respond([]);
      if (url.endsWith('/sources/src-1/channels')) return respond([{ id: 0, name: 'LongFast' }]);
      if (url.endsWith('/sources/src-2/channels')) return respond([]);
      return respond([]);
    });

    const { result } = renderHook(
      () => useDashboardUnifiedData(['src-1', 'src-2'], true),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // 2 sources × 4 endpoints = 8 fetches
    expect(mockFetch).toHaveBeenCalledTimes(8);
    expect(result.current.nodes).toHaveLength(1);
    expect((result.current.nodes[0] as any).longName).toBe('New');
    expect(result.current.traceroutes).toEqual([{ id: 'tr-1' }, { id: 'tr-2' }]);
    expect(result.current.neighborInfo).toEqual([{ id: 'ni-1' }]);
    expect(result.current.channels).toEqual([{ id: 0, name: 'LongFast' }]);
  });
});
