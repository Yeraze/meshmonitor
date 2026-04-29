/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import NeighborLinksLayer from './NeighborLinksLayer';

vi.mock('react-leaflet', () => ({
  Polyline: () => <div data-testid="poly" />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useNeighbors: () => ({
    data: {
      items: [
        { id: 1, nodeNum: 1, neighborNum: 2, sourceId: 'a', snr: 5, timestamp: 0 },
      ],
    },
    isLoading: false,
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({
    nodes: [
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 2, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
    ],
  }),
  UNIFIED_SOURCE_ID: '__unified__',
}));

describe('NeighborLinksLayer', () => {
  it('renders one polyline per edge', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <NeighborLinksLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('poly')).toHaveLength(1);
  });
});
