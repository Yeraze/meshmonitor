/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useWidgetMode } from './useWidgetMode';

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

describe('useWidgetMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty modes from backend
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    }));
    mockCsrfFetch.mockResolvedValue({ ok: true });
  });

  it('returns chart as default mode when backend has no data', async () => {
    const { result } = renderHook(() => useWidgetMode('node1', 'temperature'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toBe('chart'));
  });

  it('returns mode from backend settings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        telemetryWidgetModes: JSON.stringify({ 'node1_temperature': 'gauge' }),
      }),
    }));
    const { result } = renderHook(() => useWidgetMode('node1', 'temperature'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toBe('gauge'));
  });

  it('calls backend when mode is changed', async () => {
    const { result } = renderHook(() => useWidgetMode('node1', 'temperature'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toBe('chart'));

    act(() => {
      result.current[1]('numeric');
    });

    await waitFor(() => expect(mockCsrfFetch).toHaveBeenCalledWith(
      '/api/settings',
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('optimistically updates mode before backend response', async () => {
    mockCsrfFetch.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ ok: true }), 100)));
    const { result } = renderHook(() => useWidgetMode('node1', 'temperature'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current[0]).toBe('chart'));

    act(() => {
      result.current[1]('gauge');
    });

    await waitFor(() => expect(result.current[0]).toBe('gauge'));
  });

  it('uses separate keys per nodeId and type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        telemetryWidgetModes: JSON.stringify({ 'node1_temperature': 'gauge' }),
      }),
    }));
    const wrapper = createWrapper();
    const { result: r1 } = renderHook(() => useWidgetMode('node1', 'temperature'), { wrapper });
    const { result: r2 } = renderHook(() => useWidgetMode('node2', 'temperature'), { wrapper });

    await waitFor(() => {
      expect(r1.current[0]).toBe('gauge');
      expect(r2.current[0]).toBe('chart');
    });
  });
});
