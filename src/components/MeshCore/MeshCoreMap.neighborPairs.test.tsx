/**
 * @vitest-environment jsdom
 *
 * #6403: when both repeaters of a pair report each other, the MeshCore map
 * draws ONE line per pair whose tooltip shows both directions, freshest first,
 * independent of the order the API returns the rows in.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

vi.mock('../map/layers/NodeMarkersLayer', () => ({
  NodeMarkersLayer: ({ markers }: { markers: Array<{ key: string }> }) => (
    <div data-testid="node-markers-layer" data-keys={markers.map((m) => m.key).join(',')} />
  ),
}));

vi.mock('../map/layers/NeighborLinksLayer', () => ({
  NeighborLinksLayer: ({ links }: { links: Array<{ key: string; children?: ReactNode }> }) => (
    <div data-testid="neighbor-links-layer" data-keys={links.map((l) => l.key).join(',')}>
      {links.map((l) => <div key={l.key} data-testid="neighbor-link-label">{l.children}</div>)}
    </div>
  ),
}));

vi.mock('../GeoJsonOverlay', () => ({ default: () => null }));
vi.mock('../MapLegend', () => ({ default: () => null }));
vi.mock('../MeasureDistanceController', () => ({ default: () => null }));
vi.mock('../PolarGridOverlay', () => ({ default: () => null }));

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

const NOW = Date.now();
const KEY_A = 'f4'.repeat(32);
const KEY_B = '9e'.repeat(32);
// The report from #6403: A's entry for B is ~12 h old, B's entry for A is 4 min old.
const ROW_A_TO_B = { publicKey: KEY_A, neighborPublicKey: KEY_B, nodeName: 'Merefa_R1', neighborName: 'KH_HOLODOS_R1', snr: 12.75, lastHeardSecs: 43320, timestamp: NOW };
const ROW_B_TO_A = { publicKey: KEY_B, neighborPublicKey: KEY_A, nodeName: 'KH_HOLODOS_R1', neighborName: 'Merefa_R1', snr: -10.25, lastHeardSecs: 240, timestamp: NOW };
const rows = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock('../../services/api', () => ({
  default: {
    getBaseUrl: vi.fn().mockResolvedValue(''),
    get: vi.fn().mockImplementation((url: string) => Promise.resolve(
      url.includes('/meshcore/neighbors')
        ? { success: true, data: { items: rows.items } }
        : { success: true, data: { items: [] } },
    )),
  },
}));

vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => vi.fn().mockResolvedValue({ ok: true }),
}));

const contacts = [
  { publicKey: KEY_A, advName: 'Merefa_R1', advType: 2, latitude: 49.6, longitude: 36.1 },
  { publicKey: KEY_B, advName: 'KH_HOLODOS_R1', advType: 2, latitude: 49.9, longitude: 36.3 },
];

const linkKeys = (): string[] =>
  (screen.getByTestId('neighbor-links-layer').getAttribute('data-keys') ?? '').split(',').filter(Boolean);

describe('MeshCoreMap — neighbour pairs (#6403)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it.each([
    ['stale row first', () => [ROW_A_TO_B, ROW_B_TO_A]],
    ['fresh row first', () => [ROW_B_TO_A, ROW_A_TO_B]],
  ])('draws one line with both directions, freshest first (%s)', async (_name, order) => {
    rows.items = order();
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    await waitFor(() => expect(linkKeys()).toHaveLength(1));
    expect(screen.getByTestId('neighbor-link-label').textContent).toBe(
      'KH_HOLODOS_R1 hears Merefa_R1: -10.3 dB (4 min ago) · Merefa_R1 hears KH_HOLODOS_R1: 12.8 dB (12 h ago)',
    );
  });

  it('shows a single direction when only one repeater reported the link', async () => {
    rows.items = [ROW_A_TO_B];
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    await waitFor(() => expect(linkKeys()).toHaveLength(1));
    expect(screen.getByTestId('neighbor-link-label').textContent).toBe(
      'Merefa_R1 hears KH_HOLODOS_R1: 12.8 dB (12 h ago)',
    );
  });
});
