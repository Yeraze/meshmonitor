/**
 * Dashboard client perf contracts: auth-gated queries fire once, after auth
 * resolves; the unified merge is memoized and keeps unchanged nodes'
 * identities stable.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useDashboardUnifiedData,
  useSourceStatuses,
  mergeUnifiedSourceData,
  createUnifiedMergeCache,
  type DashboardSource,
  type UnifiedSourceBundle,
} from './useDashboardData';

vi.mock('../init', () => ({ appBasename: '/meshmonitor' }));

// Mutable auth state the hook reads on every render.
const authState: { authStatus: { authenticated: boolean } | null; loading: boolean } = {
  authStatus: null,
  loading: true,
};
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

const sources: DashboardSource[] = [
  { id: 'src-1', name: 'One', type: 'meshtastic_tcp', enabled: true },
  { id: 'src-2', name: 'Two', type: 'meshtastic_tcp', enabled: true },
];

const bundles = [
  { sourceId: 'src-1', nodes: [{ nodeNum: 1, lastHeard: 100 }], traceroutes: [], neighborInfo: [], channels: [] },
  { sourceId: 'src-2', nodes: [{ nodeNum: 2, lastHeard: 200 }], traceroutes: [], neighborInfo: [], channels: [] },
];

function urlsCalled(): string[] {
  return mockFetch.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(bundles) }),
  );
  authState.authStatus = null;
  authState.loading = true;
});

describe('auth gating', () => {
  it('does not fetch the unified dashboard until auth resolves, then fetches once', async () => {
    const wrapper = createWrapper();
    const { result, rerender } = renderHook(
      () => useDashboardUnifiedData(sources, true),
      { wrapper },
    );
    // Give any eager query a chance to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetch).not.toHaveBeenCalled();

    authState.authStatus = { authenticated: true };
    authState.loading = false;
    rerender();

    await waitFor(() => expect(result.current.nodes).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    const dashCalls = urlsCalled().filter((u) => u.includes('/api/unified/dashboard'));
    expect(dashCalls).toHaveLength(1);
  });

  it('does not fetch per-source status until auth resolves', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ sourceId: 'src-1', connected: true }) }),
    );
    const wrapper = createWrapper();
    const { rerender } = renderHook(() => useSourceStatuses(['src-1']), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetch).not.toHaveBeenCalled();

    authState.authStatus = { authenticated: false };
    authState.loading = false;
    rerender();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  });
});

describe('merge memoization', () => {
  it('returns the same nodes array across re-renders with a fresh sources array', async () => {
    authState.authStatus = { authenticated: true };
    authState.loading = false;
    const wrapper = createWrapper();
    const { result, rerender } = renderHook(
      // A new array (and new source objects) on every render, as DashboardPage passes.
      () => useDashboardUnifiedData(sources.map((s) => ({ ...s })), true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.nodes).toHaveLength(2));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.nodes).toBe(first.nodes);
  });

  it('reuses merged node objects whose input records did not change', () => {
    const r1 = { nodeNum: 1, lastHeard: 100 };
    const r2 = { nodeNum: 2, lastHeard: 200 };
    const bundle = (nodes: unknown[]): UnifiedSourceBundle => ({
      sourceId: 'src-1',
      sourceName: 'One',
      protocol: 'Meshtastic',
      nodes,
      traceroutes: [],
      neighborInfo: [],
      channels: [],
    });
    const cache = createUnifiedMergeCache();
    const a = mergeUnifiedSourceData([bundle([r1, r2])], cache);
    // Same records in a new outer array: every node and the array itself reused.
    const b = mergeUnifiedSourceData([bundle([r1, r2])], cache);
    expect(b.nodes).toBe(a.nodes);
    // One record changed: only that node is re-merged.
    const r2b = { nodeNum: 2, lastHeard: 300 };
    const c = mergeUnifiedSourceData([bundle([r1, r2b])], cache);
    expect(c.nodes).not.toBe(a.nodes);
    expect(c.nodes[0]).toBe(a.nodes[0]);
    expect(c.nodes[1]).not.toBe(a.nodes[1]);
    expect((c.nodes[1] as { lastHeard: number }).lastHeard).toBe(300);
  });

  it('merges the same as without a cache', () => {
    const perSource: UnifiedSourceBundle[] = [
      { sourceId: 'src-1', sourceName: 'One', protocol: 'Meshtastic', nodes: [{ nodeNum: 1, lastHeard: 100, longName: 'A' }], traceroutes: [], neighborInfo: [], channels: [] },
      { sourceId: 'src-2', sourceName: 'Two', protocol: 'Meshtastic', nodes: [{ nodeNum: 1, lastHeard: 200 }], traceroutes: [], neighborInfo: [], channels: [] },
    ];
    expect(mergeUnifiedSourceData(perSource, createUnifiedMergeCache())).toEqual(mergeUnifiedSourceData(perSource));
  });
});
