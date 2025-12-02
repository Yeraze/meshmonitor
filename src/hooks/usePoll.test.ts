/**
 * Tests for usePoll hook
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { usePoll } from './usePoll';
import type { PollData } from './usePoll';

// Mock useCsrfFetch
const mockFetch = vi.fn();
vi.mock('./useCsrfFetch', () => ({
  useCsrfFetch: () => mockFetch,
}));

// Helper to create a wrapper with QueryClient
function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// Helper to create mock response
function createMockResponse(data: PollData, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers(),
    statusText: status === 200 ? 'OK' : 'Error',
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => createMockResponse(data, status),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(JSON.stringify(data)),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

describe('usePoll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic functionality', () => {
    it('should fetch poll data successfully', async () => {
      const mockData: PollData = {
        connection: {
          connected: true,
          nodeResponsive: true,
          configuring: false,
          userDisconnected: false,
        },
        nodes: [
          {
            id: '!abc123',
            num: 12345,
            user: { id: '!abc123', longName: 'Test Node', shortName: 'TN' },
          },
        ] as PollData['nodes'],
        channels: [
          { index: 0, name: 'Primary', role: 1 },
        ] as PollData['channels'],
        messages: [],
        telemetryNodes: {
          nodes: ['!abc123'],
          weather: [],
          estimatedPosition: [],
          pkc: [],
        },
      };

      mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

      const { result } = renderHook(() => usePoll(), {
        wrapper: createWrapper(),
      });

      // Initially loading
      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Data should be available
      expect(result.current.data).toEqual(mockData);
      expect(result.current.data?.connection?.connected).toBe(true);
      expect(result.current.data?.nodes).toHaveLength(1);
      expect(result.current.error).toBeNull();
    });

    it('should call correct endpoint', async () => {
      const mockData: PollData = { nodes: [] };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

      renderHook(() => usePoll(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/poll');
      });
    });

    it('should use custom baseUrl', async () => {
      const mockData: PollData = { nodes: [] };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

      renderHook(() => usePoll({ baseUrl: 'http://custom.url' }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('http://custom.url/api/poll');
      });
    });
  });

  describe('error handling', () => {
    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 500));

      const { result } = renderHook(() => usePoll(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect(result.current.error).toBeDefined();
      expect((result.current.error as Error).message).toContain('500');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => usePoll(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect((result.current.error as Error).message).toBe('Network error');
    });

    it('should handle 401 unauthorized', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({}, 401));

      const { result } = renderHook(() => usePoll(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isError).toBe(true);
      });

      expect((result.current.error as Error).message).toContain('401');
    });
  });

  describe('enabled option', () => {
    it('should not fetch when disabled', async () => {
      renderHook(() => usePoll({ enabled: false }), {
        wrapper: createWrapper(),
      });

      // Wait a bit to ensure no fetch is made
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should fetch when enabled', async () => {
      const mockData: PollData = { nodes: [] };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

      renderHook(() => usePoll({ enabled: true }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
    });
  });

  describe('query configuration', () => {
    it('should have correct query key', async () => {
      const mockData: PollData = { nodes: [] };
      mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

      const queryClient = new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: 0 },
        },
      });

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(() => usePoll(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Check that data is cached under correct key
      const cachedData = queryClient.getQueryData(['poll']);
      expect(cachedData).toEqual(mockData);
    });
  });

  describe('data structure', () => {
    it('should return all expected fields from poll response', async () => {
      const mockData: PollData = {
        connection: {
          connected: true,
          nodeResponsive: true,
          configuring: false,
          userDisconnected: false,
          nodeIp: '192.168.1.100',
        },
        nodes: [
          {
            id: '!abc123',
            num: 12345,
            user: { id: '!abc123', longName: 'Node 1', shortName: 'N1' },
          },
          {
            id: '!def456',
            num: 67890,
            user: { id: '!def456', longName: 'Node 2', shortName: 'N2' },
          },
        ] as PollData['nodes'],
        channels: [
          { index: 0, name: 'Primary', role: 1 },
          { index: 1, name: 'Secondary', role: 2 },
        ] as PollData['channels'],
        messages: [
          {
            id: 'msg1',
            from: '!abc123',
            to: '!def456',
            fromNodeId: '!abc123',
            toNodeId: '!def456',
            text: 'Hello',
            channel: 0,
            timestamp: Date.now(),
          },
        ],
        unreadCounts: {
          channels: { 0: 1 },
          directMessages: { '!abc123': 2 },
        },
        telemetryNodes: {
          nodes: ['!abc123', '!def456'],
          weather: ['!abc123'],
          estimatedPosition: [],
          pkc: ['!def456'],
        },
        config: {
          meshtasticNodeIp: '192.168.1.100',
          meshtasticTcpPort: 4403,
          baseUrl: '',
        },
        deviceConfig: {
          basic: {
            nodeId: '!abc123',
            nodeAddress: '12345',
          },
          lora: {
            modemPreset: 3,
          },
        },
      };

      mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

      const { result } = renderHook(() => usePoll(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const data = result.current.data;

      // Verify all fields
      expect(data?.connection?.connected).toBe(true);
      expect(data?.connection?.nodeIp).toBe('192.168.1.100');
      expect(data?.nodes).toHaveLength(2);
      expect(data?.channels).toHaveLength(2);
      expect(data?.messages).toHaveLength(1);
      expect(data?.unreadCounts?.channels?.[0]).toBe(1);
      expect(data?.telemetryNodes?.weather).toContain('!abc123');
      expect(data?.config?.meshtasticNodeIp).toBe('192.168.1.100');
      expect(data?.deviceConfig?.basic?.nodeId).toBe('!abc123');
    });

    it('should handle empty poll response', async () => {
      const mockData: PollData = {};
      mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

      const { result } = renderHook(() => usePoll(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data).toEqual({});
      expect(result.current.data?.nodes).toBeUndefined();
      expect(result.current.data?.connection).toBeUndefined();
    });

    it('should handle partial poll response', async () => {
      const mockData: PollData = {
        connection: {
          connected: false,
          nodeResponsive: false,
          configuring: true,
          userDisconnected: false,
        },
        // No nodes, channels, or messages
      };

      mockFetch.mockResolvedValueOnce(createMockResponse(mockData));

      const { result } = renderHook(() => usePoll(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.data?.connection?.configuring).toBe(true);
      expect(result.current.data?.nodes).toBeUndefined();
    });
  });
});
