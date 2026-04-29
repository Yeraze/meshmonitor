/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import RangeRingsLayer from './RangeRingsLayer';

vi.mock('react-leaflet', () => ({
  Circle: (p: { radius: number }) => (
    <div data-testid="ring" data-radius={p.radius} />
  ),
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

describe('RangeRingsLayer', () => {
  it('renders one circle per node at configured radius (km converted to meters)', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider>
          <RangeRingsLayer />
        </MapAnalysisProvider>
      </QueryClientProvider>,
    );
    const rings = screen.getAllByTestId('ring');
    expect(rings).toHaveLength(2);
    expect(rings[0].getAttribute('data-radius')).toBe('5000');
  });
});
