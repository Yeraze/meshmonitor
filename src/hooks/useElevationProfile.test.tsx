/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useElevationProfile } from './useElevationProfile';
import apiService from '../services/api';
import type { LinkEndpoint } from '../utils/linkProfile';
import type { ElevationProfile } from '../types/elevation';

vi.mock('../services/api', () => ({
  default: {
    getElevationProfile: vi.fn(),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const pointA: LinkEndpoint = { id: 'a', lat: 40.0, lng: -105.0, isNode: true };
const pointB: LinkEndpoint = { id: 'b', lat: 40.3, lng: -104.7, isNode: false };

const profile: ElevationProfile = {
  distanceMeters: 33300,
  provider: 'terrarium',
  samples: [
    { distance: 0, lat: 40.0, lng: -105.0, elevation: 1500 },
    { distance: 33300, lat: 40.3, lng: -104.7, elevation: 1520 },
  ],
};

describe('useElevationProfile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT fetch when either endpoint is undefined', () => {
    vi.mocked(apiService.getElevationProfile).mockResolvedValue(profile);
    renderHook(() => useElevationProfile(pointA, undefined), { wrapper });
    expect(apiService.getElevationProfile).not.toHaveBeenCalled();
  });

  it('fetches once both endpoints are set', async () => {
    vi.mocked(apiService.getElevationProfile).mockResolvedValue(profile);
    const { result } = renderHook(() => useElevationProfile(pointA, pointB), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(profile));
    expect(apiService.getElevationProfile).toHaveBeenCalledWith(
      { lat: pointA.lat, lng: pointA.lng },
      { lat: pointB.lat, lng: pointB.lng },
    );
  });

  it('does not refetch when endpoint objects are recreated with the same rounded coords', async () => {
    vi.mocked(apiService.getElevationProfile).mockResolvedValue(profile);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const localWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result, rerender } = renderHook(
      ({ a, b }: { a: LinkEndpoint; b: LinkEndpoint }) => useElevationProfile(a, b),
      { wrapper: localWrapper, initialProps: { a: pointA, b: pointB } },
    );
    await waitFor(() => expect(result.current.data).toEqual(profile));
    expect(apiService.getElevationProfile).toHaveBeenCalledTimes(1);

    // New object identities, same lat/lng values -> same query key -> no refetch.
    rerender({ a: { ...pointA }, b: { ...pointB } });
    await waitFor(() => expect(result.current.data).toEqual(profile));
    expect(apiService.getElevationProfile).toHaveBeenCalledTimes(1);
  });
});
