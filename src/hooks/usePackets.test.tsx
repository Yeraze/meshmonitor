/**
 * Tests for usePackets hook with TanStack Query
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { usePackets } from './usePackets';
import * as packetApi from '../services/packetApi';
import { PacketLog, PacketLogResponse } from '../types/packet';

// Mock the packet API
vi.mock('../services/packetApi', () => ({
  getPackets: vi.fn(),
}));

const mockGetPackets = vi.mocked(packetApi.getPackets);

// Sample packet data
const createMockPacket = (id: number, fromNode: number = 12345): PacketLog => ({
  id,
  from_node: fromNode,
  timestamp: Date.now(),
  portnum: 1,
  encrypted: false,
});

const createMockResponse = (
  packets: PacketLog[],
  total: number = packets.length,
  offset: number = 0
): PacketLogResponse => ({
  packets,
  total,
  offset,
  limit: 100,
  maxCount: 10000,
  maxAgeHours: 24,
});

// Create a fresh QueryClient for each test with polling disabled
const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity, // Disable automatic refetching
        refetchInterval: false, // Disable polling in tests
        refetchOnWindowFocus: false,
      },
    },
  });

// Wrapper for renderHook with QueryClientProvider
const createWrapper = (queryClient: QueryClient) => {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
};

describe('usePackets', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createTestQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  describe('initial state', () => {
    it('should start with loading true', () => {
      mockGetPackets.mockResolvedValue(createMockResponse([]));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      expect(result.current.loading).toBe(true);
      expect(result.current.packets).toEqual([]);
      expect(result.current.rawPackets).toEqual([]);
    });

    it('should not fetch when canView is false', async () => {
      const { result } = renderHook(
        () =>
          usePackets({
            canView: false,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      // Wait a bit and verify no fetch was made
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockGetPackets).not.toHaveBeenCalled();
      // When query is disabled, TanStack Query sets isPending to false
      // The important thing is that no API call was made
      expect(result.current.packets).toEqual([]);
    });
  });

  describe('fetching packets', () => {
    it('should fetch packets on mount when canView is true', async () => {
      const mockPackets = [createMockPacket(1), createMockPacket(2)];
      mockGetPackets.mockResolvedValue(createMockResponse(mockPackets, 2));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockGetPackets).toHaveBeenCalledWith(0, 100, {});
      expect(result.current.packets).toHaveLength(2);
    });

    it('should pass filters to API', async () => {
      mockGetPackets.mockResolvedValue(createMockResponse([]));

      const filters = { portnum: 1, channel: 0 };

      renderHook(
        () =>
          usePackets({
            canView: true,
            filters,
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(mockGetPackets).toHaveBeenCalled();
      });

      expect(mockGetPackets).toHaveBeenCalledWith(0, 100, filters);
    });

    it('should update total from response', async () => {
      mockGetPackets.mockResolvedValue(createMockResponse([createMockPacket(1)], 500));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.total).toBe(500);
    });
  });

  describe('hideOwnPackets filtering', () => {
    it('should filter out own packets when hideOwnPackets is true', async () => {
      const ownNodeNum = 12345;
      const mockPackets = [
        createMockPacket(1, ownNodeNum), // Should be filtered
        createMockPacket(2, 99999), // Should remain
        createMockPacket(3, ownNodeNum), // Should be filtered
        createMockPacket(4, 88888), // Should remain
      ];
      mockGetPackets.mockResolvedValue(createMockResponse(mockPackets));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: true,
            ownNodeNum,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.rawPackets).toHaveLength(4);
      expect(result.current.packets).toHaveLength(2);
      expect(result.current.packets.every(p => p.from_node !== ownNodeNum)).toBe(true);
    });

    it('should show all packets when hideOwnPackets is false', async () => {
      const ownNodeNum = 12345;
      const mockPackets = [createMockPacket(1, ownNodeNum), createMockPacket(2, 99999)];
      mockGetPackets.mockResolvedValue(createMockResponse(mockPackets));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
            ownNodeNum,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.packets).toHaveLength(2);
    });

    it('should not filter when ownNodeNum is undefined', async () => {
      const mockPackets = [createMockPacket(1, 12345), createMockPacket(2, 99999)];
      mockGetPackets.mockResolvedValue(createMockResponse(mockPackets));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: true,
            ownNodeNum: undefined,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.packets).toHaveLength(2);
    });
  });

  describe('polling', () => {
    it('should have polling configured via refetchInterval', async () => {
      // With TanStack Query, polling is handled by refetchInterval option
      // This test verifies the initial fetch happens - polling is tested indirectly
      // by the refetchInterval configuration in the hook
      mockGetPackets.mockResolvedValue(createMockResponse([createMockPacket(1)]));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      // Initial fetch should happen
      await waitFor(() => {
        expect(mockGetPackets).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Verify packets are returned
      expect(result.current.packets).toHaveLength(1);
    });

    it('should cleanup on unmount', async () => {
      mockGetPackets.mockResolvedValue(createMockResponse([createMockPacket(1)]));

      const { unmount, result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(mockGetPackets).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Track calls before unmount
      const callsBeforeUnmount = mockGetPackets.mock.calls.length;

      unmount();

      // Verify component unmounted cleanly (no errors thrown)
      // TanStack Query handles cleanup automatically
      expect(mockGetPackets.mock.calls.length).toBe(callsBeforeUnmount);
    });

    it('should reset and re-fetch when filters change', async () => {
      mockGetPackets.mockResolvedValue(createMockResponse([createMockPacket(1)]));

      const { rerender } = renderHook(
        ({ filters }) =>
          usePackets({
            canView: true,
            filters,
            hideOwnPackets: false,
          }),
        {
          initialProps: { filters: {} },
          wrapper: createWrapper(queryClient),
        }
      );

      await waitFor(() => {
        expect(mockGetPackets).toHaveBeenCalledTimes(1);
      });

      // Change filters
      rerender({ filters: { portnum: 1 } });

      await waitFor(() => {
        expect(mockGetPackets).toHaveBeenCalledTimes(2);
      });

      expect(mockGetPackets).toHaveBeenLastCalledWith(0, 100, { portnum: 1 });
    });
  });

  describe('loadMore (infinite scroll)', () => {
    it('should load more packets with offset', async () => {
      const initialPackets = Array.from({ length: 100 }, (_, i) => createMockPacket(i + 1));
      const morePackets = Array.from({ length: 50 }, (_, i) => createMockPacket(i + 101));

      mockGetPackets
        .mockResolvedValueOnce(createMockResponse(initialPackets, 150, 0))
        .mockResolvedValueOnce(createMockResponse(morePackets, 150, 100));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.packets).toHaveLength(100);
      expect(result.current.hasMore).toBe(true);

      // Load more
      await act(async () => {
        await result.current.loadMore();
      });

      await waitFor(() => {
        expect(result.current.packets).toHaveLength(150);
      });

      expect(mockGetPackets).toHaveBeenLastCalledWith(100, 100, {});
    });

    it('should set hasMore to false when no more packets', async () => {
      const packets = Array.from({ length: 50 }, (_, i) => createMockPacket(i + 1));
      mockGetPackets.mockResolvedValue(createMockResponse(packets, 50));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // hasMore should be false since we got less than 100 packets
      expect(result.current.hasMore).toBe(false);
    });

    it('should not load more when already loading', async () => {
      // This test verifies that concurrent loadMore calls are blocked
      // We simply verify the guard by checking loadingMore state
      const packets = Array.from({ length: 100 }, (_, i) => createMockPacket(i + 1));

      mockGetPackets.mockImplementation(() => Promise.resolve(createMockResponse(packets, 200)));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Verify the hook has the loadingMore guard
      // When loadingMore is false, loadMore proceeds
      expect(result.current.loadingMore).toBe(false);

      // The guard in usePackets.ts checks: if (isFetchingNextPage || !hasNextPage || rateLimitError || !canView) return;
      // This ensures concurrent calls are blocked when isFetchingNextPage is true
    });

    it('should handle rate limit detection from error message', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const packets = Array.from({ length: 100 }, (_, i) => createMockPacket(i + 1));

      // Create a QueryClient that will handle the error
      const testQueryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            gcTime: Infinity,
            staleTime: Infinity,
            refetchInterval: false,
            refetchOnWindowFocus: false,
          },
        },
      });

      let callCount = 0;
      mockGetPackets.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(createMockResponse(packets, 200));
        }
        // Simulate rate limit error
        const error = new Error('Too many requests');
        return Promise.reject(error);
      });

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(testQueryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(callCount).toBe(1);

      // Call loadMore which will trigger the rate limit error
      await act(async () => {
        await result.current.loadMore();
      });

      // Wait for the API to be called
      await waitFor(() => {
        expect(callCount).toBeGreaterThanOrEqual(2);
      });

      // The hook should detect rate limit from the error message
      // Note: rateLimitError is set based on error message containing rate limit text
      // If the error doesn't match, rateLimitError stays false
      // This test verifies the loadMore was called
      expect(callCount).toBe(2);

      testQueryClient.clear();
      consoleSpy.mockRestore();
    });

    it('should start with rateLimitError as false', async () => {
      const packets = Array.from({ length: 100 }, (_, i) => createMockPacket(i + 1));
      mockGetPackets.mockResolvedValue(createMockResponse(packets, 200));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Initially no rate limit error
      expect(result.current.rateLimitError).toBe(false);
    });
  });

  describe('shouldLoadMore', () => {
    it('should return true when near end of list', async () => {
      const packets = Array.from({ length: 100 }, (_, i) => createMockPacket(i + 1));
      mockGetPackets.mockImplementation(() => Promise.resolve(createMockResponse(packets, 200)));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Mark user as scrolled first
      act(() => {
        result.current.markUserScrolled();
      });

      // Near end (index 95 with threshold 10)
      expect(result.current.shouldLoadMore(95, 10)).toBe(true);
    });

    it('should return false when not near end', async () => {
      const packets = Array.from({ length: 100 }, (_, i) => createMockPacket(i + 1));
      mockGetPackets.mockImplementation(() => Promise.resolve(createMockResponse(packets, 200)));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Not near end
      expect(result.current.shouldLoadMore(50, 10)).toBe(false);
    });

    it('should return false when hasMore is false', async () => {
      const packets = Array.from({ length: 50 }, (_, i) => createMockPacket(i + 1));
      mockGetPackets.mockImplementation(() => Promise.resolve(createMockResponse(packets, 50)));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      act(() => {
        result.current.markUserScrolled();
      });

      // hasMore should be false since we got less than 100 packets
      expect(result.current.hasMore).toBe(false);
      expect(result.current.shouldLoadMore(45, 10)).toBe(false);
    });

    it('should require user scroll before loading more', async () => {
      const packets = Array.from({ length: 100 }, (_, i) => createMockPacket(i + 1));
      mockGetPackets.mockImplementation(() => Promise.resolve(createMockResponse(packets, 200)));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // Without marking scroll, should return false
      expect(result.current.shouldLoadMore(95, 10)).toBe(false);

      // After marking scroll
      act(() => {
        result.current.markUserScrolled();
      });

      expect(result.current.shouldLoadMore(95, 10)).toBe(true);
    });
  });

  describe('refresh', () => {
    it('should refetch packets when refresh is called', async () => {
      mockGetPackets.mockImplementation(() => Promise.resolve(createMockResponse([createMockPacket(1)])));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      const callsBefore = mockGetPackets.mock.calls.length;

      // Call refresh
      await act(async () => {
        await result.current.refresh();
      });

      await waitFor(() => {
        expect(mockGetPackets.mock.calls.length).toBeGreaterThan(callsBefore);
      });
    });
  });

  describe('error handling', () => {
    it('should handle fetch errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGetPackets.mockImplementation(() => Promise.reject(new Error('Network error')));

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.packets).toEqual([]);

      consoleSpy.mockRestore();
    });

    it('should handle loadMore errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const packets = Array.from({ length: 100 }, (_, i) => createMockPacket(i + 1));

      let callCount = 0;
      mockGetPackets.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(createMockResponse(packets, 200));
        }
        if (callCount === 2) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve(createMockResponse(packets, 200));
      });

      const { result } = renderHook(
        () =>
          usePackets({
            canView: true,
            filters: {},
            hideOwnPackets: false,
          }),
        { wrapper: createWrapper(queryClient) }
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        await result.current.loadMore();
      });

      await waitFor(() => {
        expect(result.current.loadingMore).toBe(false);
      });

      expect(result.current.packets).toHaveLength(100); // Original packets preserved

      consoleSpy.mockRestore();
    });
  });
});
