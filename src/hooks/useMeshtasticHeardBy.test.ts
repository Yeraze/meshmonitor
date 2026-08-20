/**
 * @vitest-environment jsdom
 *
 * useMeshtasticHeardBy (#4816 Phase 4 WP3) — lazy TanStack Heard-By fetch.
 * Asserts the query is disabled until sourceId + messageId are known, and
 * that it unwraps entries through ApiService.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useMeshtasticHeardBy } from './useMeshtasticHeardBy';
import type { MeshtasticHeardByEntry } from '../types/message';
import apiService from '../services/api';

vi.mock('../services/api', () => ({
  default: { getMeshtasticHeardBy: vi.fn() },
}));

const mockGet = apiService.getMeshtasticHeardBy as unknown as ReturnType<typeof vi.fn>;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

const sample: MeshtasticHeardByEntry[] = [
  {
    relayByte: 0xab,
    relayByteHex: '0xAB',
    snr: 4.5,
    heardAt: 1,
    candidates: [{ nodeNum: 171, longName: 'Repeater One', shortName: 'RP1' }],
  },
];

beforeEach(() => {
  mockGet.mockReset();
});

describe('useMeshtasticHeardBy', () => {
  it('stays disabled and fetches nothing when sourceId or messageId is empty', () => {
    mockGet.mockResolvedValue(sample);
    const { result } = renderHook(() => useMeshtasticHeardBy('', 'm'), { wrapper: wrapper() });
    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current.heardBy).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('fetches and returns heard-by entries when both keys are present', async () => {
    mockGet.mockResolvedValue(sample);
    const { result } = renderHook(() => useMeshtasticHeardBy('s', 'm'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.heardBy.length).toBe(1));
    expect(mockGet).toHaveBeenCalledWith('s', 'm');
    expect(result.current.heardBy[0].relayByteHex).toBe('0xAB');
    expect(result.current.heardBy[0].candidates[0].nodeNum).toBe(171);
  });

  it('surfaces the error state when the fetch rejects', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useMeshtasticHeardBy('s', 'm'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.heardBy).toEqual([]);
  });
});
