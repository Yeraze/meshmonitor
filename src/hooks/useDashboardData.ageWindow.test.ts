/**
 * `ageWindow` option on the dashboard data hooks: the request asks the server
 * for the age cut only when the caller opts in (DashboardPage), and the
 * single-source hook passes through the server's uncut `nodeCount`.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useDashboardSourceData, useDashboardUnifiedData } from './useDashboardData';

vi.mock('../init', () => ({ appBasename: '/meshmonitor' }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: true, user: { isAdmin: true } } }),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function respond(url: string) {
  if (url.includes('/status')) return { sourceId: 'src-1', sourceName: 'S', sourceType: 'tcp', connected: true };
  if (url.includes('/unified/dashboard')) {
    return [{ sourceId: 'src-1', nodes: [{ nodeNum: 1 }], traceroutes: [], neighborInfo: [], channels: [], nodeCount: 9 }];
  }
  return { sourceId: 'src-1', nodes: [{ nodeNum: 1 }], traceroutes: [], neighborInfo: [], channels: [], ...(url.includes('ageWindow') ? { nodeCount: 9 } : {}) };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(respond(url)) }),
  );
});

const urls = () => mockFetch.mock.calls.map((c: unknown[]) => String(c[0]));

describe('dashboard hooks: ageWindow', () => {
  it('single source: no flag, no cut requested and no nodeCount', async () => {
    const { result } = renderHook(() => useDashboardSourceData('src-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(urls()).toContain('/meshmonitor/api/sources/src-1/dashboard');
    expect(result.current.nodeCount).toBeUndefined();
  });

  it('single source: ageWindow asks for the cut and passes nodeCount through', async () => {
    const { result } = renderHook(() => useDashboardSourceData('src-1', { ageWindow: true }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(urls()).toContain('/meshmonitor/api/sources/src-1/dashboard?ageWindow=settings');
    expect(result.current.nodeCount).toBe(9);
    expect(result.current.nodes).toEqual([{ nodeNum: 1 }]);
  });

  it('unified: the flag is added only when asked for', async () => {
    const plain = renderHook(() => useDashboardUnifiedData(['src-1'], true), { wrapper: createWrapper() });
    await waitFor(() => expect(plain.result.current.nodes.length).toBe(1));
    expect(urls()).toContain('/meshmonitor/api/unified/dashboard?sources=src-1');

    mockFetch.mockClear();
    const cut = renderHook(() => useDashboardUnifiedData(['src-1'], true, { ageWindow: true }), { wrapper: createWrapper() });
    await waitFor(() => expect(cut.result.current.nodes.length).toBe(1));
    expect(urls()).toContain('/meshmonitor/api/unified/dashboard?sources=src-1&ageWindow=settings');
  });
});
