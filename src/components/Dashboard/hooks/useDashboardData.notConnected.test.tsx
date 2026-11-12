/**
 * @vitest-environment jsdom
 *
 * #4173 review N5: a source with no running manager answers its node list
 * with `code: 'SOURCE_NOT_CONNECTED'`. The hook reports that as
 * `notConnected`, so the dashboard draws the empty state, not the raw error.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGet = vi.fn();
vi.mock('../../../services/api', () => ({ default: { get: (...args: unknown[]) => apiGet(...args) } }));

import { useDashboardData } from './useDashboardData';
import type { DashboardDataSource } from '../dataSources';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

function source(fetchNodes: () => Promise<unknown[]>): DashboardDataSource {
  return { kind: 'meshcore', fetchNodes, nodeKey: () => null } as unknown as DashboardDataSource;
}

describe('useDashboardData — source not connected (#4173 N5)', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue({});
  });

  it('sets notConnected when the node fetch fails with SOURCE_NOT_CONNECTED', async () => {
    const err = Object.assign(new Error('No MeshCore manager for source x'), { status: 404, code: 'SOURCE_NOT_CONNECTED' });
    const ds = source(() => Promise.reject(err));
    const { result } = renderHook(() => useDashboardData({ dataSource: ds, refetchInterval: 0 }), { wrapper });

    await waitFor(() => expect(result.current.notConnected).toBe(true));
  });

  it('leaves notConnected false for any other error', async () => {
    const err = Object.assign(new Error('HTTP 500'), { status: 500 });
    const ds = source(() => Promise.reject(err));
    const { result } = renderHook(() => useDashboardData({ dataSource: ds, refetchInterval: 0 }), { wrapper });

    await waitFor(() => expect(result.current.error).toBe('HTTP 500'));
    expect(result.current.notConnected).toBe(false);
  });
});
