/**
 * @vitest-environment jsdom
 *
 * P7a (#6254): the map popup shows the advert signature line only when the
 * value is checked (true / false). null / unset renders nothing. Heavy map
 * internals are stubbed as in MeshCoreMap.test.tsx.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
vi.mock('./hooks/useMeshCoreEstimatedPositions', () => ({ useMeshCoreEstimatedPositions: () => [] }));
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


const PK = 'cd'.repeat(32);
const contact = (extra: Record<string, unknown>) => ({
  publicKey: PK, advName: 'Hill', name: 'Hill', advType: 2, latitude: 45, longitude: -122, ...extra,
});

function popupText(extra: Record<string, unknown>): string {
  render(<MeshCoreMap contacts={[contact(extra)]} selectedPublicKey={null} localNodePosition={null} />);
  const marker = markerCapture.current[0] as unknown as { children: ReactNode };
  const view = render(<div data-testid="popup">{marker.children}</div>);
  return view.getByTestId('popup').textContent ?? '';
}

describe('MeshCoreMap popup advert signature line', () => {
  beforeEach(() => {
    localStorage.clear();
    markerCapture.current = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('shows Verified when true', () => {
    expect(popupText({ advertSignatureVerified: true })).toContain('meshcore.advert_signature_verified');
  });
  it('shows Failed when false', () => {
    expect(popupText({ advertSignatureVerified: false })).toContain('meshcore.advert_signature_failed');
  });
  it('shows nothing when null', () => {
    expect(popupText({ advertSignatureVerified: null })).not.toContain('meshcore.advert_signature');
  });
  it('shows nothing when unset', () => {
    expect(popupText({})).not.toContain('meshcore.advert_signature');
  });
});
