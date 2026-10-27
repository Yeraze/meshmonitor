/**
 * @vitest-environment jsdom
 *
 * MeshCore map: the "Live packet traffic" toggle (#4835) sits in its Map
 * Features panel, is off by default, persists, and mounts the layer (which
 * subscribes the socket) only while on.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MeshCoreMap } from './MeshCoreMap';

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children: ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

// #5972: the ducting hooks need a QueryClient; with the admin switch off the
// control renders nothing and the layer never mounts.
vi.mock('../../hooks/useDuctingForecast', () => ({
  useDuctingEnabled: () => false,
  useDuctingForecast: () => ({ data: undefined }),
  DUCTING_MAX_HOURS_AHEAD: 72,
  DUCTING_STEP_HOURS: 3,
}));
vi.mock('../map/layers/PacketFlightsLayer', () => ({
  PacketFlightsLayer: (props: { sourceIds: string[]; nodes: unknown[] }) => (
    <div data-testid="packet-flights-layer" data-sources={props.sourceIds.join(',')} data-nodes={props.nodes.length} />
  ),
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

const contacts = [
  { publicKey: 'ab'.repeat(32), advName: 'Local', isLocal: true, latitude: 30, longitude: -90 },
  { publicKey: 'cd'.repeat(32), advName: 'Peer', latitude: 30.1, longitude: -90.1 },
] as any[];

describe('MeshCoreMap live packet traffic toggle', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('is off by default: no layer, no slider', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    const box = screen.getByRole('checkbox', { name: 'map.packet_flights.toggle' });
    expect(box).not.toBeChecked();
    expect(screen.queryByTestId('packet-flights-layer')).toBeNull();
    expect(screen.queryByRole('slider', { name: 'map.packet_flights.rate_label' })).toBeNull();
  });

  it('turning it on mounts the layer for this source with the drawn contacts, shows the slider, and persists', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'map.packet_flights.toggle' }));
    const layer = screen.getByTestId('packet-flights-layer');
    expect(layer).toHaveAttribute('data-sources', 'src-1');
    expect(layer).toHaveAttribute('data-nodes', '2');
    expect(screen.getByRole('slider', { name: 'map.packet_flights.rate_label' })).toBeInTheDocument();
    expect(localStorage.getItem('showPacketFlights')).toBe('true');

    fireEvent.click(screen.getByRole('checkbox', { name: 'map.packet_flights.toggle' }));
    expect(screen.queryByTestId('packet-flights-layer')).toBeNull();
  });
});
