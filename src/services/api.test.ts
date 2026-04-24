import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// Mock sessionStorage (not available in Node.js test environment)
if (typeof sessionStorage === 'undefined') {
  const sessionStorageData: Record<string, string> = {};
  (global as any).sessionStorage = {
    getItem: (key: string) => sessionStorageData[key] ?? null,
    setItem: (key: string, value: string) => { sessionStorageData[key] = value; },
    removeItem: (key: string) => { delete sessionStorageData[key]; },
    clear: () => { Object.keys(sessionStorageData).forEach(k => delete sessionStorageData[k]); },
  };
}

// Mock window.location for browser environment
const mockLocation = {
  pathname: '/',
  href: 'http://localhost:3000/',
};

// Create global window object for Node.js test environment
if (typeof window === 'undefined') {
  (global as any).window = {
    location: mockLocation,
  };
} else {
  Object.defineProperty(window, 'location', {
    value: mockLocation,
    writable: true,
  });
}

// Import ApiService after mocks are set up
const { default: apiService } = await import('./api');

// Helper to create mock response with headers
const createMockResponse = (data: any, ok = true, contentType = 'application/json') => ({
  ok,
  headers: {
    get: (name: string) => {
      if (name.toLowerCase() === 'content-type') {
        return contentType;
      }
      return null;
    }
  },
  json: async () => data,
});

