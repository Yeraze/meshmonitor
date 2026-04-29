/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import TraceroutePathsLayer from './TraceroutePathsLayer';

vi.mock('react-leaflet', () => ({
  Polyline: () => <div data-testid="polyline" />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useTraceroutes: () => ({
    items: [
      {
        id: 1,
        fromNodeNum: 1,
        toNodeNum: 2,
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
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 2, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
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
  it('renders one polyline per traceroute segment', () => {
    render(<TraceroutePathsLayer />, { wrapper });
    expect(screen.getAllByTestId('polyline').length).toBeGreaterThanOrEqual(1);
  });
});
