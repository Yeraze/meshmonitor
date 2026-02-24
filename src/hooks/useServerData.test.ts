/**
 * Tests for useServerData hooks
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useNodes,
  useChannels,
  useConnectionInfo,
  useTelemetryNodes,
  useDeviceConfig,
  useUnreadCountsFromPoll,
  getNodesFromCache,
  getChannelsFromCache,
  getCurrentNodeIdFromCache,
} from './useServerData';
import type { PollData } from './usePoll';
import { POLL_QUERY_KEY } from './usePoll';

// Mock usePoll to return controlled data
const mockUsePollReturn = vi.fn();
vi.mock('./usePoll', () => ({
  usePoll: () => mockUsePollReturn(),
  POLL_QUERY_KEY: ['poll'],
}));

// Helper to create a wrapper with QueryClient
function createWrapper(queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

// Sample test data
const mockPollData: PollData = {
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
  telemetryNodes: {
    nodes: ['!abc123', '!def456'],
    weather: ['!abc123'],
    estimatedPosition: ['!def456'],
    pkc: ['!abc123', '!def456'],
  },
  unreadCounts: {
    channels: { 0: 5, 1: 0 },
    directMessages: { '!abc123': 3 },
  },
  config: {
    meshtasticNodeIp: '192.168.1.100',
    meshtasticTcpPort: 4403,
    localNodeInfo: {
      nodeId: '!abc123',
      longName: 'My Node',
      shortName: 'MN',
    },
  },
  deviceConfig: {
    basic: {
      nodeId: '!device123',
      nodeAddress: '456789',
    },
    lora: {
      modemPreset: 3,
    },
  },
};

describe('useServerData hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('useNodes', () => {
    it('should return nodes from poll data', () => {
      mockUsePollReturn.mockReturnValue({
        data: mockPollData,
        isLoading: false,
        error: null,
      });

      const { result } = renderHook(() => useNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.nodes).toHaveLength(2);
      expect(result.current.nodes[0].id).toBe('!abc123');
      expect(result.current.nodes[1].id).toBe('!def456');
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should return empty array when no nodes', () => {
      mockUsePollReturn.mockReturnValue({
        data: {},
        isLoading: false,
        error: null,
      });

      const { result } = renderHook(() => useNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.nodes).toEqual([]);
    });

    it('should return empty array when data is undefined', () => {
      mockUsePollReturn.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      });

      const { result } = renderHook(() => useNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.nodes).toEqual([]);
      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('useChannels', () => {
    it('should return channels from poll data', () => {
      mockUsePollReturn.mockReturnValue({
        data: mockPollData,
        isLoading: false,
        error: null,
      });

      const { result } = renderHook(() => useChannels(), {
        wrapper: createWrapper(),
      });

      expect(result.current.channels).toHaveLength(2);
      expect(result.current.channels[0].name).toBe('Primary');
      expect(result.current.channels[1].name).toBe('Secondary');
      expect(result.current.isLoading).toBe(false);
    });

    it('should return empty array when no channels', () => {
      mockUsePollReturn.mockReturnValue({
        data: {},
        isLoading: false,
        error: null,
      });

      const { result } = renderHook(() => useChannels(), {
        wrapper: createWrapper(),
      });

      expect(result.current.channels).toEqual([]);
    });
  });

  describe('useConnectionInfo', () => {
    it('should return connection info from poll data', () => {
      mockUsePollReturn.mockReturnValue({
        data: mockPollData,
        isLoading: false,
      });

      const { result } = renderHook(() => useConnectionInfo(), {
        wrapper: createWrapper(),
      });

      expect(result.current.connection).toBeDefined();
      expect(result.current.isConnected).toBe(true);
      expect(result.current.isNodeResponsive).toBe(true);
      expect(result.current.isConfiguring).toBe(false);
      expect(result.current.isUserDisconnected).toBe(false);
      expect(result.current.isLoading).toBe(false);
    });

    it('should return false for all flags when no connection data', () => {
      mockUsePollReturn.mockReturnValue({
        data: {},
        isLoading: false,
      });

      const { result } = renderHook(() => useConnectionInfo(), {
        wrapper: createWrapper(),
      });

      expect(result.current.connection).toBeUndefined();
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isNodeResponsive).toBe(false);
      expect(result.current.isConfiguring).toBe(false);
      expect(result.current.isUserDisconnected).toBe(false);
    });

    it('should handle configuring state', () => {
      mockUsePollReturn.mockReturnValue({
        data: {
          connection: {
            connected: false,
            nodeResponsive: false,
            configuring: true,
            userDisconnected: false,
          },
        },
        isLoading: false,
      });

      const { result } = renderHook(() => useConnectionInfo(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isConfiguring).toBe(true);
      expect(result.current.isConnected).toBe(false);
    });
  });

  describe('useTelemetryNodes', () => {
    it('should return Sets of telemetry node IDs', () => {
      mockUsePollReturn.mockReturnValue({
        data: mockPollData,
        isLoading: false,
      });

      const { result } = renderHook(() => useTelemetryNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.nodesWithTelemetry).toBeInstanceOf(Set);
      expect(result.current.nodesWithTelemetry.size).toBe(2);
      expect(result.current.nodesWithTelemetry.has('!abc123')).toBe(true);
      expect(result.current.nodesWithTelemetry.has('!def456')).toBe(true);

      expect(result.current.nodesWithWeather.size).toBe(1);
      expect(result.current.nodesWithWeather.has('!abc123')).toBe(true);

      expect(result.current.nodesWithEstimatedPosition.size).toBe(1);
      expect(result.current.nodesWithEstimatedPosition.has('!def456')).toBe(true);

      expect(result.current.nodesWithPKC.size).toBe(2);
      expect(result.current.isLoading).toBe(false);
    });

    it('should return empty Sets when no telemetry data', () => {
      mockUsePollReturn.mockReturnValue({
        data: {},
        isLoading: false,
      });

      const { result } = renderHook(() => useTelemetryNodes(), {
        wrapper: createWrapper(),
      });

      expect(result.current.nodesWithTelemetry.size).toBe(0);
      expect(result.current.nodesWithWeather.size).toBe(0);
      expect(result.current.nodesWithEstimatedPosition.size).toBe(0);
      expect(result.current.nodesWithPKC.size).toBe(0);
    });
  });

  describe('useDeviceConfig', () => {
    it('should return device config from poll data', () => {
      mockUsePollReturn.mockReturnValue({
        data: mockPollData,
        isLoading: false,
      });

      const { result } = renderHook(() => useDeviceConfig(), {
        wrapper: createWrapper(),
      });

      expect(result.current.deviceConfig).toBeDefined();
      expect(result.current.deviceConfig?.basic?.nodeId).toBe('!device123');
      expect(result.current.config).toBeDefined();
      expect(result.current.config?.meshtasticNodeIp).toBe('192.168.1.100');
      expect(result.current.isLoading).toBe(false);
    });

    it('should get currentNodeId from deviceConfig first', () => {
      mockUsePollReturn.mockReturnValue({
        data: mockPollData,
        isLoading: false,
      });

      const { result } = renderHook(() => useDeviceConfig(), {
        wrapper: createWrapper(),
      });

      // deviceConfig.basic.nodeId takes precedence
      expect(result.current.currentNodeId).toBe('!device123');
    });

    it('should fallback to localNodeInfo for currentNodeId', () => {
      mockUsePollReturn.mockReturnValue({
        data: {
          config: {
            localNodeInfo: {
              nodeId: '!fallback123',
            },
          },
          // No deviceConfig
        },
        isLoading: false,
      });

      const { result } = renderHook(() => useDeviceConfig(), {
        wrapper: createWrapper(),
      });

      expect(result.current.currentNodeId).toBe('!fallback123');
    });

    it('should return empty string when no node ID available', () => {
      mockUsePollReturn.mockReturnValue({
        data: {},
        isLoading: false,
      });

      const { result } = renderHook(() => useDeviceConfig(), {
        wrapper: createWrapper(),
      });

      expect(result.current.currentNodeId).toBe('');
    });
  });

  describe('useUnreadCountsFromPoll', () => {
    it('should return unread counts from poll data', () => {
      mockUsePollReturn.mockReturnValue({
        data: mockPollData,
      });

      const { result } = renderHook(() => useUnreadCountsFromPoll(), {
        wrapper: createWrapper(),
      });

      expect(result.current.channelUnreads).toEqual({ 0: 5, 1: 0 });
      expect(result.current.dmUnreads).toEqual({ '!abc123': 3 });
    });

    it('should return empty objects when no unread data', () => {
      mockUsePollReturn.mockReturnValue({
        data: {},
      });

      const { result } = renderHook(() => useUnreadCountsFromPoll(), {
        wrapper: createWrapper(),
      });

      expect(result.current.channelUnreads).toEqual({});
      expect(result.current.dmUnreads).toEqual({});
    });
  });

  describe('cache helper functions', () => {
    describe('getNodesFromCache', () => {
      it('should get nodes from query cache', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['poll'], mockPollData);

        const nodes = getNodesFromCache(queryClient);

        expect(nodes).toHaveLength(2);
        expect(nodes[0].id).toBe('!abc123');
      });

      it('should return empty array when no cached data', () => {
        const queryClient = new QueryClient();

        const nodes = getNodesFromCache(queryClient);

        expect(nodes).toEqual([]);
      });
    });

    describe('getChannelsFromCache', () => {
      it('should get channels from query cache', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['poll'], mockPollData);

        const channels = getChannelsFromCache(queryClient);

        expect(channels).toHaveLength(2);
        expect(channels[0].name).toBe('Primary');
      });

      it('should return empty array when no cached data', () => {
        const queryClient = new QueryClient();

        const channels = getChannelsFromCache(queryClient);

        expect(channels).toEqual([]);
      });
    });

    describe('getCurrentNodeIdFromCache', () => {
      it('should get current node ID from cache (deviceConfig first)', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['poll'], mockPollData);

        const nodeId = getCurrentNodeIdFromCache(queryClient);

        expect(nodeId).toBe('!device123');
      });

      it('should fallback to localNodeInfo', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['poll'], {
          config: {
            localNodeInfo: { nodeId: '!fallback' },
          },
        });

        const nodeId = getCurrentNodeIdFromCache(queryClient);

        expect(nodeId).toBe('!fallback');
      });

      it('should return empty string when no node ID in cache', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['poll'], {});

        const nodeId = getCurrentNodeIdFromCache(queryClient);

        expect(nodeId).toBe('');
      });

      it('should return empty string when no cached data', () => {
        const queryClient = new QueryClient();

        const nodeId = getCurrentNodeIdFromCache(queryClient);

        expect(nodeId).toBe('');
      });
    });
  });
});
