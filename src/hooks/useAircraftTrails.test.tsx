/**
 * @vitest-environment jsdom
 *
 * useAircraftTrails (#5364/#5365 Phase 3): TanStack Query over
 * ApiService.getAircraftTrails, off unless enabled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useAircraftTrails, aircraftTrailsQueryKey, AIRCRAFT_TRAILS_REFETCH_MS } from './useAircraftTrails';

const getAircraftTrails = vi.fn();
vi.mock('../services/api', () => ({
  default: { getAircraftTrails: (...args: unknown[]) => getAircraftTrails(...args) },
}));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

describe('useAircraftTrails', () => {
  beforeEach(() => {
    getAircraftTrails.mockReset();
  });

  it('does not fetch while disabled', async () => {
    const { result } = renderHook(() => useAircraftTrails({ enabled: false, hours: 6, sourceIds: ['a'] }), {
      wrapper: wrapper(),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(getAircraftTrails).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it('fetches with hours and sources when enabled', async () => {
    const trails = [{ sourceId: 'a', nodeNum: 1, points: [] }];
    getAircraftTrails.mockResolvedValue(trails);
    const { result } = renderHook(() => useAircraftTrails({ enabled: true, hours: 12, sourceIds: ['a'] }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data).toEqual(trails));
    expect(getAircraftTrails).toHaveBeenCalledWith(12, ['a']);
  });

  it('keys by hours and sorted sources', () => {
    expect(aircraftTrailsQueryKey(6, ['b', 'a'])).toEqual(aircraftTrailsQueryKey(6, ['a', 'b']));
    expect(aircraftTrailsQueryKey(6, null)).not.toEqual(aircraftTrailsQueryKey(12, null));
    expect(AIRCRAFT_TRAILS_REFETCH_MS).toBe(60_000);
  });
});
