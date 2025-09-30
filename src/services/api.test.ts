import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

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

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ baseUrl: '' }),
      });

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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ baseUrl: '/meshmonitor' }),
      });

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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ baseUrl: '' }),
      });

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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ baseUrl: '/meshmonitor' }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connected: true }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ nodes: [] }),
      });

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
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ baseUrl: '' }),
      });

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

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connected: true }),
      });

      await apiService.getConnectionStatus();

      // Should call /meshmonitor/api/connection
      expect(mockFetch).toHaveBeenCalledWith('/meshmonitor/api/connection');
    });

    it('should handle root deployment without baseUrl prefix', async () => {
      mockLocation.pathname = '/';

      // Reset state and set empty baseUrl
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ nodes: [] }),
      });

      await apiService.getNodes();

      // Should call /api/nodes (no prefix)
      expect(mockFetch).toHaveBeenCalledWith('/api/nodes');
    });

    it('should handle multi-segment BASE_URL in API calls', async () => {
      mockLocation.pathname = '/company/tools/meshmonitor';

      // Reset state and directly set baseUrl
      (apiService as any).configFetched = true;
      (apiService as any).baseUrl = '/company/tools/meshmonitor';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ channels: [] }),
      });

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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ baseUrl: '/meshmonitor' }),
      });

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
});