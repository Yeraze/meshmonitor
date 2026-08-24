/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import MapAnalysisToolbar from './MapAnalysisToolbar';
import { MapAnalysisProvider } from './MapAnalysisContext';

// #4447: the Back to Sources button must navigate with `showList` state.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

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

// ---- Grouped-toolbar helpers (#4871) ----
// Controls now live inside labeled dropdown menus (View / Tools / Layers /
// Analysis) instead of a flat button row. Each item is a role=menuitemcheckbox
// whose active state is `aria-checked` and disabled state is `aria-disabled`.
const MENU_OF: Record<string, string> = {
  'Follow': 'View', 'Auto-zoom': 'View', 'Time Slider': 'View', '3D View': 'View',
  'Measure': 'Tools', 'Link Profile': 'Tools', 'Site Planner': 'Tools',
  'Markers': 'Layers', 'Hop Shading': 'Layers', 'Waypoints': 'Layers',
  'Accuracy Regions': 'Layers', 'ATAK Contacts': 'Layers', 'Polar Grid': 'Layers', 'GNSS DOP': 'Layers',
  'Traceroutes': 'Analysis', 'Neighbors': 'Analysis', 'Heatmap': 'Analysis',
  'Trails': 'Analysis', 'SNR Overlay': 'Analysis',
};

const trigger = (menu: string) => screen.getByRole('button', { name: new RegExp(`^${menu}`, 'i') });

/** Open a menu if not already open (idempotent — clicking a trigger toggles). */
const openMenu = (menu: string) => {
  const t = trigger(menu);
  if (t.getAttribute('aria-expanded') !== 'true') fireEvent.click(t);
};

/** Open the owning menu and return the item row for `label`. */
const item = (label: string) => {
  openMenu(MENU_OF[label]);
  return screen.getByRole('menuitemcheckbox', { name: label });
};

const isActive = (el: HTMLElement) => el.getAttribute('aria-checked') === 'true';
const isDisabled = (el: HTMLElement) => el.getAttribute('aria-disabled') === 'true';

