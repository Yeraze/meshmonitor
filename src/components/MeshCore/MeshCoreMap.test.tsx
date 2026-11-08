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

// WP3 (#6260): the map now pulls in the 3D toggle, local-marker authoring and
// permission hooks. Stub them so these suites stay about their own feature.
vi.mock('../../init', () => ({ appBasename: '' }));
vi.mock('../map/MapInstanceBridge', () => ({ MapInstanceBridge: () => null }));
vi.mock('../map/LocalMarkerPlacementBridge', () => ({ default: () => null }));
vi.mock('../map/layers/MapMarkersLayer', () => ({ LocalMarkers: () => null }));
vi.mock('../map/layers/CrossSourceLinksLayer', () => ({ CrossSourceLinksLayer: () => null }));
vi.mock('../../hooks/useTerrainCapabilities', () => ({
  useTerrainCapabilities: () => ({ enabled: false, terrainTiles: false, isLoading: false }),
}));
vi.mock('../../hooks/useMapMarkers', () => ({
  useMapMarkers: () => ({ markers: [], isLoading: false, create: vi.fn(), update: vi.fn(), remove: vi.fn() }),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => false }),
}));


// #4835: the live packet traffic layer pulls in the socket context; off by default here.
// #5972: the ducting hooks need a QueryClient; with the admin switch off the
// control renders nothing and the layer never mounts.
vi.mock('../../hooks/useDuctingForecast', () => ({
  useDuctingEnabled: () => false,
  useDuctingForecast: () => ({ data: undefined }),
  DUCTING_MAX_HOURS_AHEAD: 72,
  DUCTING_STEP_HOURS: 3,
}));
vi.mock('../map/layers/PacketFlightsLayer', () => ({ PacketFlightsLayer: () => null }));

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children: ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

const { markerCapture } = vi.hoisted(() => ({
  markerCapture: { current: [] as Array<{ key: string; iconSig: string; opacity?: number }> },
}));
vi.mock('../map/layers/NodeMarkersLayer', () => ({
  NodeMarkersLayer: (props: { markers: Array<{ key: string; iconSig: string; opacity?: number }> }) => {
    markerCapture.current = props.markers;
    return <div data-testid="node-markers-layer" />;
  },
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
  useNodeListStyle: () => 'monochrome',
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

// ---------------------------------------------------------------------------
// Marker dimming (#6258)
// ---------------------------------------------------------------------------

describe('MeshCoreMap marker opacity', () => {
  const contacts = [
    { publicKey: 'aa', advName: 'Alpha', advType: 1, latitude: 1, longitude: 2 },
    { publicKey: 'bb', advName: 'Bravo', advType: 2, latitude: 3, longitude: 4 },
  ] as never;

  beforeEach(() => {
    localStorage.clear();
    markerCapture.current = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('takes marker opacity from markerOpacityByKey and defaults to 1', () => {
    render(
      <MeshCoreMap
        contacts={contacts}
        selectedPublicKey={null}
        markerOpacityByKey={new Map([['aa', 0.4]])}
      />,
    );
    const byKey = new Map(markerCapture.current.map(m => [m.key, m]));
    expect(byKey.get('aa')?.opacity).toBe(0.4);
    expect(byKey.get('bb')?.opacity).toBe(1);
  });

  it('never folds opacity into iconSig', () => {
    const { rerender } = render(
      <MeshCoreMap contacts={contacts} selectedPublicKey={null} />,
    );
    const before = markerCapture.current.map(m => m.iconSig);
    rerender(
      <MeshCoreMap
        contacts={contacts}
        selectedPublicKey={null}
        markerOpacityByKey={new Map([['aa', 0.3], ['bb', 0.5]])}
      />,
    );
    expect(markerCapture.current.map(m => m.iconSig)).toEqual(before);
  });
});
