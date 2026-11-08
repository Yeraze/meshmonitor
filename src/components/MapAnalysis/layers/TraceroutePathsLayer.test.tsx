/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import TraceroutePathsLayer from './TraceroutePathsLayer';

const mc = vi.hoisted(() => ({ links: [] as unknown[] }));

vi.mock('react-leaflet', () => ({
  Polyline: () => <div data-testid="polyline" />,
}));
vi.mock('../../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({
    overlayColors: {
      snrColors: {
        excellent: '#22c55e',
        good: '#eab308',
        fair: '#f97316',
        poor: '#ef4444',
        noData: '#6c7086',
      },
    },
  }),
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useMeshCoreTraceLinks: () => ({ data: { links: mc.links } }),
  useTraceroutes: () => ({
    items: [
      {
        id: 1,
        fromNodeNum: 0x1111,
        toNodeNum: 0x2222,
        sourceId: 'a',
        route: '[]',
        routeBack: '[]',
        snrTowards: '[10]',
        snrBack: '[12]',
        timestamp: 0,
        createdAt: 0,
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
    progress: { loaded: 1, estimatedTotal: 1, percent: 100 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({
    nodes: [
      { nodeNum: 0x1111, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 0x2222, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
      { sourceId: 'a', isMeshCore: true, publicKey: 'AA'.repeat(32), nodeNum: 7, position: { latitude: 32, longitude: -92 } },
      { sourceId: 'a', isMeshCore: true, publicKey: 'bb'.repeat(32), nodeNum: 7, position: { latitude: 33, longitude: -93 } },
    ],
  }),
  UNIFIED_SOURCE_ID: '__unified__',
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>{children}</MapAnalysisProvider>
    </QueryClientProvider>
  );
};

describe('TraceroutePathsLayer', () => {
  beforeEach(() => {
    localStorage.clear();
    mc.links = [];
  });

  it('adds one polyline per resolved MeshCore hop link (shared renderer, key-based ends)', () => {
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({
        version: 1,
        layers: {
          markers: { enabled: false, lookbackHours: null },
          traceroutes: { enabled: true, lookbackHours: 24 },
          neighbors: { enabled: false, lookbackHours: 24 },
          heatmap: { enabled: false, lookbackHours: 24 },
          trails: { enabled: false, lookbackHours: 24 },
          hopShading: { enabled: false, lookbackHours: null },
          snrOverlay: { enabled: false, lookbackHours: 24 },
        },
        sources: [],
        timeSlider: { enabled: false },
        inspectorOpen: true,
      }),
    );
    const { unmount } = render(<TraceroutePathsLayer />, { wrapper });
    const base = screen.getAllByTestId('polyline').length;
    unmount();
    const end = (k: string | null) => ({ publicKey: k, hash: null, candidates: k ? 1 : 0 });
    mc.links = [
      { sourceId: 'a', sender: end('aa'.repeat(32)), receiver: end('bb'.repeat(32)), count: 3, lastSnr: 5, avgSnr: 5, minSnr: 5, maxSnr: 5, lastTimestamp: 1, initiatedCount: 0, points: [] },
      // unresolved end: never drawn
      { sourceId: 'a', sender: end(null), receiver: end('bb'.repeat(32)), count: 3, lastSnr: 5, avgSnr: 5, minSnr: 5, maxSnr: 5, lastTimestamp: 1, initiatedCount: 0, points: [] },
    ];
    render(<TraceroutePathsLayer />, { wrapper });
    expect(screen.getAllByTestId('polyline').length).toBe(base + 1);
  });

  it('renders one polyline per traceroute segment', () => {
    render(<TraceroutePathsLayer />, { wrapper });
    expect(screen.getAllByTestId('polyline').length).toBeGreaterThanOrEqual(1);
  });

  it('excludes traceroutes outside the time slider window when slider is enabled', () => {
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({
        version: 1,
        layers: {
          markers: { enabled: false, lookbackHours: null },
          traceroutes: { enabled: true, lookbackHours: 24 },
          neighbors: { enabled: false, lookbackHours: 24 },
          heatmap: { enabled: false, lookbackHours: 24 },
          trails: { enabled: false, lookbackHours: 24 },
          hopShading: { enabled: false, lookbackHours: null },
          snrOverlay: { enabled: false, lookbackHours: 24 },
        },
        sources: [],
        // Window [10, 20] excludes the mock traceroute at timestamp 0
        timeSlider: { enabled: true, windowStartMs: 10, windowEndMs: 20 },
        inspectorOpen: true,
      }),
    );
    render(<TraceroutePathsLayer />, { wrapper });
    expect(screen.queryAllByTestId('polyline')).toHaveLength(0);
  });
});
