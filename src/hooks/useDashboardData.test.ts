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
