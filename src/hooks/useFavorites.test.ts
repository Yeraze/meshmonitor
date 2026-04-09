/**
 * Tests for useFavorites hooks
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useFavorites, useToggleFavorite } from './useFavorites';

// Mock useCsrfFetch
const mockCsrfFetch = vi.fn();
vi.mock('./useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

// Helper to create a wrapper with QueryClient
function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 60 * 1000, // Keep cache alive during tests (not 0, which causes gc races)
      },
      mutations: {
        retry: false,
      },
    },
  });

  return {
    client,
    wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    },
  };
}

describe('useFavorites hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCsrfFetch.mockReset();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('useFavorites', () => {
    it('should return favorites as a Set for a given nodeId', async () => {
      const settings = {
        telemetryFavorites: JSON.stringify([
          { nodeId: '!abc123', telemetryType: 'batteryLevel' },
          { nodeId: '!abc123', telemetryType: 'temperature' },
          { nodeId: '!def456', telemetryType: 'voltage' },
        ]),
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => settings,
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useFavorites({ nodeId: '!abc123' }), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toBeInstanceOf(Set);
      expect(result.current.data?.size).toBe(2);
      expect(result.current.data?.has('batteryLevel')).toBe(true);
      expect(result.current.data?.has('temperature')).toBe(true);
      // Should not include another node's favorites
      expect(result.current.data?.has('voltage')).toBe(false);
    });

    it('should return empty Set when response is not ok', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useFavorites({ nodeId: '!abc123' }), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toBeInstanceOf(Set);
      expect(result.current.data?.size).toBe(0);
    });

    it('should return empty Set when telemetryFavorites is missing', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useFavorites({ nodeId: '!abc123' }), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toBeInstanceOf(Set);
      expect(result.current.data?.size).toBe(0);
    });

    it('should return empty Set when no favorites match the nodeId', async () => {
      const settings = {
        telemetryFavorites: JSON.stringify([
          { nodeId: '!def456', telemetryType: 'voltage' },
        ]),
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => settings,
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useFavorites({ nodeId: '!abc123' }), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data?.size).toBe(0);
    });

    it('should be disabled when enabled=false', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useFavorites({ nodeId: '!abc123', enabled: false }),
        { wrapper }
      );

      expect(result.current.fetchStatus).toBe('idle');
      expect(result.current.data).toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should be disabled when nodeId is empty', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useFavorites({ nodeId: '' }),
        { wrapper }
      );

      expect(result.current.fetchStatus).toBe('idle');
      expect(result.current.data).toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should use baseUrl when provided', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ telemetryFavorites: JSON.stringify([]) }),
      });

      const { wrapper } = createWrapper();
      renderHook(() => useFavorites({ nodeId: '!abc123', baseUrl: 'http://localhost:3000' }), { wrapper });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('http://localhost:3000/api/settings');
      });
    });
  });

  describe('useToggleFavorite', () => {
    it('should add a new favorite (toggle on)', async () => {
      const initialSettings = {
        telemetryFavorites: JSON.stringify([
          { nodeId: '!abc123', telemetryType: 'temperature' },
        ]),
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => initialSettings,
      });

      mockCsrfFetch.mockResolvedValueOnce({ ok: true });

      const onSuccess = vi.fn();
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useToggleFavorite({ onSuccess }), { wrapper });

      result.current.mutate({
        nodeId: '!abc123',
        telemetryType: 'batteryLevel',
        currentFavorites: new Set(['temperature']),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(result.current.data?.has('batteryLevel')).toBe(true);
      expect(result.current.data?.has('temperature')).toBe(true);
    });

    it('should remove an existing favorite (toggle off)', async () => {
      const initialSettings = {
        telemetryFavorites: JSON.stringify([
          { nodeId: '!abc123', telemetryType: 'batteryLevel' },
          { nodeId: '!abc123', telemetryType: 'temperature' },
        ]),
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => initialSettings,
      });

      mockCsrfFetch.mockResolvedValueOnce({ ok: true });

      const onSuccess = vi.fn();
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useToggleFavorite({ onSuccess }), { wrapper });

      result.current.mutate({
        nodeId: '!abc123',
        telemetryType: 'batteryLevel',
        currentFavorites: new Set(['batteryLevel', 'temperature']),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(result.current.data?.has('batteryLevel')).toBe(false);
      expect(result.current.data?.has('temperature')).toBe(true);
    });

    it('should apply optimistic update before server responds', async () => {
      // Use a deferred promise so we can confirm optimistic cache state before resolving
      let resolveSettingsFetch!: (value: Response) => void;
      const settingsDeferred = new Promise<Response>(resolve => {
        resolveSettingsFetch = resolve;
      });

      (global.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(settingsDeferred);
      mockCsrfFetch.mockResolvedValueOnce({ ok: true });

      const { client, wrapper } = createWrapper();
      // Pre-seed the cache so we can observe the optimistic update
      client.setQueryData(['favorites', null, '!abc123'], new Set<string>(['temperature']));

      const { result } = renderHook(() => useToggleFavorite(), { wrapper });

      // Fire mutation — it goes in-flight while settings fetch is pending
      result.current.mutate({
        nodeId: '!abc123',
        telemetryType: 'batteryLevel',
        currentFavorites: new Set(['temperature']),
      });

      // Wait for onMutate to complete: it cancels queries then writes optimistic data
      await waitFor(() => {
        const cached = client.getQueryData<Set<string>>(['favorites', null, '!abc123']);
        expect(cached?.has('batteryLevel')).toBe(true);
      });

      // Resolve the deferred settings fetch so mutationFn can complete
      resolveSettingsFetch({
        ok: true,
        json: async () => ({ telemetryFavorites: JSON.stringify([]) }),
      } as unknown as Response);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    it('should roll back optimistic update on error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ telemetryFavorites: JSON.stringify([]) }),
      });

      mockCsrfFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const onError = vi.fn();
      const { client, wrapper } = createWrapper();
      // Pre-seed the cache with original favorites
      client.setQueryData(['favorites', null, '!abc123'], new Set<string>(['temperature']));

      const { result } = renderHook(() => useToggleFavorite({ onError }), { wrapper });

      result.current.mutate({
        nodeId: '!abc123',
        telemetryType: 'batteryLevel',
        currentFavorites: new Set(['temperature']),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      // Cache should be rolled back to previous snapshot via onError handler
      const cached = client.getQueryData<Set<string>>(['favorites', null, '!abc123']);
      expect(cached?.has('temperature')).toBe(true);

      expect(onError).toHaveBeenCalledWith('Server returned 500');
    });

    it('should throw and call onError with permission message on 403', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ telemetryFavorites: JSON.stringify([]) }),
      });

      mockCsrfFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const onError = vi.fn();
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useToggleFavorite({ onError }), { wrapper });

      result.current.mutate({
        nodeId: '!abc123',
        telemetryType: 'batteryLevel',
        currentFavorites: new Set(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(onError).toHaveBeenCalledWith('Insufficient permissions to save favorites');
    });

    it('should handle settings fetch failure gracefully and still save with empty base', async () => {
      // First fetch (settings) returns non-ok — mutation should proceed with empty favorites
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      mockCsrfFetch.mockResolvedValueOnce({ ok: true });

      const onSuccess = vi.fn();
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useToggleFavorite({ onSuccess }), { wrapper });

      result.current.mutate({
        nodeId: '!abc123',
        telemetryType: 'batteryLevel',
        currentFavorites: new Set(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('should preserve favorites from other nodes when toggling', async () => {
      const initialSettings = {
        telemetryFavorites: JSON.stringify([
          { nodeId: '!abc123', telemetryType: 'temperature' },
          { nodeId: '!def456', telemetryType: 'voltage' },
          { nodeId: '!def456', telemetryType: 'batteryLevel' },
        ]),
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => initialSettings,
      });

      let capturedBody: unknown;
      mockCsrfFetch.mockImplementationOnce(async (_url: unknown, options: { body?: unknown } = {}) => {
        capturedBody = options.body;
        return { ok: true };
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useToggleFavorite(), { wrapper });

      result.current.mutate({
        nodeId: '!abc123',
        telemetryType: 'newType',
        currentFavorites: new Set(['temperature']),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(capturedBody).toBeDefined();
      const parsed = JSON.parse(capturedBody as string);
      const saved: Array<{ nodeId: string; telemetryType: string }> = JSON.parse(parsed.telemetryFavorites);

      // Other node's favorites should still be present
      expect(saved.some((f) => f.nodeId === '!def456' && f.telemetryType === 'voltage')).toBe(true);
      expect(saved.some((f) => f.nodeId === '!def456' && f.telemetryType === 'batteryLevel')).toBe(true);
    });

    it('should call onError with fallback message for non-Error rejections', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce('network failure');

      const onError = vi.fn();
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useToggleFavorite({ onError }), { wrapper });

      result.current.mutate({
        nodeId: '!abc123',
        telemetryType: 'batteryLevel',
        currentFavorites: new Set(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(onError).toHaveBeenCalledWith('Failed to save favorite');
    });
  });
});
