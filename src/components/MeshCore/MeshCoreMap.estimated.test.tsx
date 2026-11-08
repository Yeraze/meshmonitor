/**
 * @vitest-environment jsdom
 *
 * #6260 WP5: estimated positions on the MeshCore map (toggles, merge, radii, look-back).
 *
 * Heavy map internals are stubbed; each stub records the props it received.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({
  estimates: { items: [] as unknown[], enabledArg: null as boolean | null },
  radii: { current: [] as Array<{ key: string; radiusMeters: number }> },
  markerKeys: { current: [] as string[] },
  zoom: { current: 0 },
  cluster: { current: null as number | null | undefined, mounted: false },
  localMarkers: { current: null as null | { sourceId: string | null } },
  crossSource: { current: null as null | { sourceIds: string[]; enabled: boolean } },
  map3d: { current: null as null | Record<string, unknown> },
  playback: { current: null as null | { fixes: unknown[]; resetKey: string } },
  toggle3d: { effective3D: false },
  canWrite: { value: true },
  settings: { mapZoomGateThreshold: 13, mapClusteringEnabled: true },
  history: { current: [] as Array<{ latitude: number; longitude: number; timestamp: number }> },
}));

vi.mock('../../init', () => ({ appBasename: '' }));
vi.mock('../../hooks/useMap3DToggle', () => ({
  useMap3DToggle: () => ({
    canUse3D: true,
    viewMode: h.toggle3d.effective3D ? '3d' : '2d',
    setViewMode: vi.fn(),
    effective3D: h.toggle3d.effective3D,
    basemap3D: { tiles: ['t'], attribution: '', maxZoom: 18, usedFallback: false },
    terrainTileUrl: '/terrain/{z}/{x}/{y}',
  }),
}));
vi.mock('../../hooks/useMapMarkers', () => ({
  useMapMarkers: () => ({ markers: [], isLoading: false, create: vi.fn(), update: vi.fn(), remove: vi.fn() }),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => h.canWrite.value }),
}));
vi.mock('../../hooks/useDuctingForecast', () => ({
  useDuctingEnabled: () => false,
  useDuctingForecast: () => ({ data: undefined }),
  DUCTING_MAX_HOURS_AHEAD: 72,
  DUCTING_STEP_HOURS: 3,
}));
vi.mock('../map/layers/PacketFlightsLayer', () => ({ PacketFlightsLayer: () => null }));
vi.mock('../map/MapInstanceBridge', () => ({ MapInstanceBridge: () => null }));
vi.mock('../map/LocalMarkerPlacementBridge', () => ({ default: () => null }));
vi.mock('../map/LocalMarkerEditorModal', () => ({ default: () => null }));

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children, zoom }: { children: ReactNode; zoom: number }) => {
    h.zoom.current = zoom;
    return <div data-testid="base-map">{children}</div>;
  },
}));
vi.mock('../map/layers/NodeMarkerCluster', () => ({
  NodeMarkerCluster: ({ children, disableClusteringAtZoom }: { children: ReactNode; disableClusteringAtZoom?: number }) => {
    h.cluster.current = disableClusteringAtZoom;
    h.cluster.mounted = true;
    return <div data-testid="cluster">{children}</div>;
  },
}));
vi.mock('../map/layers/NodeMarkersLayer', () => ({
  NodeMarkersLayer: (props: { markers: Array<{ key: string }> }) => {
    h.markerKeys.current = props.markers.map(m => m.key);
    return <div data-testid="node-markers-layer" />;
  },
}));
vi.mock('./hooks/useMeshCoreEstimatedPositions', () => ({
  useMeshCoreEstimatedPositions: (_s: string | null, enabled: boolean) => {
    h.estimates.enabledArg = enabled;
    return enabled ? h.estimates.items : [];
  },
}));
vi.mock('../map/layers/EstimatedPositionRadiiLayer', () => ({
  EstimatedPositionRadiiLayer: (props: { radii: Array<{ key: string; radiusMeters: number }> }) => {
    h.radii.current = props.radii;
    return null;
  },
}));
vi.mock('../map/layers/NeighborLinksLayer', () => ({ NeighborLinksLayer: () => null }));
vi.mock('../map/layers/MapMarkersLayer', () => ({
  LocalMarkers: (props: { sourceId: string | null }) => {
    h.localMarkers.current = props;
    return <div data-testid="local-markers" />;
  },
}));
vi.mock('../map/layers/CrossSourceLinksLayer', () => ({
  CrossSourceLinksLayer: (props: { sourceIds: string[]; enabled: boolean }) => {
    h.crossSource.current = props;
    return <div data-testid="cross-source-links" />;
  },
}));
vi.mock('../map/Map3DView', () => ({
  Map3DView: (props: Record<string, unknown>) => {
    h.map3d.current = props;
    return <div data-testid="map-3d" />;
  },
}));
vi.mock('../map/AssetPlaybackBar', () => ({
  AssetPlaybackBar: (props: { fixes: unknown[]; resetKey: string }) => {
    h.playback.current = props;
    return <div data-testid="playback-bar" />;
  },
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
  useSettings: () => ({
    mapTileset: 'osm',
    customTilesets: [],
    cartoApiKey: null,
    activeStyleJson: null,
    distanceUnit: 'km',
    setMapTileset: vi.fn(),
    ...h.settings,
  }),
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-1' }),
}));
vi.mock('../../services/api', () => ({
  default: {
    getBaseUrl: vi.fn().mockResolvedValue(''),
    get: vi.fn((url: string) => {
      if (url.includes('position-history')) return Promise.resolve({ success: true, data: h.history.current });
      return Promise.resolve({ success: true, data: { items: [] } });
    }),
  },
}));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn().mockResolvedValue({ ok: true }) }));

import { MeshCoreMap } from './MeshCoreMap';

const contacts = [
  { publicKey: 'aa', advName: 'Alpha', advType: 1, latitude: 10, longitude: 20 },
  { publicKey: 'bb', advName: 'Bravo', advType: 2 },
  { publicKey: 'cc', advName: 'Charlie', advType: 2, latitude: 0, longitude: 0 },
] as never;

const estimates = [
  { publicKey: 'bb', latitude: 11, longitude: 21, uncertaintyKm: 1.5, uniqueAnchors: 2, nEff: 2, radiusMethod: 'convergence' },
  // Alpha has its own fix: the estimate must never replace it.
  { publicKey: 'aa', latitude: 50, longitude: 50, uncertaintyKm: 1, uniqueAnchors: 2, nEff: 2, radiusMethod: 'convergence' },
];

describe('MeshCoreMap estimated positions', () => {
  beforeEach(() => {
    localStorage.clear();
    h.estimates.items = [];
    h.estimates.enabledArg = null;
    h.radii.current = [];
    h.markerKeys.current = [];
    h.map3d.current = null;
    h.toggle3d.effective3D = false;
  });

  it('draws a marker for an unpositioned contact with an estimate, without replacing real fixes', () => {
    h.estimates.items = estimates;
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(h.markerKeys.current.sort()).toEqual(['aa', 'bb']);
  });

  it('draws nothing extra when the estimated-positions toggle is off, and does not ask for them', () => {
    h.estimates.items = estimates;
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    fireEvent.click(screen.getByLabelText('map.showEstimatedPositions'));
    expect(h.estimates.enabledArg).toBe(false);
    expect(h.markerKeys.current).toEqual(['aa']);
  });

  it('draws radii only with Show Accuracy Regions on, sized from the uncertainty', () => {
    h.estimates.items = estimates;
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(h.radii.current).toEqual([]);
    fireEvent.click(screen.getByLabelText('map.showAccuracyRegions'));
    expect(h.radii.current).toEqual([expect.objectContaining({ key: 'estimated-bb', radiusMeters: 1500 })]);
    fireEvent.click(screen.getByLabelText('map.showEstimatedPositions'));
    expect(h.radii.current).toEqual([]);
  });

  it('threads the node-age window into the cross-source look-back, defaulting to 24', () => {
    const a = render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} nodeAgeHours={72} />);
    fireEvent.click(screen.getByLabelText('map.cross_source.toggle'));
    expect(h.crossSource.current).toMatchObject({ lookbackHours: 72 });
    a.unmount();
    for (const age of [undefined, 0]) {
      const b = render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} nodeAgeHours={age} />);
      fireEvent.click(screen.getByLabelText('map.cross_source.toggle'));
      expect(h.crossSource.current).toMatchObject({ lookbackHours: 24 });
      b.unmount();
    }
  });

  it('uses the same window for the 3D view', () => {
    h.toggle3d.effective3D = true;
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} nodeAgeHours={48} />);
    expect(h.map3d.current).toMatchObject({ lookbackHours: 48 });
  });
});
