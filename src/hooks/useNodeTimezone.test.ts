/**
 * @vitest-environment jsdom
 *
 * useNodeTimezone / useSetNodeTimezone (#6523).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useNodeTimezone, useSetNodeTimezone, listTimeZones } from './useNodeTimezone';

vi.mock('./useResolvedSourceId', () => ({ useResolvedSourceId: () => 'src-fallback' }));
const csrfFetch = vi.fn();
vi.mock('./useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetch }));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children),
  };
}

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('useNodeTimezone', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the zone for the node on the given source', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      json(200, { success: true, data: { timeZone: 'America/Chicago', source: 'position' } }),
    );
    const { wrapper: w } = wrapper();
    const { result } = renderHook(() => useNodeTimezone({ baseUrl: '/mm', sourceId: 'src-a', nodeId: '!a1b2c3d4' }), { wrapper: w });
    await waitFor(() => expect(result.current.data).toEqual({ timeZone: 'America/Chicago', source: 'position' }));
    expect(global.fetch).toHaveBeenCalledWith('/mm/api/nodes/timezone?sourceId=src-a&nodeId=%21a1b2c3d4');
  });

  it('falls back to the resolved source, and gives null on a refusal', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(json(403, { success: false }));
    const { wrapper: w } = wrapper();
    const { result } = renderHook(() => useNodeTimezone({ baseUrl: '', nodeId: '!a1b2c3d4' }), { wrapper: w });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('sourceId=src-fallback');
  });

  it('does not fetch without a node', () => {
    const { wrapper: w } = wrapper();
    renderHook(() => useNodeTimezone({ sourceId: 'src-a', nodeId: null }), { wrapper: w });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('useSetNodeTimezone', () => {
  it('PUTs through the CSRF fetch and stores the answer', async () => {
    csrfFetch.mockResolvedValue(json(200, { success: true, data: { timeZone: 'Europe/Berlin', source: 'override' } }));
    global.fetch = vi.fn().mockResolvedValue(json(200, { success: true, data: { timeZone: 'Europe/Berlin', source: 'override' } }));
    const { wrapper: w, client } = wrapper();
    const { result } = renderHook(() => useSetNodeTimezone(''), { wrapper: w });
    await act(async () => {
      await result.current.mutateAsync({ sourceId: 'src-a', nodeId: '!a1b2c3d4', timeZone: 'Europe/Berlin' });
    });
    const [url, init] = csrfFetch.mock.calls[0];
    expect(url).toBe('/api/nodes/timezone');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ sourceId: 'src-a', nodeId: '!a1b2c3d4', timeZone: 'Europe/Berlin' });
    expect(client.getQueryData(['nodeTimezone', 'src-a', '!a1b2c3d4'])).toEqual({ timeZone: 'Europe/Berlin', source: 'override' });
  });

  it('throws the server error', async () => {
    csrfFetch.mockResolvedValue(json(400, { success: false, error: 'bad zone' }));
    const { wrapper: w } = wrapper();
    const { result } = renderHook(() => useSetNodeTimezone(''), { wrapper: w });
    await expect(result.current.mutateAsync({ sourceId: 'src-a', nodeId: '!a1b2c3d4', timeZone: 'Nope' })).rejects.toThrow('bad zone');
  });
});

describe('listTimeZones', () => {
  it('always offers UTC', () => {
    expect(listTimeZones()).toContain('UTC');
  });
});
