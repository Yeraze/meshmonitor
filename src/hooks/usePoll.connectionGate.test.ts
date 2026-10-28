/**
 * usePoll's observers stop re-reading the full poll while App's source is not
 * connected (App's connection check owns that state), and poll as before when
 * it is connected or when there is no DataProvider.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { usePoll } from './usePoll';
import { DataProvider, useData } from '../contexts/DataContext';

vi.mock('../init', () => ({ appBasename: '' }));

const mockFetch = vi.fn();
vi.mock('./useCsrfFetch', () => ({ useCsrfFetch: () => mockFetch }));
vi.mock('../contexts/WebSocketContext', () => ({ useWebSocketConnected: () => false }));

function wrapper(withData: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    const inner = withData ? createElement(DataProvider, null, children) : children;
    return createElement(QueryClientProvider, { client: qc }, inner);
  };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('usePoll connection gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ nodes: [] }) } as Response),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads once on mount and then not on a timer while the source is not connected', async () => {
    // DataProvider starts at 'disconnected'.
    renderHook(() => usePoll(), { wrapper: wrapper(true) });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await advance(60000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('polls every 5 s (no socket) once App reports connected', async () => {
    const { result } = renderHook(() => ({ poll: usePoll(), data: useData() }), { wrapper: wrapper(true) });
    await advance(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    act(() => result.current.data.setConnectionStatus('connected'));
    await advance(5000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await advance(5000);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    act(() => result.current.data.setConnectionStatus('disconnected'));
    await advance(30000);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('polls as before outside a DataProvider', async () => {
    renderHook(() => usePoll(), { wrapper: wrapper(false) });
    await advance(0);
    await advance(10000);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
