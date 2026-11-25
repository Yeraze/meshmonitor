/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const fetchSessions = vi.fn();
const fetchLive = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const del = vi.fn();
vi.mock('../services/walkaboutApi', () => ({
  fetchWalkaboutSessions: (...a: unknown[]) => fetchSessions(...a),
  fetchLiveWalkabout: (...a: unknown[]) => fetchLive(...a),
  startWalkabout: (...a: unknown[]) => start(...a),
  stopWalkabout: (...a: unknown[]) => stop(...a),
  deleteWalkabout: (...a: unknown[]) => del(...a),
}));
vi.mock('../services/api', () => ({ default: { get: vi.fn(), setBaseUrl: vi.fn() } }));

import {
  useWalkaboutSessions,
  useLiveWalkabout,
  useStartWalkabout,
  useStopWalkabout,
  useDeleteWalkabout,
  walkaboutKeys,
} from './useWalkabout';

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  vi.clearAllMocks();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  fetchSessions.mockResolvedValue([]);
  fetchLive.mockResolvedValue({ session: null, skipped: null });
  start.mockResolvedValue({ id: 's' });
  stop.mockResolvedValue({ id: 's' });
  del.mockResolvedValue(undefined);
});

describe('useWalkabout', () => {
  it('keys are per source', () => {
    expect(walkaboutKeys.sessions('a')).toEqual(['walkabout', 'a', 'sessions']);
    expect(walkaboutKeys.live('a')).toEqual(['walkabout', 'a', 'live']);
  });

  it('does not fetch without a source', () => {
    renderHook(() => useWalkaboutSessions(null), { wrapper });
    renderHook(() => useLiveWalkabout(null), { wrapper });
    expect(fetchSessions).not.toHaveBeenCalled();
    expect(fetchLive).not.toHaveBeenCalled();
  });

  it('fetches the list and live once, with no polling', async () => {
    const list = renderHook(() => useWalkaboutSessions('a'), { wrapper });
    const live = renderHook(() => useLiveWalkabout('a'), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess && live.result.current.isSuccess).toBe(true));
    expect(fetchSessions).toHaveBeenCalledWith('a');
    expect(fetchLive).toHaveBeenCalledWith('a');
    expect(live.result.current.fetchStatus).toBe('idle');
    expect(fetchLive).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['start', () => useStartWalkabout('a'), (m: { mutateAsync: (v?: string) => Promise<unknown> }) => m.mutateAsync('Loop'), start, ['a', 'Loop']],
    ['stop', () => useStopWalkabout('a'), (m: { mutateAsync: (v: string) => Promise<unknown> }) => m.mutateAsync('s1'), stop, ['a', 's1']],
    ['delete', () => useDeleteWalkabout('a'), (m: { mutateAsync: (v: string) => Promise<unknown> }) => m.mutateAsync('s1'), del, ['a', 's1']],
  ] as const)('%s invalidates the list and live keys', async (_n, hook, run, spy, args) => {
    const inv = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => (hook as () => never)(), { wrapper });
    await act(async () => { await (run as (m: unknown) => Promise<unknown>)(result.current); });
    expect(spy).toHaveBeenCalledWith(...args);
    const keys = inv.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(walkaboutKeys.sessions('a'));
    expect(keys).toContainEqual(walkaboutKeys.live('a'));
  });
});
