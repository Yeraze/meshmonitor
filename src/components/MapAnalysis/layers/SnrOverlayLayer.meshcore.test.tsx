/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider, useMapAnalysisCtx } from '../MapAnalysisContext';
import SnrOverlayLayer from './SnrOverlayLayer';

const PK = 'ab'.repeat(32);

vi.mock('react-leaflet', () => ({
  CircleMarker: ({ center, eventHandlers, pathOptions }: {
    center: [number, number];
    eventHandlers?: { click?: () => void };
    pathOptions?: { color?: string };
  }) => (
    <div data-testid="snr-dot" data-lat={center[0]} data-color={pathOptions?.color} onClick={() => eventHandlers?.click?.()} />
  ),
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  usePositions: () => ({
    items: [
      { nodeNum: 5, nodeKey: 'mt:5', sourceId: 'a', latitude: 1, longitude: 1, timestamp: 10 },
      { nodeNum: 5, nodeKey: `mc:${PK}`, sourceId: 'a', latitude: 2, longitude: 2, timestamp: 10 },
    ],
    isLoading: false,
    progress: { percent: 100, loaded: 2, estimatedTotal: 2 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({
    nodes: [
      { nodeNum: 5, sourceId: 'a', latitude: 1, longitude: 1, snr: 8 },
      // MeshCore node whose synthetic nodeNum equals the Meshtastic node's
      { nodeNum: 5, isMeshCore: true, publicKey: PK, sourceId: 'a', latitude: 2, longitude: 2, snr: -10 },
    ],
  }),
}));

const Probe = () => {
  const { selected } = useMapAnalysisCtx();
  return <div data-testid="sel">{JSON.stringify(selected)}</div>;
};

beforeEach(() => {
  localStorage.setItem(
    'mapAnalysis.config.v1',
    JSON.stringify({
      version: 1,
      layers: {
        markers: { enabled: false, lookbackHours: null },
        traceroutes: { enabled: false, lookbackHours: 24 },
        neighbors: { enabled: false, lookbackHours: 24 },
        heatmap: { enabled: false, lookbackHours: 24 },
        trails: { enabled: false, lookbackHours: 24 },
        hopShading: { enabled: false, lookbackHours: null },
        snrOverlay: { enabled: true, lookbackHours: 24 },
      },
      sources: [],
      timeSlider: { enabled: false },
      inspectorOpen: true,
    }),
  );
});

describe('SnrOverlayLayer with MeshCore nodes', () => {
  it('draws one dot per nodeKey with its own SNR colour and selects by nodeKey', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MapAnalysisProvider>
          <SnrOverlayLayer />
          <Probe />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    const dots = screen.getAllByTestId('snr-dot');
    expect(dots).toHaveLength(2);
    const byLat = Object.fromEntries(dots.map((d) => [d.getAttribute('data-lat'), d.getAttribute('data-color')]));
    expect(byLat['1']).not.toBe(byLat['2']);
    fireEvent.click(dots.find((d) => d.getAttribute('data-lat') === '2')!);
    expect(JSON.parse(screen.getByTestId('sel').textContent!)).toMatchObject({ type: 'node', nodeKey: `mc:${PK}` });
  });
});
