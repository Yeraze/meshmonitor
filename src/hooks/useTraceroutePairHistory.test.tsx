/**
 * @vitest-environment jsdom
 *
 * useTraceroutePairHistory (Statistical Route epic, phase 2 — SR_PHASE2_SPEC.md
 * §3.3/§4.1). Mirrors useNodeTraceroutes's conventions: query key shape,
 * staleTime 60s, gcTime 5min, refetchOnWindowFocus false, and enabled gating
 * via useResolvedSourceId (undefined while the fallback source list loads).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  useTraceroutePairHistory,
  toAggregateRows,
  PAIR_HISTORY_LIMIT,
} from './useTraceroutePairHistory';
import type { TracerouteHistoryEntry } from '../services/api';

const getTracerouteHistoryMock = vi.fn();

vi.mock('../services/api', () => ({
  default: {
    getTracerouteHistory: (...args: unknown[]) => getTracerouteHistoryMock(...args),
  },
}));

let resolvedSourceId: string | undefined = 'src-a';
vi.mock('./useResolvedSourceId', () => ({
  useResolvedSourceId: () => resolvedSourceId,
}));

function makeRow(overrides: Partial<TracerouteHistoryEntry> = {}): TracerouteHistoryEntry {
  return {
    id: 1,
    timestamp: 1000,
    fromNodeNum: 111,
    toNodeNum: 222,
    fromNodeId: '!0000006f',
    toNodeId: '!000000de',
    route: '[300]',
    routeBack: '[300]',
    snrTowards: '[40]',
    snrBack: '[32]',
    channel: 0,
    hopCount: 1,
    createdAt: 1000,
    ...overrides,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useTraceroutePairHistory', () => {
  beforeEach(() => {
    getTracerouteHistoryMock.mockReset();
    getTracerouteHistoryMock.mockResolvedValue([makeRow()]);
    resolvedSourceId = 'src-a';
  });

  it('calls getTracerouteHistory(from, to, 200, sourceId) — D17 limit', async () => {
    const { result } = renderHook(() => useTraceroutePairHistory(111, 222), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getTracerouteHistoryMock).toHaveBeenCalledWith(111, 222, PAIR_HISTORY_LIMIT, 'src-a');
  });

  it('does not fire while useResolvedSourceId() returns undefined', async () => {
    resolvedSourceId = undefined;
    const { result } = renderHook(() => useTraceroutePairHistory(111, 222), { wrapper });

    // Give any pending microtasks a chance to run.
    await Promise.resolve();

    expect(getTracerouteHistoryMock).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('does not fire when fromNodeNum is null', async () => {
    renderHook(() => useTraceroutePairHistory(null, 222), { wrapper });
    await Promise.resolve();

    expect(getTracerouteHistoryMock).not.toHaveBeenCalled();
  });

  it('does not fire when toNodeNum is null', async () => {
    renderHook(() => useTraceroutePairHistory(111, null), { wrapper });
    await Promise.resolve();

    expect(getTracerouteHistoryMock).not.toHaveBeenCalled();
  });

  it('does not fire when fromNodeNum equals toNodeNum', async () => {
    renderHook(() => useTraceroutePairHistory(111, 111), { wrapper });
    await Promise.resolve();

    expect(getTracerouteHistoryMock).not.toHaveBeenCalled();
  });

  it('does not fire when opts.enabled is false, even with everything else resolved', async () => {
    renderHook(() => useTraceroutePairHistory(111, 222, { enabled: false }), { wrapper });
    await Promise.resolve();

    expect(getTracerouteHistoryMock).not.toHaveBeenCalled();
  });

  it('keys the query by sourceId + both node numbers + limit — two different pairs do not share a cache entry', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const localWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result: resultA } = renderHook(() => useTraceroutePairHistory(111, 222), {
      wrapper: localWrapper,
    });
    await waitFor(() => expect(resultA.current.isSuccess).toBe(true));

    const { result: resultB } = renderHook(() => useTraceroutePairHistory(111, 333), {
      wrapper: localWrapper,
    });
    await waitFor(() => expect(resultB.current.isSuccess).toBe(true));

    expect(getTracerouteHistoryMock).toHaveBeenCalledTimes(2);
    expect(getTracerouteHistoryMock).toHaveBeenNthCalledWith(1, 111, 222, PAIR_HISTORY_LIMIT, 'src-a');
    expect(getTracerouteHistoryMock).toHaveBeenNthCalledWith(2, 111, 333, PAIR_HISTORY_LIMIT, 'src-a');
  });

  it('opts.limit overrides PAIR_HISTORY_LIMIT', async () => {
    const { result } = renderHook(() => useTraceroutePairHistory(111, 222, { limit: 30 }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getTracerouteHistoryMock).toHaveBeenCalledWith(111, 222, 30, 'src-a');
  });

  it('rows keeps a stable identity across a re-render with unchanged data', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const localWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result, rerender } = renderHook(() => useTraceroutePairHistory(111, 222), {
      wrapper: localWrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const firstRows = result.current.rows;
    rerender();

    expect(result.current.rows).toBe(firstRows);
  });

  describe('toAggregateRows', () => {
    it('coerces string-typed fromNodeNum/toNodeNum/timestamp (the PG/MySQL BIGINT shape) to numbers', () => {
      const rows = toAggregateRows([
        makeRow({
          id: '5' as unknown as number,
          fromNodeNum: '111' as unknown as number,
          toNodeNum: '222' as unknown as number,
          timestamp: '1700000000' as unknown as number,
        }),
      ]);

      expect(rows).toEqual([
        expect.objectContaining({
          id: 5,
          fromNodeNum: 111,
          toNodeNum: 222,
          timestamp: 1700000000,
        }),
      ]);
      expect(typeof rows[0].fromNodeNum).toBe('number');
      expect(typeof rows[0].toNodeNum).toBe('number');
      expect(typeof rows[0].timestamp).toBe('number');
    });

    it('normalizes absent route/routeBack/snrBack to null', () => {
      const rows = toAggregateRows([
        makeRow({
          route: undefined as unknown as string,
          routeBack: undefined as unknown as string,
          snrBack: undefined as unknown as string,
        }),
      ]);

      expect(rows[0].route).toBeNull();
      expect(rows[0].routeBack).toBeNull();
      expect(rows[0].snrBack).toBeNull();
    });
  });
});
