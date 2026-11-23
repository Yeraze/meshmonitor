/**
 * Tests for useTelemetry hooks
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import {
  useTelemetry,
  useSolarIrradiance,
  useNodeVoltages,
  type TelemetryData,
} from './useTelemetry';

// The telemetry endpoint requires a sourceId; the hook resolves a fallback via
// useResolvedSourceId. Pin it so URL assertions are deterministic.
vi.mock('./useResolvedSourceId', () => ({ useResolvedSourceId: () => 'src-test' }));

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

  return {
    client,
    wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    },
  };
}

// Sample telemetry data factory
function makeTelemetryRow(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    id: 1,
    nodeId: '!abc123',
    nodeNum: 12345,
    telemetryType: 'batteryLevel',
    timestamp: 1700000000000,
    value: 85,
    createdAt: 1700000000000,
    ...overrides,
  };
}

describe('useTelemetry hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('useTelemetry', () => {
    it('should fetch and return telemetry data for a node', async () => {
      const mockData: TelemetryData[] = [
        makeTelemetryRow({ id: 1, telemetryType: 'batteryLevel', value: 85 }),
        makeTelemetryRow({ id: 2, telemetryType: 'temperature', value: 22 }),
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useTelemetry({ nodeId: '!abc123' }), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual(mockData);
      expect(result.current.data).toHaveLength(2);
    });

    it('should call the correct URL with default hours=24', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const { wrapper } = createWrapper();
      renderHook(() => useTelemetry({ nodeId: '!abc123' }), { wrapper });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/telemetry/!abc123?hours=24&sourceId=src-test');
      });
    });

    it('should call the correct URL with custom hours', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const { wrapper } = createWrapper();
      renderHook(() => useTelemetry({ nodeId: '!abc123', hours: 48 }), { wrapper });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/telemetry/!abc123?hours=48&sourceId=src-test');
      });
    });

    it('should use baseUrl when provided', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const { wrapper } = createWrapper();
      renderHook(
        () => useTelemetry({ nodeId: '!abc123', baseUrl: 'http://localhost:3000' }),
        { wrapper }
      );

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('http://localhost:3000/api/telemetry/!abc123?hours=24&sourceId=src-test');
      });
    });

    it('should throw an error when response is not ok', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useTelemetry({ nodeId: '!abc123' }), { wrapper });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeInstanceOf(Error);
      expect((result.current.error as Error).message).toContain('500');
      expect((result.current.error as Error).message).toContain('Internal Server Error');
    });

    it('should be disabled when nodeId is empty', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useTelemetry({ nodeId: '' }), { wrapper });

      expect(result.current.fetchStatus).toBe('idle');
      expect(result.current.data).toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should be disabled when enabled=false', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useTelemetry({ nodeId: '!abc123', enabled: false }),
        { wrapper }
      );

      expect(result.current.fetchStatus).toBe('idle');
      expect(result.current.data).toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return loading state initially', () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise(() => {}) // never resolves
      );

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useTelemetry({ nodeId: '!abc123' }), { wrapper });

      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('useSolarIrradiance', () => {
    // Already hour-aligned, so the hook sends them unchanged.
    const startTimestamp = 1699999200; // 21:00 UTC
    const endTimestamp = 1700085600;
    const base = { sourceId: 'src-a', nodeId: '!abcd1234', startTimestamp, endTimestamp };

    it('maps points to ms timestamps and skips null sunlight', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            enabled: true,
            points: [
              { timestamp: 1700000000, shortwaveRadiation: 420, cloudCover: 10 },
              { timestamp: 1700003600, shortwaveRadiation: null, cloudCover: 80 },
              { timestamp: 1700007200, shortwaveRadiation: 0, cloudCover: null },
            ],
          },
        }),
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSolarIrradiance(base), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const data = result.current.data as Map<number, number>;
      expect(data.size).toBe(2);
      expect(data.get(1700000000 * 1000)).toBe(420);
      expect(data.has(1700003600 * 1000)).toBe(false);
      expect(data.get(1700007200 * 1000)).toBe(0);
    });

    it('calls the irradiance route with source, node and window', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { enabled: false, points: [] } }),
      });

      const { wrapper } = createWrapper();
      renderHook(() => useSolarIrradiance({ ...base, baseUrl: '/mm' }), { wrapper });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          `/mm/api/solar/irradiance?sourceId=src-a&nodeId=%21abcd1234&start=${startTimestamp}&end=${endTimestamp}`
        );
      });
    });

    it('snaps a drifting window to whole hours so the query key holds', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { enabled: true, points: [] } }),
      });

      const { wrapper } = createWrapper();
      renderHook(
        () => useSolarIrradiance({ ...base, startTimestamp: startTimestamp + 125, endTimestamp: endTimestamp - 1800 }),
        { wrapper }
      );

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          `/api/solar/irradiance?sourceId=src-a&nodeId=%21abcd1234&start=${startTimestamp}&end=${endTimestamp}`
        );
      });
    });

    it('clamps the window to 31 days', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { enabled: true, points: [] } }),
      });

      const { wrapper } = createWrapper();
      renderHook(() => useSolarIrradiance({ ...base, startTimestamp: endTimestamp - 90 * 86400 }), { wrapper });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          `/api/solar/irradiance?sourceId=src-a&nodeId=%21abcd1234&start=${endTimestamp - 31 * 86400}&end=${endTimestamp}`
        );
      });
    });

    it('returns an empty Map when the response is not ok', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 403 });

      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSolarIrradiance(base), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.size).toBe(0);
    });

    it.each([
      ['nodeId', { nodeId: '' }],
      ['startTimestamp', { startTimestamp: undefined }],
      ['endTimestamp', { endTimestamp: undefined }],
      ['enabled', { enabled: false }],
    ])('stays idle without %s', (_label, override) => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSolarIrradiance({ ...base, ...override }), { wrapper });
      expect(result.current.fetchStatus).toBe('idle');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('useNodeVoltages', () => {
    it('should return a Map of nodeId to latest voltage value', async () => {
      const node1Data: TelemetryData[] = [
        makeTelemetryRow({ nodeId: '!abc123', telemetryType: 'voltage', value: 3.7, timestamp: 1700000000000 }),
        makeTelemetryRow({ nodeId: '!abc123', telemetryType: 'voltage', value: 3.8, timestamp: 1700003600000 }),
      ];
      const node2Data: TelemetryData[] = [
        makeTelemetryRow({ nodeId: '!def456', telemetryType: 'voltage', value: 4.1, timestamp: 1700000000000 }),
      ];

      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => node1Data })
        .mockResolvedValueOnce({ ok: true, json: async () => node2Data });

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useNodeVoltages({ nodeIds: ['!abc123', '!def456'] }),
        { wrapper }
      );

      await waitFor(() => {
        const map = result.current as Map<string, number>;
        expect(map.size).toBe(2);
      });

      const map = result.current as Map<string, number>;
      // Should pick the latest voltage (timestamp 1700003600000 wins for abc123)
      expect(map.get('!abc123')).toBe(3.8);
      expect(map.get('!def456')).toBe(4.1);
    });

    it('should filter out non-voltage telemetry types', async () => {
      const nodeData: TelemetryData[] = [
        makeTelemetryRow({ telemetryType: 'batteryLevel', value: 85, timestamp: 1700003600000 }),
        makeTelemetryRow({ telemetryType: 'temperature', value: 22, timestamp: 1700003600000 }),
        makeTelemetryRow({ telemetryType: 'voltage', value: 3.9, timestamp: 1700000000000 }),
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => nodeData,
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useNodeVoltages({ nodeIds: ['!abc123'] }),
        { wrapper }
      );

      await waitFor(() => {
        const map = result.current as Map<string, number>;
        expect(map.size).toBe(1);
      });

      const map = result.current as Map<string, number>;
      expect(map.get('!abc123')).toBe(3.9);
    });

    it('should pick the latest voltage by timestamp', async () => {
      const nodeData: TelemetryData[] = [
        makeTelemetryRow({ telemetryType: 'voltage', value: 3.5, timestamp: 1700000000000 }),
        makeTelemetryRow({ telemetryType: 'voltage', value: 4.0, timestamp: 1700010000000 }),
        makeTelemetryRow({ telemetryType: 'voltage', value: 3.2, timestamp: 1699990000000 }),
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => nodeData,
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useNodeVoltages({ nodeIds: ['!abc123'] }),
        { wrapper }
      );

      await waitFor(() => {
        const map = result.current as Map<string, number>;
        expect(map.size).toBe(1);
      });

      expect((result.current as Map<string, number>).get('!abc123')).toBe(4.0);
    });

    it('should return empty Map when nodeIds is empty', () => {
      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useNodeVoltages({ nodeIds: [] }),
        { wrapper }
      );

      expect(result.current).toBeInstanceOf(Map);
      expect((result.current as Map<string, number>).size).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should omit a node from the Map when fetch returns non-ok', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useNodeVoltages({ nodeIds: ['!abc123'] }),
        { wrapper }
      );

      await waitFor(() => {
        // Query should settle (null result means node omitted)
        expect(global.fetch).toHaveBeenCalled();
      });

      // Wait for query to complete
      await waitFor(() => {
        // useNodeVoltages returns null for failed fetches, so the node won't be in the map
        expect(result.current).toBeInstanceOf(Map);
      });

      const map = result.current as Map<string, number>;
      expect(map.has('!abc123')).toBe(false);
    });

    it('should omit a node when no voltage rows exist', async () => {
      const nodeData: TelemetryData[] = [
        makeTelemetryRow({ telemetryType: 'batteryLevel', value: 80 }),
        makeTelemetryRow({ telemetryType: 'temperature', value: 25 }),
      ];

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => nodeData,
      });

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useNodeVoltages({ nodeIds: ['!abc123'] }),
        { wrapper }
      );

      await waitFor(() => expect(global.fetch).toHaveBeenCalled());

      await waitFor(() => {
        expect(result.current).toBeInstanceOf(Map);
      });

      const map = result.current as Map<string, number>;
      expect(map.has('!abc123')).toBe(false);
    });

    it('should omit a node when fetch throws', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useNodeVoltages({ nodeIds: ['!abc123'] }),
        { wrapper }
      );

      await waitFor(() => expect(global.fetch).toHaveBeenCalled());

      await waitFor(() => {
        expect(result.current).toBeInstanceOf(Map);
      });

      const map = result.current as Map<string, number>;
      expect(map.has('!abc123')).toBe(false);
    });

    it('should use baseUrl for all node fetches', async () => {
      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => [] })
        .mockResolvedValueOnce({ ok: true, json: async () => [] });

      const { wrapper } = createWrapper();
      renderHook(
        () => useNodeVoltages({ nodeIds: ['!abc123', '!def456'], baseUrl: 'http://localhost:3000' }),
        { wrapper }
      );

      await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/telemetry/!abc123?hours=720'
      );
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/telemetry/!def456?hours=720'
      );
    });

    it('should handle multiple nodes independently (one fails, one succeeds)', async () => {
      const voltageData: TelemetryData[] = [
        makeTelemetryRow({ nodeId: '!abc123', telemetryType: 'voltage', value: 3.7, timestamp: 1700000000000 }),
      ];

      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => voltageData })
        .mockRejectedValueOnce(new Error('Network error'));

      const { wrapper } = createWrapper();
      const { result } = renderHook(
        () => useNodeVoltages({ nodeIds: ['!abc123', '!def456'] }),
        { wrapper }
      );

      await waitFor(() => {
        const map = result.current as Map<string, number>;
        expect(map.has('!abc123')).toBe(true);
      });

      const map = result.current as Map<string, number>;
      expect(map.get('!abc123')).toBe(3.7);
      expect(map.has('!def456')).toBe(false);
    });
  });
});
