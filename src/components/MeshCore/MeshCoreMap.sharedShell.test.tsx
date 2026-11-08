/**
 * @vitest-environment jsdom
 *
 * #6260 WP3: the shared map shell on the MeshCore map: local markers,
 * cross-source links, clustering (and the selection-zoom gate), 3D, playback.
 * Heavy map internals are stubbed; each stub records the props it received.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
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
vi.mock('../map/layers/NodeMarkersLayer', () => ({ NodeMarkersLayer: () => <div data-testid="node-markers-layer" /> }));
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

vi.mock('./hooks/useMeshCoreEstimatedPositions', () => ({ useMeshCoreEstimatedPositions: () => [] }));
import { MeshCoreMap } from './MeshCoreMap';

const contacts = [
  { publicKey: 'aa', advName: 'Alpha', advType: 1, latitude: 10, longitude: 20 },
  { publicKey: 'bb', advName: 'Bravo', advType: 2, latitude: 11, longitude: 21 },
] as never;

function reset() {
  localStorage.clear();
  h.zoom.current = 0;
  h.cluster.current = null;
  h.cluster.mounted = false;
  h.localMarkers.current = null;
  h.crossSource.current = null;
  h.map3d.current = null;
  h.playback.current = null;
  h.toggle3d.effective3D = false;
  h.canWrite.value = true;
  h.settings.mapZoomGateThreshold = 13;
  h.settings.mapClusteringEnabled = true;
  h.history.current = [];
}

describe('MeshCoreMap shared shell', () => {
  beforeEach(reset);

  it('mounts local markers for the source and gates the add button on waypoints:write', () => {
    const { unmount } = render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(h.localMarkers.current?.sourceId).toBe('src-1');
    expect(screen.getByText('localMarkers.add')).toBeInTheDocument();
    unmount();

    h.canWrite.value = false;
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(screen.queryByText('localMarkers.add')).not.toBeInTheDocument();
  });

  it('hides local markers when the toggle is off', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    fireEvent.click(screen.getByLabelText('map.showLocalMarkers'));
    expect(screen.queryByTestId('local-markers')).not.toBeInTheDocument();
  });

  it('mounts cross-source links for [sourceId] only while toggled on', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(screen.queryByTestId('cross-source-links')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('map.cross_source.toggle'));
    expect(h.crossSource.current).toMatchObject({ enabled: true, sourceIds: ['src-1'] });
  });

  it('clusters at the resolved gate zoom and not when clustering is off or the gate is 0', () => {
    const { unmount } = render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(h.cluster.mounted).toBe(true);
    expect(h.cluster.current).toBe(13);
    unmount();

    h.cluster.mounted = false;
    h.settings.mapClusteringEnabled = false;
    const off = render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(h.cluster.mounted).toBe(false);
    expect(screen.getByTestId('node-markers-layer')).toBeInTheDocument();
    off.unmount();

    h.settings.mapClusteringEnabled = true;
    h.settings.mapZoomGateThreshold = 0;
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(h.cluster.mounted).toBe(false);
  });

  it('zooms a selected contact to at least the cluster gate, else the plain zoom', () => {
    const a = render(<MeshCoreMap contacts={contacts} selectedPublicKey="aa" />);
    expect(h.zoom.current).toBe(13);
    a.unmount();

    h.settings.mapZoomGateThreshold = 16;
    const b = render(<MeshCoreMap contacts={contacts} selectedPublicKey="aa" />);
    expect(h.zoom.current).toBe(16);
    b.unmount();

    h.settings.mapClusteringEnabled = false;
    render(<MeshCoreMap contacts={contacts} selectedPublicKey="aa" />);
    expect(h.zoom.current).toBe(12);
  });

  it('renders the 3D view with the visible MeshCore keys and no traceroutes', () => {
    h.toggle3d.effective3D = true;
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(screen.getByTestId('map-3d')).toBeInTheDocument();
    expect(screen.queryByTestId('base-map')).not.toBeInTheDocument();
    const props = h.map3d.current as { visibleMeshCoreKeys: Set<string>; showTraceroutes: boolean; sourceIds: string[]; nodes: Array<{ key: string }> };
    expect([...props.visibleMeshCoreKeys].sort()).toEqual(['aa', 'bb']);
    expect(props.showTraceroutes).toBe(false);
    expect(props.sourceIds).toEqual(['src-1']);
    expect(props.nodes.map(n => n.key).sort()).toEqual(['aa', 'bb']);
  });

  describe('playback', () => {
    const fixes = [
      { latitude: 10, longitude: 20, timestamp: 2000 },
      { latitude: 10.1, longitude: 20.1, timestamp: 1000 },
    ];

    it('shows for the selected contact with history on and 2+ fixes (sorted oldest first)', async () => {
      localStorage.setItem('meshmonitor-meshcore-showPositionHistory', 'true');
      h.history.current = fixes;
      render(<MeshCoreMap contacts={contacts} selectedPublicKey="aa" />);
      await waitFor(() => expect(screen.getByTestId('playback-bar')).toBeInTheDocument());
      const bar = h.playback.current as { fixes: Array<{ timestamp: number }>; resetKey: string };
      expect(bar.resetKey).toBe('aa');
      expect(bar.fixes.map(f => f.timestamp)).toEqual([1000, 2000]);
    });

    it('does not show without a selection', async () => {
      localStorage.setItem('meshmonitor-meshcore-showPositionHistory', 'true');
      h.history.current = fixes;
      render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
      await act(async () => { await new Promise(r => setTimeout(r, 20)); });
      expect(screen.queryByTestId('playback-bar')).not.toBeInTheDocument();
    });

    it('does not show with a single fix', async () => {
      localStorage.setItem('meshmonitor-meshcore-showPositionHistory', 'true');
      h.history.current = [fixes[0]];
      render(<MeshCoreMap contacts={contacts} selectedPublicKey="aa" />);
      await act(async () => { await new Promise(r => setTimeout(r, 20)); });
      expect(screen.queryByTestId('playback-bar')).not.toBeInTheDocument();
    });

    it('does not show while Show Position History is off', async () => {
      h.history.current = fixes;
      render(<MeshCoreMap contacts={contacts} selectedPublicKey="aa" />);
      await act(async () => { await new Promise(r => setTimeout(r, 20)); });
      expect(screen.queryByTestId('playback-bar')).not.toBeInTheDocument();
    });
  });
});
