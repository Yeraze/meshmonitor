/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useSkyView } from './useSkyView';
import apiService, { type SkyViewResult } from '../services/api';

vi.mock('../services/api', () => ({
  default: {
    getSkyView: vi.fn(),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const result: SkyViewResult = {
  satellites: [
    { name: 'G01', azDeg: 12, elDeg: 70, rangeKm: 20200 },
    { name: 'G02', azDeg: 200, elDeg: 30, rangeKm: 21000 },
  ],
  dop: { gdop: 2.4, pdop: 2.1, hdop: 1.2, vdop: 1.7 },
  visibleCount: 2,
};

describe('useSkyView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT fetch when observer is undefined', () => {
    vi.mocked(apiService.getSkyView).mockResolvedValue(result);
    renderHook(() => useSkyView(undefined), { wrapper });
    expect(apiService.getSkyView).not.toHaveBeenCalled();
  });

  it('does NOT fetch when disabled', () => {
    vi.mocked(apiService.getSkyView).mockResolvedValue(result);
    renderHook(() => useSkyView({ lat: 40, lon: -105 }, { enabled: false }), { wrapper });
    expect(apiService.getSkyView).not.toHaveBeenCalled();
  });

  it('reads body.data and surfaces satellites, dop, and visibleCount', async () => {
    vi.mocked(apiService.getSkyView).mockResolvedValue(result);
    const { result: hook } = renderHook(
      () => useSkyView({ lat: 40, lon: -105 }),
      { wrapper },
    );
    await waitFor(() => expect(hook.current.visibleCount).toBe(2));
    expect(hook.current.satellites).toEqual(result.satellites);
    expect(hook.current.dop).toEqual(result.dop);
    expect(apiService.getSkyView).toHaveBeenCalledWith({ lat: 40, lon: -105 });
  });

  it('passes optional mask/constellations through to the API', async () => {
    vi.mocked(apiService.getSkyView).mockResolvedValue(result);
    renderHook(
      () => useSkyView({ lat: 1, lon: 2 }, { elevationMaskDeg: 10, constellations: ['GPS'] }),
      { wrapper },
    );
    await waitFor(() =>
      expect(apiService.getSkyView).toHaveBeenCalledWith({
        lat: 1,
        lon: 2,
        elevationMaskDeg: 10,
        constellations: ['GPS'],
      }),
    );
  });

  it('surfaces the error and an empty satellite list on failure', async () => {
    vi.mocked(apiService.getSkyView).mockRejectedValue(new Error('TLE_UNAVAILABLE'));
    const { result: hook } = renderHook(
      () => useSkyView({ lat: 40, lon: -105 }),
      { wrapper },
    );
    await waitFor(() => expect(hook.current.error).toBeInstanceOf(Error));
    expect(hook.current.satellites).toEqual([]);
    expect(hook.current.visibleCount).toBeNull();
  });
});
