/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  useNodeDisplaySettings,
  useMaxNodeAgeHoursAcross,
  parseNodeDisplaySettings,
  maxAcross,
} from './useNodeDisplaySettings';
import apiService from '../services/api';
import {
  NODE_DISPLAY_NUMERIC_DEFAULTS,
  NODE_DISPLAY_BOOLEAN_DEFAULTS,
  NODE_DISPLAY_STRING_DEFAULTS,
} from '../constants/nodeDisplayDefaults';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('parseNodeDisplaySettings', () => {
  it('returns every hardcoded default when raw is undefined', () => {
    const result = parseNodeDisplaySettings(undefined);
    expect(result).toEqual({
      maxNodeAgeHours: NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours,
      inactiveNodeThresholdHours: NODE_DISPLAY_NUMERIC_DEFAULTS.inactiveNodeThresholdHours,
      inactiveNodeCheckIntervalMinutes:
        NODE_DISPLAY_NUMERIC_DEFAULTS.inactiveNodeCheckIntervalMinutes,
      inactiveNodeCooldownHours: NODE_DISPLAY_NUMERIC_DEFAULTS.inactiveNodeCooldownHours,
      localStatsIntervalMinutes: NODE_DISPLAY_NUMERIC_DEFAULTS.localStatsIntervalMinutes,
      nodeHopsCalculation: NODE_DISPLAY_STRING_DEFAULTS.nodeHopsCalculation,
      hideIncompleteNodes: NODE_DISPLAY_BOOLEAN_DEFAULTS.hideIncompleteNodes,
      nodeDimmingEnabled: NODE_DISPLAY_BOOLEAN_DEFAULTS.nodeDimmingEnabled,
      nodeDimmingStartHours: NODE_DISPLAY_NUMERIC_DEFAULTS.nodeDimmingStartHours,
      nodeDimmingMinOpacity: NODE_DISPLAY_NUMERIC_DEFAULTS.nodeDimmingMinOpacity,
    });
  });

  it('parses stored string values through the shared parsers', () => {
    const result = parseNodeDisplaySettings({
      maxNodeAgeHours: '72',
      inactiveNodeThresholdHours: '48',
      inactiveNodeCheckIntervalMinutes: '30',
      inactiveNodeCooldownHours: '12',
      localStatsIntervalMinutes: '5',
      nodeHopsCalculation: 'traceroute',
      hideIncompleteNodes: '1',
      nodeDimmingEnabled: '1',
      nodeDimmingStartHours: '2.5',
      nodeDimmingMinOpacity: '0.6',
    });
    expect(result).toEqual({
      maxNodeAgeHours: 72,
      inactiveNodeThresholdHours: 48,
      inactiveNodeCheckIntervalMinutes: 30,
      inactiveNodeCooldownHours: 12,
      localStatsIntervalMinutes: 5,
      nodeHopsCalculation: 'traceroute',
      hideIncompleteNodes: true,
      nodeDimmingEnabled: true,
      nodeDimmingStartHours: 2.5,
      nodeDimmingMinOpacity: 0.6,
    });
  });

  it('falls back to the default for an unrecognized nodeHopsCalculation value', () => {
    const result = parseNodeDisplaySettings({ nodeHopsCalculation: 'bogus' });
    expect(result.nodeHopsCalculation).toBe(NODE_DISPLAY_STRING_DEFAULTS.nodeHopsCalculation);
  });

  it('out-of-range maxNodeAgeHours (per NODE_DISPLAY_RANGES) clamps to the default', () => {
    const result = parseNodeDisplaySettings({ maxNodeAgeHours: '999' });
    expect(result.maxNodeAgeHours).toBe(NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours);
  });
});

describe('maxAcross', () => {
  it('returns the hardcoded default for an empty list', () => {
    expect(maxAcross([])).toBe(NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours);
  });

  it('returns the maximum of the list', () => {
    expect(maxAcross([6, 168, 24])).toBe(168);
  });

  it('a single value returns itself', () => {
    expect(maxAcross([1])).toBe(1);
  });
});

describe('useNodeDisplaySettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sourceId === null returns the hardcoded defaults and issues zero network requests', () => {
    const { result } = renderHook(() => useNodeDisplaySettings(null), { wrapper });
    expect(result.current.maxNodeAgeHours).toBe(NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours);
    expect(apiService.get).not.toHaveBeenCalled();
  });

  it('requests /api/settings?sourceId=<id> for a concrete source', async () => {
    vi.mocked(apiService.get).mockResolvedValue({ maxNodeAgeHours: '72' });
    renderHook(() => useNodeDisplaySettings('source-a'), { wrapper });
    await waitFor(() =>
      expect(apiService.get).toHaveBeenCalledWith('/api/settings?sourceId=source-a'),
    );
  });

  it('parses the resolved response into the ten values', async () => {
    vi.mocked(apiService.get).mockResolvedValue({
      maxNodeAgeHours: '72',
      nodeDimmingEnabled: '1',
    });
    const { result } = renderHook(() => useNodeDisplaySettings('source-a'), { wrapper });
    await waitFor(() => expect(result.current.maxNodeAgeHours).toBe(72));
    expect(result.current.nodeDimmingEnabled).toBe(true);
  });
});

describe('useMaxNodeAgeHoursAcross', () => {
  beforeEach(() => vi.clearAllMocks());

  it('empty source list returns the hardcoded default', () => {
    const { result } = renderHook(() => useMaxNodeAgeHoursAcross([]), { wrapper });
    expect(result.current).toBe(NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours);
  });

  it('returns the maximum, not the first or last source', async () => {
    vi.mocked(apiService.get).mockImplementation((url: string) => {
      if (url.includes('source-a')) return Promise.resolve({ maxNodeAgeHours: '6' });
      if (url.includes('source-b')) return Promise.resolve({ maxNodeAgeHours: '168' });
      return Promise.resolve({ maxNodeAgeHours: '24' });
    });
    const { result } = renderHook(
      () => useMaxNodeAgeHoursAcross(['source-a', 'source-b', 'source-c']),
      { wrapper },
    );
    await waitFor(() => expect(result.current).toBe(168));
  });

  it('a still-loading source does not drag the max down', async () => {
    vi.mocked(apiService.get).mockImplementation((url: string) => {
      if (url.includes('source-a')) return Promise.resolve({ maxNodeAgeHours: '168' });
      // source-b never resolves within this test.
      return new Promise(() => {});
    });
    const { result } = renderHook(() => useMaxNodeAgeHoursAcross(['source-a', 'source-b']), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toBe(168));
  });

  it('all sources still loading returns the hardcoded default', () => {
    vi.mocked(apiService.get).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useMaxNodeAgeHoursAcross(['source-a', 'source-b']), {
      wrapper,
    });
    expect(result.current).toBe(NODE_DISPLAY_NUMERIC_DEFAULTS.maxNodeAgeHours);
  });
});
