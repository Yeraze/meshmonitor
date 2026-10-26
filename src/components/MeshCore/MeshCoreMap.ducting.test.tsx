/**
 * @vitest-environment jsdom
 *
 * MeshCore map: the tropospheric ducting overlay (#5972). The control sits in
 * the Map Features panel next to "Live packet traffic", hides while the admin
 * switch is off, and the layer mounts only while the toggle is on. Both ask
 * for THIS source's area (`sourceId`), and nothing asks while it is off.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MeshCoreMap } from './MeshCoreMap';

const mocks = vi.hoisted(() => ({
  enabled: true,
  forecastArgs: [] as Array<{ hours: number; enabled: boolean; sourceId: string | null | undefined }>,
}));

vi.mock('../../hooks/useDuctingForecast', () => ({
  DUCTING_MAX_HOURS_AHEAD: 72,
  DUCTING_STEP_HOURS: 3,
  useDuctingEnabled: () => mocks.enabled,
  useDuctingForecast: (hours: number, enabled: boolean, sourceId?: string | null) => {
    mocks.forecastArgs.push({ hours, enabled, sourceId });
    return { data: undefined, error: null, isFetching: false, isPlaceholderData: false };
  },
}));

vi.mock('../map/layers/DuctingLayer', () => ({
  default: (props: { hoursAhead: number; sourceId?: string | null }) => (
    <div data-testid="ducting-layer" data-hours={props.hoursAhead} data-source={props.sourceId ?? ''} />
  ),
}));

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children: ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

vi.mock('../map/layers/PacketFlightsLayer', () => ({ PacketFlightsLayer: () => null }));

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

const toggle = () => screen.getByRole('checkbox', { name: /map\.ducting\.toggle/ });

describe('MeshCoreMap ducting overlay (#5972)', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.enabled = true;
    mocks.forecastArgs = [];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('hides the control while the admin switch is off', () => {
    mocks.enabled = false;
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(screen.queryByTestId('ducting-control')).toBeNull();
    expect(screen.queryByTestId('ducting-layer')).toBeNull();
  });

  it('puts the control in the Map Features panel, right after Live packet traffic', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    const control = screen.getByTestId('ducting-control');
    const flights = screen.getByRole('checkbox', { name: 'map.packet_flights.toggle' });
    expect(control.closest('.map-controls')).not.toBeNull();
    expect(flights.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is off by default: no layer, and no forecast fetch is enabled', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(toggle()).not.toBeChecked();
    expect(screen.queryByTestId('ducting-layer')).toBeNull();
    expect(mocks.forecastArgs.length).toBeGreaterThan(0);
    expect(mocks.forecastArgs.every((a) => a.enabled === false)).toBe(true);
  });

  it("turning it on mounts the layer for this source's area, and off unmounts it", () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    fireEvent.click(toggle());
    const layer = screen.getByTestId('ducting-layer');
    expect(layer).toHaveAttribute('data-source', 'src-1');
    expect(layer).toHaveAttribute('data-hours', '0');
    expect(screen.getByRole('slider')).toBeInTheDocument();
    const last = mocks.forecastArgs[mocks.forecastArgs.length - 1];
    expect(last).toEqual({ hours: 0, enabled: true, sourceId: 'src-1' });

    fireEvent.click(toggle());
    expect(screen.queryByTestId('ducting-layer')).toBeNull();
  });
});
