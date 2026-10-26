/**
 * @vitest-environment jsdom
 *
 * #5964: the MeshCore map's pending popup. Node Details' Show on Map sets
 * `pendingPopupPublicKey`; the map opens that node's popup when its marker is
 * added to the map, once and only once, then reports it handled. A request
 * for a node the map does not draw is dropped.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { MeshCoreMap } from './MeshCoreMap';

type Descriptor = { key: string; eventHandlers?: { add?: (e: { target: unknown }) => void } };
let lastMarkers: Descriptor[] = [];
const baseMapKeys: string[] = [];

// #4835: the live packet traffic layer pulls in the socket context; off by default here.
vi.mock('../map/layers/PacketFlightsLayer', () => ({ PacketFlightsLayer: () => null }));

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children, center, zoom }: { children: ReactNode; center: [number, number]; zoom: number }) => {
    baseMapKeys.push(`${center[0]}-${center[1]}-${zoom}`);
    return <div data-testid="base-map">{children}</div>;
  },
}));
vi.mock('../map/layers/NodeMarkersLayer', () => ({
  NodeMarkersLayer: ({ markers }: { markers: Descriptor[] }) => {
    lastMarkers = markers;
    return null;
  },
}));
vi.mock('../map/layers/NeighborLinksLayer', () => ({ NeighborLinksLayer: () => null }));
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
vi.mock('../../contexts/SourceContext', () => ({ useSource: () => ({ sourceId: 'src-1' }) }));
vi.mock('../../services/api', () => ({
  default: {
    getBaseUrl: vi.fn().mockResolvedValue(''),
    get: vi.fn().mockResolvedValue({ success: true, data: { items: [] } }),
  },
}));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn().mockResolvedValue({ ok: true }) }));

const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);
const contacts = [
  { publicKey: KEY_A, advName: 'Alpha', advType: 1, latitude: 45.1, longitude: -75.1 },
  { publicKey: KEY_B, advName: 'Bravo', advType: 2, latitude: 45.2, longitude: -75.2 },
];

const fakeMarker = () => ({ openPopup: vi.fn() });
const addMarker = (key: string, marker: { openPopup: () => void }) => {
  const d = lastMarkers.find((m) => m.key === key);
  act(() => d?.eventHandlers?.add?.({ target: marker }));
};

describe('MeshCoreMap — pending popup (#5964)', () => {
  beforeEach(() => {
    localStorage.clear();
    lastMarkers = [];
    baseMapKeys.length = 0;
  });

  it('centres and zooms on the selected node', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={KEY_B} pendingPopupPublicKey={KEY_B} />);
    expect(baseMapKeys.at(-1)).toBe('45.2--75.2-12');
  });

  it('opens the pending node popup when its marker is added, once', () => {
    const onHandled = vi.fn();
    render(
      <MeshCoreMap contacts={contacts} selectedPublicKey={KEY_B} pendingPopupPublicKey={KEY_B} onPendingPopupHandled={onHandled} />,
    );
    const other = fakeMarker();
    addMarker(KEY_A, other);
    expect(other.openPopup).not.toHaveBeenCalled();

    const first = fakeMarker();
    addMarker(KEY_B, first);
    expect(first.openPopup).toHaveBeenCalledTimes(1);
    expect(onHandled).toHaveBeenCalledTimes(1);

    // A remount re-adds the marker before the owner clears the key: no reopen.
    const again = fakeMarker();
    addMarker(KEY_B, again);
    expect(again.openPopup).not.toHaveBeenCalled();
    expect(onHandled).toHaveBeenCalledTimes(1);
  });

  it('does not reopen on later re-renders once the owner clears the key', () => {
    const onHandled = vi.fn();
    const { rerender } = render(
      <MeshCoreMap contacts={contacts} selectedPublicKey={KEY_B} pendingPopupPublicKey={KEY_B} onPendingPopupHandled={onHandled} />,
    );
    addMarker(KEY_B, fakeMarker());
    rerender(
      <MeshCoreMap contacts={[...contacts]} selectedPublicKey={KEY_B} pendingPopupPublicKey={null} onPendingPopupHandled={onHandled} />,
    );
    const later = fakeMarker();
    addMarker(KEY_B, later);
    expect(later.openPopup).not.toHaveBeenCalled();
    expect(onHandled).toHaveBeenCalledTimes(1);
  });

  it('opens nothing without a pending key', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={KEY_B} />);
    const m = fakeMarker();
    addMarker(KEY_B, m);
    expect(m.openPopup).not.toHaveBeenCalled();
  });

  it('drops a request for a node the map does not draw', () => {
    const onHandled = vi.fn();
    const missing = 'c3'.repeat(32);
    render(
      <MeshCoreMap contacts={contacts} selectedPublicKey={missing} pendingPopupPublicKey={missing} onPendingPopupHandled={onHandled} />,
    );
    expect(onHandled).toHaveBeenCalledTimes(1);
  });

  it('waits while the first snapshot is still loading', () => {
    const onHandled = vi.fn();
    render(
      <MeshCoreMap contacts={[]} selectedPublicKey={KEY_A} pendingPopupPublicKey={KEY_A} onPendingPopupHandled={onHandled} isLoading />,
    );
    expect(onHandled).not.toHaveBeenCalled();
  });
});
