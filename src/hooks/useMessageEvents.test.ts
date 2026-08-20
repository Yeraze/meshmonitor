/**
 * @vitest-environment jsdom
 *
 * useMessageEvents (#4816 Phase 3 WP4) — lazy TanStack timeline fetch.
 * Asserts the query is disabled until sourceId + messageId are known, and that
 * it unwraps events through ApiService.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useMessageEvents } from './useMessageEvents';
import type { MessageEvent } from '../types/message';
import apiService from '../services/api';

vi.mock('../services/api', () => ({
  default: { getMessageEvents: vi.fn() },
}));

const mockGet = apiService.getMessageEvents as unknown as ReturnType<typeof vi.fn>;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

const sample: MessageEvent[] = [
  { id: 1, sourceId: 's', messageId: 'm', eventType: 'submitted', provenance: 'observed', detail: null, timestamp: 1, createdAt: 1 },
];

beforeEach(() => {
  mockGet.mockReset();
});

describe('useMessageEvents', () => {
  it('stays disabled and fetches nothing when sourceId or messageId is empty', () => {
    mockGet.mockResolvedValue(sample);
    const { result } = renderHook(() => useMessageEvents('', 'm'), { wrapper: wrapper() });
    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current.events).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('fetches and returns events when both keys are present', async () => {
    mockGet.mockResolvedValue(sample);
    const { result } = renderHook(() => useMessageEvents('s', 'm'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.events.length).toBe(1));
    expect(mockGet).toHaveBeenCalledWith('s', 'm');
    expect(result.current.events[0].eventType).toBe('submitted');
  });

  it('surfaces the error state when the fetch rejects', async () => {
    mockGet.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useMessageEvents('s', 'm'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.events).toEqual([]);
  });
});
