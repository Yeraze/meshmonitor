/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import SnrOverlayLayer from './SnrOverlayLayer';

vi.mock('react-leaflet', () => ({
  CircleMarker: () => <div data-testid="snr-dot" />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  usePositions: () => ({
    items: [
      { nodeNum: 1, sourceId: 'a', latitude: 30, longitude: -90, timestamp: 0 },
      { nodeNum: 2, sourceId: 'a', latitude: 31, longitude: -91, timestamp: 0 },
    ],
    isLoading: false,
    progress: { percent: 100, loaded: 2, estimatedTotal: 2 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
}));

describe('SnrOverlayLayer', () => {
  it('renders one CircleMarker per position', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <SnrOverlayLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('snr-dot')).toHaveLength(2);
  });
});
