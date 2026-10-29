/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useConnectionCheckLoop } from './useConnectionCheckLoop';
import { fetchConnectionStatus, refreshPollCache } from './connectionCheck';

vi.mock('../init', () => ({ appBasename: '' }));

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Let resolved promises run without moving the clock. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

describe('useConnectionCheckLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('backs off 5 s, 10 s, 20 s, then every 30 s while the result stays the same', async () => {
    const check = vi.fn().mockResolvedValue('disconnected');
    renderHook(() => useConnectionCheckLoop({ shouldCheck: () => true, check }));

    await advance(4999);
    expect(check).toHaveBeenCalledTimes(0);
    await advance(1); // t=5s
    expect(check).toHaveBeenCalledTimes(1);
    await advance(5000); // t=10s: second check also 5 s after the first (nothing to compare yet)
    expect(check).toHaveBeenCalledTimes(2);
    await advance(9999);
    expect(check).toHaveBeenCalledTimes(2);
    await advance(1); // +10s
    expect(check).toHaveBeenCalledTimes(3);
    await advance(20000); // +20s
    expect(check).toHaveBeenCalledTimes(4);
    await advance(30000); // +30s
    expect(check).toHaveBeenCalledTimes(5);
    await advance(30000); // capped at 30s
    expect(check).toHaveBeenCalledTimes(6);
  });

  it('starts over at 5 s when the result changes', async () => {
    const results = ['disconnected', 'disconnected', 'disconnected', 'node-offline', 'node-offline'];
    const check = vi.fn().mockImplementation(() => Promise.resolve(results.shift() ?? 'node-offline'));
    renderHook(() => useConnectionCheckLoop({ shouldCheck: () => true, check }));

    await advance(5000); // #1
    await advance(5000); // #2 (same) -> next in 10s
    await advance(10000); // #3 (same) -> next in 20s
    expect(check).toHaveBeenCalledTimes(3);
    await advance(20000); // #4 changed -> next in 5s
    expect(check).toHaveBeenCalledTimes(4);
    await advance(5000); // #5
    expect(check).toHaveBeenCalledTimes(5);
  });

  it('does not check while shouldCheck is false (connected)', async () => {
    const check = vi.fn().mockResolvedValue('x');
    renderHook(() => useConnectionCheckLoop({ shouldCheck: () => false, check }));
    await advance(120000);
    expect(check).not.toHaveBeenCalled();
  });

  it('pauses while the tab is hidden and checks at once when it is visible again', async () => {
    const check = vi.fn().mockResolvedValue('disconnected');
    renderHook(() => useConnectionCheckLoop({ shouldCheck: () => true, check }));

    await advance(5000);
    expect(check).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await advance(10 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await flush();
    expect(check).toHaveBeenCalledTimes(2);
    // Delay starts over at 5 s.
    await advance(5000);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('stops on unmount', async () => {
    const check = vi.fn().mockResolvedValue('disconnected');
    const { unmount } = renderHook(() => useConnectionCheckLoop({ shouldCheck: () => true, check }));
    unmount();
    await advance(60000);
    expect(check).not.toHaveBeenCalled();
  });

  it('reads /api/connection while disconnected and the full /api/poll once when the source comes back', async () => {
    let up = false;
    const authFetch = vi.fn((url: string) => {
      if (url.startsWith('/api/connection')) {
        return Promise.resolve(jsonResponse({ connected: up, nodeResponsive: up, configuring: false, userDisconnected: false }));
      }
      return Promise.resolve(jsonResponse({ connection: { connected: up }, nodes: [] }));
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let connected = false;
    // Mirrors App.checkConnectionStatus: status from /api/connection, one
    // full poll on the transition to connected.
    const check = async () => {
      const status = await fetchConnectionStatus(authFetch, '', 'src-1');
      if (status.connected && status.nodeResponsive && !connected) {
        connected = true;
        await refreshPollCache(queryClient, authFetch, '', 'src-1');
      }
      return status.connected;
    };
    renderHook(() => useConnectionCheckLoop({ shouldCheck: () => !connected, check }));

    await advance(5000 + 5000 + 10000 + 20000); // four checks, all down
    const urls = () => authFetch.mock.calls.map(([u]) => u as string);
    expect(urls()).toHaveLength(4);
    expect(urls().every((u) => u === '/api/connection?sourceId=src-1')).toBe(true);

    up = true;
    await advance(30000);
    expect(urls().filter((u) => u.startsWith('/api/poll'))).toEqual(['/api/poll?sourceId=src-1']);

    await advance(120000); // connected: the loop makes no more requests
    expect(urls().filter((u) => u.startsWith('/api/poll'))).toHaveLength(1);
    expect(urls()).toHaveLength(6);
  });
});