describe('MapAnalysisToolbar', () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockClear();
    elevationEnabled = true;
    unifiedNodes = [];
    terrainCapabilities = { enabled: true, terrainTiles: true, isLoading: false };
  });

  it('renders the four grouped menu triggers', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    for (const menu of ['View', 'Tools', 'Layers', 'Analysis']) {
      expect(trigger(menu)).toBeInTheDocument();
    }
  });

  it('renders all layer toggles inside their menus', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    for (const label of ['Markers', 'Traceroutes', 'Neighbors', 'Heatmap', 'Trails', 'Hop Shading', 'SNR Overlay']) {
      expect(item(label)).toBeInTheDocument();
    }
  });

  it('renders the Polar Grid toggle disabled when no source has an own-node position (#3971)', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    expect(isDisabled(item('Polar Grid'))).toBe(true);
  });

  it('toggles a layer and persists to localStorage', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    fireEvent.click(item('Traceroutes'));
    const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
    expect(stored.layers.traceroutes.enabled).toBe(true);
  });

  // issue #3788 P2 WP-D, spec test #5 (optional).
  it('renders Follow and Auto-zoom toggles, inactive by default', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    expect(isActive(item('Follow'))).toBe(false);
    expect(isActive(item('Auto-zoom'))).toBe(false);
  });

  it('toggles Follow independently of Auto-zoom, marks it active, and persists', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    fireEvent.click(item('Follow'));
    expect(isActive(item('Follow'))).toBe(true);
    expect(isActive(item('Auto-zoom'))).toBe(false);
    const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
    expect(stored.followMode).toBe(true);
    expect(stored.autoZoom).toBe(false);
  });

  it('toggles Auto-zoom independently of Follow, marks it active, and persists', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    fireEvent.click(item('Auto-zoom'));
    expect(isActive(item('Auto-zoom'))).toBe(true);
    expect(isActive(item('Follow'))).toBe(false);
    const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
    expect(stored.autoZoom).toBe(true);
    expect(stored.followMode).toBe(false);
  });

  // #4871: each menu trigger badges its active-item count so grouping doesn't
  // hide which layers are on.
  it('shows an active-count badge on a menu trigger reflecting enabled items', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    // No badge while nothing in View is active.
    expect(within(trigger('View')).queryByText('1')).toBeNull();
    fireEvent.click(item('Follow'));
    expect(within(trigger('View')).getByText('1')).toBeInTheDocument();
  });

  // #4111 Phase 2: Terrain Link Profile toolbar control.
  describe('Link Profile control (#4111)', () => {
    it('is hidden entirely when elevationEnabled is false', () => {
      elevationEnabled = false;
      render(<MapAnalysisToolbar />, { wrapper });
      openMenu('Tools');
      expect(screen.queryByRole('menuitemcheckbox', { name: 'Link Profile' })).toBeNull();
    });

    it('is present but disabled when elevationEnabled is true with fewer than two positioned nodes', () => {
      elevationEnabled = true;
      unifiedNodes = [];
      render(<MapAnalysisToolbar />, { wrapper });
      expect(isDisabled(item('Link Profile'))).toBe(true);
    });

    it('is enabled with two positioned nodes and toggles linkProfileMode, clearing measureMode', () => {
      elevationEnabled = true;
      unifiedNodes = [
        { nodeNum: 1, latitude: 10, longitude: 20 },
        { nodeNum: 2, latitude: 11, longitude: 21 },
      ];
      render(<MapAnalysisToolbar />, { wrapper });
      expect(isDisabled(item('Measure'))).toBe(false);
      expect(isDisabled(item('Link Profile'))).toBe(false);

      // Turn Measure on first.
      fireEvent.click(item('Measure'));
      expect(isActive(item('Measure'))).toBe(true);
      expect(isActive(item('Link Profile'))).toBe(false);

      // Turning Link Profile on must clear Measure (mutual exclusivity).
      fireEvent.click(item('Link Profile'));
      expect(isActive(item('Link Profile'))).toBe(true);
      expect(isActive(item('Measure'))).toBe(false);

      // Turning Measure back on must clear Link Profile.
      fireEvent.click(item('Measure'));
      expect(isActive(item('Measure'))).toBe(true);
      expect(isActive(item('Link Profile'))).toBe(false);
    });
  });

  // #3826 Phase 2 WP-D: 2D/3D toggle control.
  describe('3D View toggle', () => {
    it('is disabled with an "Elevation is disabled" tooltip when elevation is off', () => {
      terrainCapabilities = { enabled: false, terrainTiles: false, isLoading: false };
      render(<MapAnalysisToolbar />, { wrapper });
      const el = item('3D View');
      expect(isDisabled(el)).toBe(true);
      expect(el).toHaveAttribute('title', 'Elevation is disabled');
    });

    it('is disabled with a configured-elevation-source tooltip when enabled but tiles are unavailable', () => {
      terrainCapabilities = { enabled: true, terrainTiles: false, isLoading: false };
      render(<MapAnalysisToolbar />, { wrapper });
      const el = item('3D View');
      expect(isDisabled(el)).toBe(true);
      expect(el).toHaveAttribute('title', '3D terrain is unavailable with the configured elevation source');
    });

    it('is neutrally disabled (no unavailability tooltip) while capabilities are loading', () => {
      terrainCapabilities = { enabled: false, terrainTiles: false, isLoading: true };
      render(<MapAnalysisToolbar />, { wrapper });
      const el = item('3D View');
      expect(isDisabled(el)).toBe(true);
      expect(el).not.toHaveAttribute('title', 'Elevation is disabled');
      expect(el).not.toHaveAttribute('title', '3D terrain is unavailable with the configured elevation source');
    });

    it('is enabled and toggles viewMode, persisting to localStorage, when capabilities allow it', () => {
      render(<MapAnalysisToolbar />, { wrapper });
      expect(isDisabled(item('3D View'))).toBe(false);
      expect(isActive(item('3D View'))).toBe(false);

      fireEvent.click(item('3D View'));
      expect(isActive(item('3D View'))).toBe(true);
      expect(JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!).viewMode).toBe('3d');

      fireEvent.click(item('3D View'));
      expect(isActive(item('3D View'))).toBe(false);
      expect(JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!).viewMode).toBe('2d');
    });

    it('reflects a persisted viewMode of 3d as active on mount', () => {
      localStorage.setItem('mapAnalysis.config.v1', JSON.stringify({ version: 1, viewMode: '3d' }));
      render(<MapAnalysisToolbar />, { wrapper });
      expect(isActive(item('3D View'))).toBe(true);
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
        const el = item(label);
        expect(isDisabled(el)).toBe(true);
        expect(el).toHaveAttribute('title', `${label} — 2D view only`);
      },
    );

    it.each(['Markers', 'Traceroutes', 'Neighbors'])('leaves %s enabled in 3D (the 3D canvas draws it)', (label) => {
      render3d();
      expect(isDisabled(item(label))).toBe(false);
    });

    it('leaves every layer toggle enabled in 2D', () => {
      render(<MapAnalysisToolbar />, { wrapper });
      // Polar Grid is excluded: it has its own #3971 own-node-position gate.
      for (const label of ['Heatmap', 'Trails', 'Waypoints', 'SNR Overlay', 'ATAK Contacts']) {
        expect(isDisabled(item(label))).toBe(false);
      }
    });

    it('re-enables the 2D-only toggles when a persisted 3d is force-corrected to 2D', () => {
      terrainCapabilities = { enabled: false, terrainTiles: false, isLoading: false };
      localStorage.setItem('mapAnalysis.config.v1', JSON.stringify({ version: 1, viewMode: '3d' }));
      render(<MapAnalysisToolbar />, { wrapper });
      expect(isDisabled(item('Heatmap'))).toBe(false);
    });

    it('still gates while capabilities are loading (3D is what is on screen)', () => {
      terrainCapabilities = { enabled: false, terrainTiles: false, isLoading: true };
      localStorage.setItem('mapAnalysis.config.v1', JSON.stringify({ version: 1, viewMode: '3d' }));
      render(<MapAnalysisToolbar />, { wrapper });
      expect(isDisabled(item('Heatmap'))).toBe(true);
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
      const el = item('Heatmap');
      expect(isDisabled(el)).toBe(true);
      expect(isActive(el)).toBe(true);
    });
  });

  describe('Back to Sources button (#4447)', () => {
    it('navigates with showList so the dashboard does not bounce to the default landing page', () => {
      render(<MapAnalysisToolbar />, { wrapper });
      fireEvent.click(screen.getByRole('button', { name: /back to sources/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/', { state: { showList: true } });
    });
  });
});