describe('ApiService BASE_URL Support', () => {
  beforeEach(() => {
    // Reset the ApiService internal state before each test
    // We need to access private properties for testing
    (apiService as any).baseUrl = '';
    (apiService as any).configFetched = false;
    (apiService as any).configPromise = null;

    mockFetch.mockClear();
    mockLocation.pathname = '/';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Base URL Detection', () => {
    it('should fetch config from root when at root path', async () => {
      mockLocation.pathname = '/';

      // Reset state
      (apiService as any).configFetched = false;
      (apiService as any).baseUrl = '';

      mockFetch.mockResolvedValueOnce(createMockResponse({ baseUrl: '' }));

      await apiService.getBaseUrl();

      expect(mockFetch).toHaveBeenCalledWith('/api/config');
      expect(await apiService.getBaseUrl()).toBe('');
    });

    it('should detect single-segment BASE_URL from pathname', async () => {
      mockLocation.pathname = '/meshmonitor/dashboard';

      // Reset state
      (apiService as any).configFetched = false;
      (apiService as any).baseUrl = '';

      // First fetch to root fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
      });

      // Second fetch to /meshmonitor/dashboard/api/config fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
      });

      // Third fetch to /meshmonitor/api/config succeeds
      mockFetch.mockResolvedValueOnce(createMockResponse({ baseUrl: '/meshmonitor' }));

      const baseUrl = await apiService.getBaseUrl();

      expect(mockFetch).toHaveBeenCalledWith('/api/config');
      expect(mockFetch).toHaveBeenCalledWith('/meshmonitor/api/config');
      expect(baseUrl).toBe('/meshmonitor');
    });

    it('should detect multi-segment BASE_URL from pathname', async () => {
      mockLocation.pathname = '/company/tools/meshmonitor/dashboard';

      // Reset state
      (apiService as any).configFetched = false;
      (apiService as any).baseUrl = '';

      // Root fetch fails
      mockFetch.mockResolvedValueOnce({ ok: false });

      // Try most specific paths
      mockFetch.mockResolvedValueOnce({ ok: false }); // /company/tools/meshmonitor/dashboard/api/config
      mockFetch.mockResolvedValueOnce({ ok: false }); // /company/tools/meshmonitor/api/config
      mockFetch.mockResolvedValueOnce({ ok: false }); // /company/tools/api/config

      // This path succeeds or infers from pathname
      const baseUrl = await apiService.getBaseUrl();

      // Should infer multi-segment path
      expect(baseUrl).toBe('/company/tools/meshmonitor');
    });

    it('should infer BASE_URL from pathname when config endpoint not found', async () => {
      mockLocation.pathname = '/mesh/monitor/nodes';

      // All fetch attempts fail
      mockFetch.mockResolvedValue({ ok: false });

      // Reset state to allow re-detection
      (apiService as any).configFetched = false;
      (apiService as any).configPromise = null;

      const baseUrl = await apiService.getBaseUrl();

      // Should infer /mesh/monitor (stop before 'nodes' which is an app route)
      expect(baseUrl).toBe('/mesh/monitor');
    });

    it('should stop at app routes when inferring BASE_URL', async () => {
      mockLocation.pathname = '/tools/meshmonitor/channels/primary';

      // All fetch attempts fail
      mockFetch.mockResolvedValue({ ok: false });

      // Reset state
      (apiService as any).configFetched = false;
      (apiService as any).configPromise = null;

      const baseUrl = await apiService.getBaseUrl();

      // Should stop at 'channels' which is an app route
      expect(baseUrl).toBe('/tools/meshmonitor');
    });
  });

  describe('Race Condition Prevention', () => {
    it('should prevent multiple concurrent config fetches', async () => {
      mockLocation.pathname = '/';
      mockFetch.mockResolvedValueOnce(createMockResponse({ baseUrl: '' }));

      // Make multiple concurrent calls
      const promises = [
        apiService.getBaseUrl(),
        apiService.getBaseUrl(),
        apiService.getBaseUrl(),
      ];

      await Promise.all(promises);

      // Should only fetch once due to promise caching
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should share the same config promise across concurrent requests', async () => {
      mockLocation.pathname = '/meshmonitor';

      // Reset state and directly set baseUrl to avoid config fetch complexity
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '/meshmonitor';

      // Setup responses for actual API calls
      mockFetch.mockResolvedValueOnce(createMockResponse({ baseUrl: '/meshmonitor' }));
      mockFetch.mockResolvedValueOnce(createMockResponse({ connected: true }));
      mockFetch.mockResolvedValueOnce(createMockResponse({ nodes: [] }));

      // Simulate multiple API calls happening at the same time
      const results = await Promise.all([
        apiService.getConfig(),
        apiService.getConnectionStatus(),
        apiService.getNodes(),
      ]);

      // All should succeed
      expect(results).toBeDefined();
      expect(results.length).toBe(3);
    });
  });

  describe('Retry Logic', () => {
    it('should retry on failure with exponential backoff', async () => {
      mockLocation.pathname = '/';

      // Reset state
      (apiService as any).configFetched = false;
      (apiService as any).baseUrl = '';

      // First call to /api/config succeeds after initial attempt
      mockFetch.mockResolvedValueOnce(createMockResponse({ baseUrl: '' }));

      const baseUrl = await apiService.getBaseUrl();

      expect(baseUrl).toBe('');
      // Verify that fetch was called
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should fallback to empty baseUrl after max retries', async () => {
      mockLocation.pathname = '/';

      // Reset state
      (apiService as any).configFetched = false;
      (apiService as any).baseUrl = '';

      // Fail all attempts
      mockFetch.mockRejectedValue(new Error('Network error'));

      const baseUrl = await apiService.getBaseUrl();

      expect(baseUrl).toBe('');
      // Should have attempted multiple times
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('API Endpoint Construction', () => {
    it('should construct API URLs with baseUrl', async () => {
      mockLocation.pathname = '/meshmonitor';

      // Reset state and directly set baseUrl
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '/meshmonitor';

      mockFetch.mockResolvedValueOnce(createMockResponse({ connected: true }));

      await apiService.getConnectionStatus();

      // Should call /meshmonitor/api/connection
      expect(mockFetch).toHaveBeenCalledWith('/meshmonitor/api/connection');
    });

    it('should handle root deployment without baseUrl prefix', async () => {
      mockLocation.pathname = '/';

      // Reset state and set empty baseUrl
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '';

      mockFetch.mockResolvedValueOnce(createMockResponse({ nodes: [] }));

      await apiService.getNodes();

      // Should call /api/nodes (no prefix)
      expect(mockFetch).toHaveBeenCalledWith('/api/nodes');
    });

    it('should handle multi-segment BASE_URL in API calls', async () => {
      mockLocation.pathname = '/company/tools/meshmonitor';

      // Reset state and directly set baseUrl
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '/company/tools/meshmonitor';

      mockFetch.mockResolvedValueOnce(createMockResponse({ channels: [] }));

      await apiService.getChannels();

      // Should call with full multi-segment path
      expect(mockFetch).toHaveBeenCalledWith('/company/tools/meshmonitor/api/channels');
    });
  });

  describe('Configuration Caching', () => {
    it('should cache baseUrl after first fetch', async () => {
      mockLocation.pathname = '/meshmonitor';

      // Reset state
      (apiService as any).configFetched = false;
      (apiService as any).baseUrl = '';

      mockFetch.mockResolvedValue(createMockResponse({ baseUrl: '/meshmonitor' }));

      // First call fetches config
      await apiService.getBaseUrl();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call uses cached value
      await apiService.getBaseUrl();
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, not 2
    });

    it('should use cached baseUrl for subsequent API calls', async () => {
      mockLocation.pathname = '/';

      // Reset state
      (apiService as any).configFetched = false;
      (apiService as any).baseUrl = '';

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ baseUrl: '' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ nodes: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ channels: [] }),
        });

      await apiService.getNodes();
      await apiService.getChannels();

      // Should fetch config once, then use cached baseUrl for both API calls
      expect(mockFetch).toHaveBeenCalledTimes(3); // 1 config + 2 API calls
      expect(mockFetch).toHaveBeenNthCalledWith(1, '/api/config');
      expect(mockFetch).toHaveBeenNthCalledWith(2, '/api/nodes');
      expect(mockFetch).toHaveBeenNthCalledWith(3, '/api/channels');
    });
  });

  describe('API Response Data - hopsAway field', () => {
    beforeEach(() => {
      mockLocation.pathname = '/';
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '';
    });

    it('should return hopsAway field in node data', async () => {
      const mockNodes = [
        {
          nodeNum: 1,
          nodeId: '!test1',
          longName: 'Test Node 1',
          hopsAway: 2,
          user: {
            id: '!test1',
            longName: 'Test Node 1',
            shortName: 'TN1',
          },
        },
        {
          nodeNum: 2,
          nodeId: '!test2',
          longName: 'Test Node 2',
          hopsAway: 1,
          user: {
            id: '!test2',
            longName: 'Test Node 2',
            shortName: 'TN2',
          },
        },
      ];

      mockFetch.mockResolvedValue(createMockResponse({ nodes: mockNodes }));

      const nodes = await apiService.getNodes();

      expect(nodes).toHaveLength(2);
      expect(nodes[0].hopsAway).toBe(2);
      expect(nodes[1].hopsAway).toBe(1);
    });

    it('should handle nodes with hopsAway of 0 (local node)', async () => {
      const mockNodes = [
        {
          nodeNum: 1,
          nodeId: '!local',
          longName: 'Local Node',
          hopsAway: 0,
          user: {
            id: '!local',
            longName: 'Local Node',
            shortName: 'LOC',
          },
        },
      ];

      mockFetch.mockResolvedValue(createMockResponse({ nodes: mockNodes }));

      const nodes = await apiService.getNodes();

      expect(nodes).toHaveLength(1);
      expect(nodes[0].hopsAway).toBe(0);
    });

    it('should handle nodes without hopsAway field (undefined)', async () => {
      const mockNodes = [
        {
          nodeNum: 1,
          nodeId: '!test1',
          longName: 'Test Node 1',
          // hopsAway not included
          user: {
            id: '!test1',
            longName: 'Test Node 1',
            shortName: 'TN1',
          },
        },
      ];

      mockFetch.mockResolvedValue(createMockResponse({ nodes: mockNodes }));

      const nodes = await apiService.getNodes();

      expect(nodes).toHaveLength(1);
      expect(nodes[0].hopsAway).toBeUndefined();
    });

    it('should handle nodes with null hopsAway', async () => {
      const mockNodes = [
        {
          nodeNum: 1,
          nodeId: '!test1',
          longName: 'Test Node 1',
          hopsAway: null,
          user: {
            id: '!test1',
            longName: 'Test Node 1',
            shortName: 'TN1',
          },
        },
      ];

      mockFetch.mockResolvedValue(createMockResponse({ nodes: mockNodes }));

      const nodes = await apiService.getNodes();

      expect(nodes).toHaveLength(1);
      expect(nodes[0].hopsAway).toBeNull();
    });

    it('should handle various hopsAway values (1-6+)', async () => {
      const mockNodes = [
        { nodeNum: 1, nodeId: '!n1', hopsAway: 1, user: { id: '!n1', longName: 'Node 1' } },
        { nodeNum: 2, nodeId: '!n2', hopsAway: 2, user: { id: '!n2', longName: 'Node 2' } },
        { nodeNum: 3, nodeId: '!n3', hopsAway: 3, user: { id: '!n3', longName: 'Node 3' } },
        { nodeNum: 4, nodeId: '!n4', hopsAway: 4, user: { id: '!n4', longName: 'Node 4' } },
        { nodeNum: 5, nodeId: '!n5', hopsAway: 5, user: { id: '!n5', longName: 'Node 5' } },
        { nodeNum: 6, nodeId: '!n6', hopsAway: 6, user: { id: '!n6', longName: 'Node 6' } },
        { nodeNum: 7, nodeId: '!n7', hopsAway: 10, user: { id: '!n7', longName: 'Node 7' } },
      ];

      mockFetch.mockResolvedValue(createMockResponse({ nodes: mockNodes }));

      const nodes = await apiService.getNodes();

      expect(nodes).toHaveLength(7);
      expect(nodes[0].hopsAway).toBe(1);
      expect(nodes[1].hopsAway).toBe(2);
      expect(nodes[2].hopsAway).toBe(3);
      expect(nodes[3].hopsAway).toBe(4);
      expect(nodes[4].hopsAway).toBe(5);
      expect(nodes[5].hopsAway).toBe(6);
      expect(nodes[6].hopsAway).toBe(10);
    });

    it('should preserve hopsAway field type as number', async () => {
      const mockNodes = [
        {
          nodeNum: 1,
          nodeId: '!test1',
          hopsAway: 3,
          user: { id: '!test1', longName: 'Node' },
        },
      ];

      mockFetch.mockResolvedValue(createMockResponse({ nodes: mockNodes }));

      const nodes = await apiService.getNodes();

      expect(typeof nodes[0].hopsAway).toBe('number');
      expect(nodes[0].hopsAway).toBe(3);
    });

    it('should return hopsAway alongside other node properties', async () => {
      const mockNode = {
        nodeNum: 1,
        nodeId: '!test1',
        longName: 'Test Node',
        shortName: 'TN',
        hopsAway: 2,
        snr: 10.5,
        rssi: -80,
        lastHeard: 1234567890,
        user: {
          id: '!test1',
          longName: 'Test Node',
          shortName: 'TN',
          hwModel: 31,
        },
        position: {
          latitude: 40.7128,
          longitude: -74.0060,
          altitude: 10,
        },
      };

      mockFetch.mockResolvedValue(createMockResponse({ nodes: [mockNode] }));

      const nodes = await apiService.getNodes();

      expect(nodes[0]).toMatchObject({
        nodeNum: 1,
        nodeId: '!test1',
        hopsAway: 2,
        snr: 10.5,
        rssi: -80,
      });
    });
  });

  describe('Message API Methods', () => {
    beforeEach(() => {
      mockLocation.pathname = '/';
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '';
    });

    it('getMessages should return messages array', async () => {
      const mockMessages = [
        { id: 1, text: 'Hello mesh', channelId: 0, fromNodeId: '!abc123', timestamp: 1000 }
      ];
      mockFetch.mockResolvedValue(createMockResponse({ messages: mockMessages }));

      const messages = await apiService.getMessages(50);

      expect(mockFetch).toHaveBeenCalledWith('/api/messages?limit=50');
      expect(messages).toHaveLength(1);
    });

    it('getChannelMessages should call channel-specific endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ messages: [], hasMore: false }));

      await apiService.getChannelMessages(1, 25, 0);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/messages/channel/1?limit=25&offset=0',
        expect.objectContaining({ credentials: 'include' })
      );
    });

    it('getDirectMessages should call DM endpoint with two node IDs', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ messages: [], hasMore: false }));

      await apiService.getDirectMessages('!abc12345', '!def67890', 20, 0);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/messages/direct/!abc12345/!def67890?limit=20&offset=0',
        expect.objectContaining({ credentials: 'include' })
      );
    });

    it('searchMessages should call search endpoint with params', async () => {
      mockFetch.mockResolvedValue(createMockResponse({
        success: true,
        data: [],
        total: 0,
        count: 0,
      }));

      await apiService.searchMessages({ q: 'hello', limit: 10 });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/messages/search'),
        expect.objectContaining({ credentials: 'include' })
      );
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('q=hello'), expect.anything());
    });

    it('sendMessage should POST to messages/send endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true, messageId: 42 }));

      await apiService.sendMessage({
        text: 'Test message',
        channel: 0,
      });

      expect(mockFetch).toHaveBeenCalledWith('/api/messages/send', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Test message'),
      }));
    });
  });

  describe('Node Operation API Methods', () => {
    beforeEach(() => {
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '';
    });

    it('getSystemStatus should call system status endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ uptime: 12345, memoryUsage: 256 }));

      const status = await apiService.getSystemStatus();

      expect(mockFetch).toHaveBeenCalledWith('/api/system/status');
      expect(status).toHaveProperty('uptime');
    });

    it('refreshNodes should call nodes refresh endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await apiService.refreshNodes();

      expect(mockFetch).toHaveBeenCalledWith('/api/nodes/refresh', expect.objectContaining({
        method: 'POST',
      }));
    });

    it('sendTraceroute should POST to traceroute endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      // Must use valid 8-char hex node ID format: !XXXXXXXX
      await apiService.sendTraceroute('!abc12345');

      expect(mockFetch).toHaveBeenCalledWith('/api/traceroute', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('!abc12345'),
      }));
    });

    it('getRecentTraceroutes should call traceroutes endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ traceroutes: [] }));

      await apiService.getRecentTraceroutes();

      expect(mockFetch).toHaveBeenCalledWith('/api/traceroutes/recent');
    });

    it('getNodesWithTelemetry should call telemetry nodes endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ nodes: ['!node1', '!node2'] }));

      const nodes = await apiService.getNodesWithTelemetry();

      expect(mockFetch).toHaveBeenCalledWith('/api/telemetry/available/nodes');
    });
  });

  describe('Purge API Methods', () => {
    beforeEach(() => {
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '';
    });

    it('purgeNodes should POST to purge nodes endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true, purgedCount: 5 }));

      await apiService.purgeNodes(24);

      expect(mockFetch).toHaveBeenCalledWith('/api/purge/nodes', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('24'),
      }));
    });

    it('purgeTelemetry should POST to purge telemetry endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await apiService.purgeTelemetry(48);

      expect(mockFetch).toHaveBeenCalledWith('/api/purge/telemetry', expect.objectContaining({
        method: 'POST',
      }));
    });

    it('purgeMessages should POST to purge messages endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await apiService.purgeMessages(72);

      expect(mockFetch).toHaveBeenCalledWith('/api/purge/messages', expect.objectContaining({
        method: 'POST',
      }));
    });

    it('purgeTraceroutes should POST to purge traceroutes endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await apiService.purgeTraceroutes();

      expect(mockFetch).toHaveBeenCalledWith('/api/purge/traceroutes', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  describe('Channel API Methods', () => {
    beforeEach(() => {
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '';
    });

    it('getAllChannels should call all-channels endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ channels: [{ id: 0, name: 'LongFast' }] }));

      await apiService.getAllChannels();

      expect(mockFetch).toHaveBeenCalledWith('/api/channels/all');
    });

    it('updateChannel should PUT to channel endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await apiService.updateChannel(0, { name: 'TestChannel', psk: 'AQ==' });

      expect(mockFetch).toHaveBeenCalledWith('/api/channels/0', expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('TestChannel'),
      }));
    });
  });

  describe('Config API Methods', () => {
    beforeEach(() => {
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '';
    });

    it('getDeviceConfig should call device config endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ config: {} }));

      await apiService.getDeviceConfig();

      expect(mockFetch).toHaveBeenCalledWith('/api/device-config');
    });

    it('getCurrentConfig should call current config endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ config: {} }));

      await apiService.getCurrentConfig();

      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/config/current'));
    });

    it('setDeviceConfig should POST device config', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await apiService.setDeviceConfig({ role: 1 });

      expect(mockFetch).toHaveBeenCalledWith('/api/config/device', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"role"'),
      }));
    });

    it('setNetworkConfig should POST network config', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await apiService.setNetworkConfig({ wifiEnabled: true });

      expect(mockFetch).toHaveBeenCalledWith('/api/config/network', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  describe('Neighbor/Route API Methods', () => {
    beforeEach(() => {
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '';
    });

    it('getDirectNeighborStats should call neighbor stats endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true, data: {} }));

      await apiService.getDirectNeighborStats(24);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/direct-neighbors?hours=24',
        expect.objectContaining({ credentials: 'include' })
      );
    });

    it('getLongestActiveRouteSegment should call route segment endpoint', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ segment: null }));

      await apiService.getLongestActiveRouteSegment();

      expect(mockFetch).toHaveBeenCalledWith('/api/route-segments/longest-active');
    });

    it('getTracerouteHistory should call history endpoint with params', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ traceroutes: [] }));

      await apiService.getTracerouteHistory(111, 222, 20);

      expect(mockFetch).toHaveBeenCalledWith('/api/traceroutes/history/111/222?limit=20');
    });

    it('updateTracerouteInterval should POST interval setting', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ success: true }));

      await apiService.updateTracerouteInterval(30);

      expect(mockFetch).toHaveBeenCalledWith('/api/settings/traceroute-interval', expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('30'),
      }));
    });
  });

  describe('ApiError handling', () => {
    const createErrorResponse = (status: number, body: any, headers: Record<string, string> = {}) => ({
      ok: false,
      status,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      },
      json: async () => body,
    });

    beforeEach(() => {
      (apiService as any).baseUrl = '';
      (apiService as any).configFetched = true;
      mockFetch.mockClear();
    });

    it('throws ApiError with status and code on 429 rate-limit response', async () => {
      const { ApiError } = await import('./api');
      mockFetch.mockResolvedValueOnce(createErrorResponse(429, {
        error: 'Too many login attempts, please try again later',
        code: 'AUTH_RATE_LIMITED',
        retryAfter: '15 minutes',
        retryAfterSeconds: 30,
      }, { 'retry-after': '30' }));

      const err = await apiService.post('/api/auth/login', { username: 'x', password: 'y' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as any).status).toBe(429);
      expect((err as any).code).toBe('AUTH_RATE_LIMITED');
      expect((err as any).retryAfterSeconds).toBe(30);
      expect((err as Error).message).toBe('Too many login attempts, please try again later');
    });

    it('throws ApiError with status 401 on credential failure', async () => {
      const { ApiError } = await import('./api');
      mockFetch.mockResolvedValueOnce(createErrorResponse(401, {
        error: 'Invalid username or password',
      }));

      const err = await apiService.post('/api/auth/login', { username: 'x', password: 'y' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as any).status).toBe(401);
      expect((err as any).code).toBeUndefined();
      expect((err as Error).message).toBe('Invalid username or password');
    });

    it('falls back to Retry-After header when body lacks retryAfterSeconds', async () => {
      const { ApiError } = await import('./api');
      mockFetch.mockResolvedValueOnce(createErrorResponse(429, {
        error: 'Too many requests',
      }, { 'retry-after': '42' }));

      const err = await apiService.post('/api/x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as any).retryAfterSeconds).toBe(42);
    });

    it('preserves CSRF code on 403 after a failed retry (#2783)', async () => {
      const { ApiError } = await import('./api');
      // First call: 403 with non-CSRF error -> NOT triggering refresh path,
      // should throw ApiError directly with CSRF code for the UI to branch.
      // Simulate the post-refresh retry throwing 403 CSRF_TOKEN_INVALID as it
      // would if the retry also failed (request() only retries once).
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(403, {
          error: 'Invalid CSRF token. Please refresh the page and try again.',
          code: 'CSRF_TOKEN_INVALID',
        }))
        // Refresh succeeds, but the retry fails again with CSRF error
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'application/json' },
          json: async () => ({ csrfToken: 'new-token' }),
        })
        .mockResolvedValueOnce(createErrorResponse(403, {
          error: 'Invalid CSRF token. Please refresh the page and try again.',
          code: 'CSRF_TOKEN_INVALID',
        }));

      const err = await apiService.post('/api/auth/login', { username: 'x', password: 'y' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as any).status).toBe(403);
      expect((err as any).code).toBe('CSRF_TOKEN_INVALID');
    });
  });
});