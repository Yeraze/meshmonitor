/**
 * @vitest-environment jsdom
 *
 * #5014 Phase 2 WP3 §7.4.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useObserverStatus } from './useObserverStatus';
import apiService from '../../../services/api';
import type { ObserverStatusResponse } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  default: {
    // ../../../hooks/useDashboardData imports ../init, which calls
    // api.setBaseUrl() at module load time — must exist on the mock too.
    setBaseUrl: vi.fn(),
    getObserverStatus: vi.fn(),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const makeStatus = (overrides: Partial<ObserverStatusResponse> = {}): ObserverStatusResponse => ({
  running: true,
  configured: true,
  authMode: 'token',
  keyStored: true,
  connected: true,
  publishes: 5,
  dropped: 0,
  lastPublishAt: 1000,
  lastError: null,
  tokenExpiresAt: null,
  brokers: [],
  ...overrides,
});

describe('useObserverStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls getObserverStatus once with the right source id and exposes status', async () => {
    vi.mocked(apiService.getObserverStatus).mockResolvedValue(makeStatus());
    const { result } = renderHook(() => useObserverStatus('src-1'), { wrapper });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(apiService.getObserverStatus).toHaveBeenCalledTimes(1);
    expect(apiService.getObserverStatus).toHaveBeenCalledWith('src-1');
    expect(result.current.status?.running).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('issues no request when enabled:false', async () => {
    vi.mocked(apiService.getObserverStatus).mockResolvedValue(makeStatus());
    const { result } = renderHook(() => useObserverStatus('src-1', { enabled: false }), { wrapper });
    // Give any accidental async work a chance to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(apiService.getObserverStatus).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
  });

  it('surfaces error and leaves status null on a rejected query (no retry storm)', async () => {
    vi.mocked(apiService.getObserverStatus).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useObserverStatus('src-1'), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.status).toBeNull();
    expect(result.current.error?.message).toBe('boom');
    // retry:false — exactly one attempt.
    expect(apiService.getObserverStatus).toHaveBeenCalledTimes(1);
  });
});
