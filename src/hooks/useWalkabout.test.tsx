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
const mapApi: { cells?: (...a: unknown[]) => unknown; cellNodes?: (...a: unknown[]) => unknown; track?: (...a: unknown[]) => unknown } = {};
vi.mock('../services/walkaboutApi', async (importActual) => ({
  walkaboutMapParams: ((await importActual()) as typeof import('../services/walkaboutApi')).walkaboutMapParams,
  fetchWalkaboutCells: (...a: unknown[]) => mapApi.cells?.(...a),
  fetchWalkaboutCellNodes: (...a: unknown[]) => mapApi.cellNodes?.(...a),
  fetchWalkaboutTrack: (...a: unknown[]) => mapApi.track?.(...a),
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
  useDeleteWalkabout,
  walkaboutKeys,
  useWalkaboutCells,
  useWalkaboutCellNodes,
  useWalkaboutTrack,
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

describe('useWalkabout map hooks (#5891 P2)', () => {
  const cellsFetch = vi.fn();
  const nodesFetch = vi.fn();
  const trackFetch = vi.fn();

  it('keys hold res and the preset, session or since/until, never a clock', () => {
    expect(walkaboutKeys.cells('a', { kind: 'window', window: '7d' }, 9)).toEqual([
      'walkabout', 'a', 'cells', { window: '7d' }, 9,
    ]);
    expect(walkaboutKeys.cells('a', { kind: 'session', sessionId: 's1', node: '!ab' }, 8)).toEqual([
      'walkabout', 'a', 'cells', { sessionId: 's1', node: '!ab' }, 8,
    ]);
    expect(walkaboutKeys.cells('a', { kind: 'range', sinceMs: 1, untilMs: 2 }, 7)).toEqual([
      'walkabout', 'a', 'cells', { since: '1', until: '2' }, 7,
    ]);
    expect(walkaboutKeys.cellNodes('a', { kind: 'window', window: '24h' }, 'c1')).toEqual([
      'walkabout', 'a', 'cell-nodes', { window: '24h' }, 'c1',
    ]);
    expect(walkaboutKeys.track('a', 's1')).toEqual(['walkabout', 'a', 'track', 's1']);
  });

  it('cellNodes and track stay disabled without a cell or session', async () => {
    nodesFetch.mockResolvedValue({});
    trackFetch.mockResolvedValue({});
    mapApi.cellNodes = nodesFetch;
    mapApi.track = trackFetch;
    const q = { kind: 'window', window: '7d' } as const;
    renderHook(() => useWalkaboutCellNodes('a', q, null), { wrapper });
    renderHook(() => useWalkaboutTrack('a', null), { wrapper });
    await new Promise((r) => setTimeout(r, 10));
    expect(nodesFetch).not.toHaveBeenCalled();
    expect(trackFetch).not.toHaveBeenCalled();
  });

  it('keeps old cells across a res change but not across a window change; never polls', async () => {
    cellsFetch.mockImplementation(async (_s: string, _q: unknown, res: number) => ({ res, cells: [] }));
    mapApi.cells = cellsFetch;
    const w7 = { kind: 'window', window: '7d' } as const;
    const w24 = { kind: 'window', window: '24h' } as const;
    const { result, rerender } = renderHook(
      ({ q, res }: { q: typeof w7 | typeof w24; res: 7 | 8 | 9 }) => useWalkaboutCells('a', q, res),
      { wrapper, initialProps: { q: w7 as typeof w7 | typeof w24, res: 7 as 7 | 8 | 9 } },
    );
    await waitFor(() => expect(result.current.data?.res).toBe(7));

    let release!: () => void;
    cellsFetch.mockImplementationOnce(
      (_s: string, _q: unknown, res: number) => new Promise((r) => { release = () => r({ res, cells: [] }); }),
    );
    rerender({ q: w7, res: 9 });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data?.res).toBe(7);
    await act(async () => release());
    await waitFor(() => expect(result.current.data?.res).toBe(9));

    cellsFetch.mockImplementationOnce(() => new Promise(() => {}));
    rerender({ q: w24, res: 9 });
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.data).toBeUndefined();

    const opts = qc.getQueryCache().findAll({ queryKey: ['walkabout', 'a', 'cells'] })[0].options;
    expect(opts.refetchInterval).toBeUndefined();
    expect(opts.staleTime).toBe(60_000);
  });
});
