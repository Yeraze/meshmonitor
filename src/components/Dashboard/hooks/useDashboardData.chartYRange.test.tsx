/**
 * @vitest-environment jsdom
 *
 * The dashboard hook reads each chart widget's fixed Y-axis range (#6348)
 * from the per-source `dashboardChartYRange` setting, dropping bad entries.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGet = vi.fn();
vi.mock('../../../services/api', () => ({ default: { get: (...args: unknown[]) => apiGet(...args) } }));

import { useDashboardData } from './useDashboardData';
import type { DashboardDataSource } from '../dataSources';

const dataSource = {
  kind: 'meshtastic',
  fetchNodes: vi.fn().mockResolvedValue([]),
  nodeKey: () => null,
} as unknown as DashboardDataSource;

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('useDashboardData — chart Y-axis ranges (#6348)', () => {
  beforeEach(() => apiGet.mockReset());

  it('parses the saved ranges and drops invalid entries', async () => {
    apiGet.mockResolvedValue({
      dashboardChartYRange: JSON.stringify({
        '!a-voltage': { min: 3, max: 4.2 },
        '!a-temperature': { max: 40 },
        '!a-bad': { min: 5, max: 1 },
      }),
    });
    const { result } = renderHook(() => useDashboardData({ dataSource, refetchInterval: 0 }), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.chartYRanges).toEqual({
      '!a-voltage': { min: 3, max: 4.2 },
      '!a-temperature': { max: 40 },
    });
  });

  it('reads a missing or corrupt setting as no fixed ranges', async () => {
    apiGet.mockResolvedValue({ dashboardChartYRange: 'not json' });
    const { result } = renderHook(() => useDashboardData({ dataSource, refetchInterval: 0 }), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.chartYRanges).toEqual({});
  });

  it('applies local edits over the server copy', async () => {
    apiGet.mockResolvedValue({ dashboardChartYRange: JSON.stringify({ '!a-voltage': { min: 3 } }) });
    const { result } = renderHook(() => useDashboardData({ dataSource, refetchInterval: 0 }), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.setChartYRanges((prev) => ({ ...prev, '!b-voltage': { max: 5 } }));
    });
    expect(result.current.chartYRanges).toEqual({ '!a-voltage': { min: 3 }, '!b-voltage': { max: 5 } });
  });
});
