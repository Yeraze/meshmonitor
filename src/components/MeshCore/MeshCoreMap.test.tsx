/**
 * @vitest-environment jsdom
 *
 * Light smoke test for the MeshCore map's "Show Polar Grid" toggle (#4047
 * follow-up). Heavy map internals (BaseMap/react-leaflet, the marker/neighbor
 * layers, GeoJSON overlay, legend, measure controller) are stubbed out —
 * this suite only proves the toggle's persistence + disabled/gating contract
 * and that `PolarGridOverlay` is centered on the local node position, not
 * real Leaflet rendering (mirrors the DashboardMap.test.tsx mocking style).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MeshCoreMap } from './MeshCoreMap';

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children: ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

vi.mock('../map/layers/NodeMarkersLayer', () => ({
  NodeMarkersLayer: () => <div data-testid="node-markers-layer" />,
}));

vi.mock('../map/layers/NeighborLinksLayer', () => ({
  NeighborLinksLayer: () => <div data-testid="neighbor-links-layer" />,
}));

vi.mock('../GeoJsonOverlay', () => ({
  default: () => <div data-testid="geojson-overlay" />,
}));

vi.mock('../MapLegend', () => ({
  default: () => <div data-testid="map-legend" />,
}));

vi.mock('../MeasureDistanceController', () => ({
  default: () => null,
}));

vi.mock('../PolarGridOverlay', () => ({
  default: (props: { center: { lat: number; lng: number } }) => (
    <div data-testid="polar-grid-overlay" data-center={JSON.stringify(props.center)} />
  ),
}));

vi.mock('react-leaflet', () => ({
  Popup: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Polyline: () => null,
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ mapTileset: 'osm', customTilesets: [], setMapTileset: vi.fn() }),
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-1' }),
}));

vi.mock('../../services/api', () => ({
  default: {
    getBaseUrl: vi.fn().mockResolvedValue(''),
    get: vi.fn().mockResolvedValue({ success: true, data: { items: [] } }),
  },
}));

vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => vi.fn().mockResolvedValue({ ok: true }),
}));

describe('MeshCoreMap polar grid toggle', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('is disabled with a tooltip when the local node has no position', () => {
    render(<MeshCoreMap contacts={[]} selectedPublicKey={null} localNodePosition={null} />);

    const checkbox = screen.getByLabelText('map.showPolarGrid') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(screen.queryByTestId('polar-grid-overlay')).not.toBeInTheDocument();
  });

  it('renders the shared PolarGridOverlay centered on the local node position when toggled on', () => {
    render(
      <MeshCoreMap
        contacts={[]}
        selectedPublicKey={null}
        localNodePosition={{ lat: 40.1, lng: -105.2 }}
      />,
    );

    const checkbox = screen.getByLabelText('map.showPolarGrid') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    expect(screen.queryByTestId('polar-grid-overlay')).not.toBeInTheDocument();

    fireEvent.click(checkbox);

    const overlay = screen.getByTestId('polar-grid-overlay');
    expect(JSON.parse(overlay.getAttribute('data-center')!)).toEqual({ lat: 40.1, lng: -105.2 });
    expect(localStorage.getItem('meshmonitor-meshcore-showPolarGrid')).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// Loading overlay (initial contacts-snapshot fetch spinner)
// ---------------------------------------------------------------------------

describe('MeshCoreMap loading overlay', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('shows the loading overlay while isLoading is true, even with no contacts', () => {
    render(<MeshCoreMap contacts={[]} selectedPublicKey={null} isLoading />);
    expect(screen.getByTestId('map-loading-overlay')).toBeInTheDocument();
  });

  it('hides the loading overlay once isLoading resolves to false', () => {
    render(<MeshCoreMap contacts={[]} selectedPublicKey={null} isLoading={false} />);
    expect(screen.queryByTestId('map-loading-overlay')).not.toBeInTheDocument();
  });

  it('omits the loading overlay by default (isLoading not passed)', () => {
    render(<MeshCoreMap contacts={[]} selectedPublicKey={null} />);
    expect(screen.queryByTestId('map-loading-overlay')).not.toBeInTheDocument();
  });
});
