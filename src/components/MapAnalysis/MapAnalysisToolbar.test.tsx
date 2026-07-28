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
  useDashboardUnifiedData: () => ({ nodes: unifiedNodes }),
  useSourceStatuses: () => new Map(),
}));

// #4111 Phase 2: Link Profile button gate. Mutable per-test so a single mock
// factory can serve both the "feature off" and "feature on" cases.
let elevationEnabled = true;
vi.mock('../../hooks/useElevationEnabled', () => ({
  useElevationEnabled: () => elevationEnabled,
}));

// #3826 Phase 2 WP-D: 2D/3D toggle gate. Mutable per-test (mirrors the
// `elevationEnabled` mock above) so the same factory serves every
// enabled/disabled/loading combination.
let terrainCapabilities = { enabled: true, terrainTiles: true, isLoading: false };
vi.mock('../../hooks/useTerrainCapabilities', () => ({
  useTerrainCapabilities: () => terrainCapabilities,
}));

// Two positioned nodes so `analysisNodes.length >= 2` (both Measure and Link
// Profile buttons require this to enable). Empty by default so the existing
// "0 nodes" tests above keep exercising the disabled state.
let unifiedNodes: Array<{ nodeNum: number; latitude: number; longitude: number }> = [];

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
  beforeEach(() => {
    localStorage.clear();
    elevationEnabled = true;
    unifiedNodes = [];
    terrainCapabilities = { enabled: true, terrainTiles: true, isLoading: false };
  });

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

  // issue #3788 P2 WP-D, spec test #5 (optional).
  it('renders Follow and Auto-zoom toggles, inactive by default', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    expect(screen.getByRole('button', { name: 'Follow' })).not.toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Auto-zoom' })).not.toHaveClass('active');
  });

  it('toggles Follow independently of Auto-zoom, carries the active class, and persists', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    expect(screen.getByRole('button', { name: 'Follow' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Auto-zoom' })).not.toHaveClass('active');
    const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
    expect(stored.followMode).toBe(true);
    expect(stored.autoZoom).toBe(false);
  });

  it('toggles Auto-zoom independently of Follow, carries the active class, and persists', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Auto-zoom' }));
    expect(screen.getByRole('button', { name: 'Auto-zoom' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Follow' })).not.toHaveClass('active');
    const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
    expect(stored.autoZoom).toBe(true);
    expect(stored.followMode).toBe(false);
  });

  // #4111 Phase 2: Terrain Link Profile toolbar button.
  describe('Link Profile button (#4111)', () => {
    it('is hidden entirely when elevationEnabled is false', () => {
      elevationEnabled = false;
      render(<MapAnalysisToolbar />, { wrapper });
      expect(screen.queryByRole('button', { name: /link profile/i })).toBeNull();
    });

    it('is present but disabled when elevationEnabled is true with fewer than two positioned nodes', () => {
      elevationEnabled = true;
      unifiedNodes = [];
      render(<MapAnalysisToolbar />, { wrapper });
      const btn = screen.getByRole('button', { name: /link profile/i });
      expect(btn).toBeInTheDocument();
      expect(btn).toBeDisabled();
    });

    it('is enabled with two positioned nodes and toggles linkProfileMode, clearing measureMode', () => {
      elevationEnabled = true;
      unifiedNodes = [
        { nodeNum: 1, latitude: 10, longitude: 20 },
        { nodeNum: 2, latitude: 11, longitude: 21 },
      ];
      render(<MapAnalysisToolbar />, { wrapper });
      const measureBtn = screen.getByRole('button', { name: 'Measure' });
      const linkBtn = screen.getByRole('button', { name: 'Link Profile' });
      expect(measureBtn).not.toBeDisabled();
      expect(linkBtn).not.toBeDisabled();

      // Turn Measure on first.
      fireEvent.click(measureBtn);
      expect(measureBtn).toHaveClass('active');
      expect(linkBtn).not.toHaveClass('active');

      // Turning Link Profile on must clear Measure (mutual exclusivity).
      fireEvent.click(linkBtn);
      expect(linkBtn).toHaveClass('active');
      expect(measureBtn).not.toHaveClass('active');

      // Turning Measure back on must clear Link Profile.
      fireEvent.click(measureBtn);
      expect(measureBtn).toHaveClass('active');
      expect(linkBtn).not.toHaveClass('active');
    });
  });

  // #3826 Phase 2 WP-D: 2D/3D toggle button.
  describe('3D View toggle', () => {
    it('is disabled with an "Elevation is disabled" tooltip when elevation is off', () => {
      terrainCapabilities = { enabled: false, terrainTiles: false, isLoading: false };
      render(<MapAnalysisToolbar />, { wrapper });
      const btn = screen.getByRole('button', { name: '3D View' });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Elevation is disabled');
    });

    it('is disabled with a configured-elevation-source tooltip when enabled but tiles are unavailable', () => {
      terrainCapabilities = { enabled: true, terrainTiles: false, isLoading: false };
      render(<MapAnalysisToolbar />, { wrapper });
      const btn = screen.getByRole('button', { name: '3D View' });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute(
        'title',
        '3D terrain is unavailable with the configured elevation source',
      );
    });

    it('is neutrally disabled (no unavailability tooltip) while capabilities are loading', () => {
      terrainCapabilities = { enabled: false, terrainTiles: false, isLoading: true };
      render(<MapAnalysisToolbar />, { wrapper });
      const btn = screen.getByRole('button', { name: '3D View' });
      expect(btn).toBeDisabled();
      expect(btn).not.toHaveAttribute('title', 'Elevation is disabled');
      expect(btn).not.toHaveAttribute(
        'title',
        '3D terrain is unavailable with the configured elevation source',
      );
    });

    it('is enabled and toggles viewMode, persisting to localStorage, when capabilities allow it', () => {
      render(<MapAnalysisToolbar />, { wrapper });
      const btn = screen.getByRole('button', { name: '3D View' });
      expect(btn).not.toBeDisabled();
      expect(btn).not.toHaveClass('active');

      fireEvent.click(btn);
      expect(btn).toHaveClass('active');
      const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
      expect(stored.viewMode).toBe('3d');

      fireEvent.click(btn);
      expect(btn).not.toHaveClass('active');
      const storedAfter = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
      expect(storedAfter.viewMode).toBe('2d');
    });

    it('reflects a persisted viewMode of 3d as active on mount', () => {
      localStorage.setItem(
        'mapAnalysis.config.v1',
        JSON.stringify({ version: 1, viewMode: '3d' }),
      );
      render(<MapAnalysisToolbar />, { wrapper });
      expect(screen.getByRole('button', { name: '3D View' })).toHaveClass('active');
    });
  });

  // #4371 C: toggles the 3D canvas can't act on are disabled with a reason
  // rather than silently doing nothing.
  describe('2D-only layer toggles in 3D (#4371 C)', () => {
    const render3d = () => {
      localStorage.setItem('mapAnalysis.config.v1', JSON.stringify({ version: 1, viewMode: '3d' }));
      // Give Polar Grid an own-node position so it isn't disabled for that reason.
      unifiedNodes = [{ nodeNum: 1, latitude: 30, longitude: -90 }];
      render(<MapAnalysisToolbar />, { wrapper });
    };

    it.each(['Heatmap', 'Trails', 'Hop Shading', 'SNR Overlay', 'Waypoints', 'Accuracy Regions', 'ATAK Contacts', 'Polar Grid'])(
      'disables %s in 3D and says why',
      (label) => {
        render3d();
        const btn = screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') });
        expect(btn).toBeDisabled();
        expect(btn).toHaveAttribute('title', `${label} — 2D view only`);
      },
    );

    it.each(['Markers', 'Traceroutes', 'Neighbors'])('leaves %s enabled in 3D (the 3D canvas draws it)', (label) => {
      render3d();
      expect(screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })).not.toBeDisabled();
    });

    it('leaves every layer toggle enabled in 2D', () => {
      render(<MapAnalysisToolbar />, { wrapper });
      // Polar Grid is excluded: it has its own #3971 own-node-position gate,
      // covered above.
      for (const label of ['Heatmap', 'Trails', 'Waypoints', 'SNR Overlay', 'ATAK Contacts']) {
        expect(screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') })).not.toBeDisabled();
      }
    });

    it('keeps a 2D-only layer’s persisted state untouched while in 3D', () => {
      localStorage.setItem(
        'mapAnalysis.config.v1',
        JSON.stringify({
          version: 1,
          viewMode: '3d',
          layers: { heatmap: { enabled: true, lookbackHours: 24 } },
        }),
      );
      render(<MapAnalysisToolbar />, { wrapper });
      // Disabled, but still shown as on — switching back to 2D restores it.
      const btn = screen.getByRole('button', { name: /^heatmap$/i });
      expect(btn).toBeDisabled();
      expect(btn).toHaveClass('active');
    });
  });
});
