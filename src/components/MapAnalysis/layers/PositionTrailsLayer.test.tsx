/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import PositionTrailsLayer from './PositionTrailsLayer';

vi.mock('react-leaflet', () => ({
  Polyline: () => <div data-testid="poly" />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  usePositions: () => ({
    items: [
      { nodeNum: 1, sourceId: 'a', latitude: 30, longitude: -90, timestamp: 1 },
      { nodeNum: 1, sourceId: 'a', latitude: 30.1, longitude: -90.1, timestamp: 2 },
      { nodeNum: 2, sourceId: 'a', latitude: 31, longitude: -91, timestamp: 1 },
      { nodeNum: 2, sourceId: 'a', latitude: 31.1, longitude: -91.1, timestamp: 2 },
    ],
    isLoading: false,
    progress: { loaded: 4, estimatedTotal: 4, percent: 100 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
}));

describe('PositionTrailsLayer', () => {
  it('renders one polyline per node with 2+ position fixes', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <PositionTrailsLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('poly')).toHaveLength(2);
  });
});
