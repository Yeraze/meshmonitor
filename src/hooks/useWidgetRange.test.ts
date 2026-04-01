/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useWidgetRange, DEFAULT_GAUGE_RANGES } from './useWidgetRange';

const mockCsrfFetch = vi.fn();

vi.mock('./useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useWidgetRange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    mockCsrfFetch.mockResolvedValue({ ok: true });
  });

  it('returns default range for known type (batteryLevel)', async () => {
    const { result } = renderHook(() => useWidgetRange('node1', 'batteryLevel'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toEqual({ min: 0, max: 100 }));
  });

  it('returns default range for known type (temperature)', async () => {
    const { result } = renderHook(() => useWidgetRange('node1', 'temperature'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toEqual(DEFAULT_GAUGE_RANGES.temperature));
  });

  it('returns fallback [0,100] for unknown type', async () => {
    const { result } = renderHook(() => useWidgetRange('node1', 'unknownMetric'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toEqual({ min: 0, max: 100 }));
  });

  it('returns range from backend settings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        telemetryWidgetRanges: JSON.stringify({ 'node1_temperature': { min: -40, max: 85 } }),
      }),
    }));
    const { result } = renderHook(() => useWidgetRange('node1', 'temperature'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toEqual({ min: -40, max: 85 }));
  });

  it('calls backend when range is changed', async () => {
    const { result } = renderHook(() => useWidgetRange('node1', 'temperature'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toEqual(DEFAULT_GAUGE_RANGES.temperature));

    act(() => {
      result.current[1]({ min: -40, max: 85 });
    });

    await waitFor(() => expect(mockCsrfFetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('optimistically updates range before backend response', async () => {
    mockCsrfFetch.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 100)));
    const { result } = renderHook(() => useWidgetRange('node1', 'temperature'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toEqual(DEFAULT_GAUGE_RANGES.temperature));

    act(() => {
      result.current[1]({ min: -40, max: 85 });
    });

    await waitFor(() => expect(result.current[0]).toEqual({ min: -40, max: 85 }));
  });
});
