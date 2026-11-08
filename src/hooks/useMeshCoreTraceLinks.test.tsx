/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const calls = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('./useDashboardData', () => ({
  useDashboardSources: () => ({
    data: [
      { id: 'mt', type: 'meshtastic_tcp', enabled: true },
      { id: 'mc', type: 'meshcore', enabled: true },
      { id: 'mcoff', type: 'meshcore', enabled: false },
      { id: 'mq', type: 'mqtt', enabled: true },
    ],
  }),
}));
vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(async (url: string) => {
      calls.urls.push(url);
      return {
        success: true,
        data: { links: [{ sender: { publicKey: 'a', hash: null, candidates: 1 }, receiver: { publicKey: 'b', hash: null, candidates: 1 }, count: 1 }] },
      };
    }),
  },
}));

import { useMeshCoreTraceLinks } from './useMapAnalysisData';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

describe('useMeshCoreTraceLinks', () => {
  beforeEach(() => {
    calls.urls = [];
  });

  it('fans out to /hop-snr?hours=&points=1 for device MeshCore sources only, tagging sourceId', async () => {
    const { result } = renderHook(() => useMeshCoreTraceLinks(['mt', 'mc', 'mcoff', 'mq'], 48), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(calls.urls).toEqual(['/api/sources/mc/meshcore/hop-snr?hours=48&points=1']);
    expect(result.current.data?.links.map((l) => l.sourceId)).toEqual(['mc']);
  });

  it('stays idle when no device MeshCore source is selected', async () => {
    const { result } = renderHook(() => useMeshCoreTraceLinks(['mt', 'mq'], 24), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(calls.urls).toEqual([]);
  });
});
