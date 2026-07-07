/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import MapAnalysisToolbar from './MapAnalysisToolbar';
import { MapAnalysisProvider } from './MapAnalysisContext';

vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }),
  // The Polar Grid toggle resolves own-node positions via these hooks (#3971).
  useDashboardUnifiedData: () => ({ nodes: [] }),
  useSourceStatuses: () => new Map(),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MapAnalysisProvider>{children}</MapAnalysisProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

describe('MapAnalysisToolbar', () => {
  beforeEach(() => localStorage.clear());

  it('renders all 7 layer toggles', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    for (const label of ['Markers', 'Traceroutes', 'Neighbors', 'Heatmap', 'Trails', 'Hop Shading', 'SNR Overlay']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('renders the Polar Grid toggle disabled when no source has an own-node position (#3971)', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    const btn = screen.getByRole('button', { name: /polar grid/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it('toggles a layer and persists to localStorage', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /traceroutes/i }));
    const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
    expect(stored.layers.traceroutes.enabled).toBe(true);
  });
});
