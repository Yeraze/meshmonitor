/**
 * @vitest-environment jsdom
 *
 * #5578: the MeshCore map's "Hide nodes without a current position advert"
 * toggle. It hides MARKERS only — neighbour lines keep their endpoints, as the
 * node-type filter does — never hides a telemetry-positioned node or the local
 * node, treats "unknown" as shown, and persists per browser.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreMap } from './MeshCoreMap';
import { HIDE_POSITIONLESS_ADVERT_STORAGE_KEY } from '../../utils/meshcoreAdvertPosition';

vi.mock('../map/BaseMap', () => ({
  BaseMap: ({ children }: { children: ReactNode }) => <div data-testid="base-map">{children}</div>,
}));

vi.mock('../map/layers/NodeMarkersLayer', () => ({
  NodeMarkersLayer: ({ markers }: { markers: Array<{ key: string }> }) => (
    <div data-testid="node-markers-layer" data-keys={markers.map((m) => m.key).join(',')} />
  ),
}));

vi.mock('../map/layers/NeighborLinksLayer', () => ({
  NeighborLinksLayer: ({ links }: { links: Array<{ key: string }> }) => (
    <div data-testid="neighbor-links-layer" data-keys={links.map((l) => l.key).join(',')} />
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

const KEY_FRESH = 'aa'.repeat(32);
const KEY_STALE = 'bb'.repeat(32);
const KEY_UNKNOWN = 'cc'.repeat(32);
const KEY_TELEMETRY = 'dd'.repeat(32);
const KEY_LOCAL = 'ee'.repeat(32);

vi.mock('../../services/api', () => ({
  default: {
    getBaseUrl: vi.fn().mockResolvedValue(''),
    get: vi.fn().mockImplementation((url: string) => Promise.resolve(
      url.includes('/meshcore/neighbors')
        ? {
            success: true,
            data: {
              items: [{
                publicKey: 'aa'.repeat(32),
                neighborPublicKey: 'bb'.repeat(32),
                nodeName: 'Fresh',
                neighborName: 'Stale',
                snr: 5,
              }],
            },
          }
        : { success: true, data: { items: [] } },
    )),
  },
}));

vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => vi.fn().mockResolvedValue({ ok: true }),
}));

const contacts = [
  { publicKey: KEY_FRESH, advName: 'Fresh', advType: 1, latitude: 45.1, longitude: -75.1, lastAdvertHadPosition: true, positionSource: 'contact' },
  { publicKey: KEY_STALE, advName: 'Stale', advType: 1, latitude: 45.2, longitude: -75.2, lastAdvertHadPosition: false, positionSource: 'contact' },
  { publicKey: KEY_UNKNOWN, advName: 'Unknown', advType: 1, latitude: 45.3, longitude: -75.3 },
  { publicKey: KEY_TELEMETRY, advName: 'Tracker', advType: 1, latitude: 45.4, longitude: -75.4, lastAdvertHadPosition: false, positionSource: 'telemetry' },
  { publicKey: KEY_LOCAL, advName: 'Me', advType: 1, latitude: 45.5, longitude: -75.5, lastAdvertHadPosition: false, isLocal: true },
];

const markerKeys = (): string[] =>
  (screen.getByTestId('node-markers-layer').getAttribute('data-keys') ?? '').split(',').filter(Boolean);
const linkKeys = (): string[] =>
  (screen.getByTestId('neighbor-links-layer').getAttribute('data-keys') ?? '').split(',').filter(Boolean);
const toggle = (): HTMLInputElement =>
  screen.getByLabelText('map.hidePositionlessAdverts') as HTMLInputElement;

describe('MeshCoreMap — hide nodes without a current position advert (#5578)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('is off by default and draws every positioned node', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(toggle().checked).toBe(false);
    expect(markerKeys()).toEqual([KEY_FRESH, KEY_STALE, KEY_UNKNOWN, KEY_TELEMETRY, KEY_LOCAL]);
  });

  it('hides only the node whose latest advert had no position', () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    fireEvent.click(toggle());
    // Unknown, telemetry-positioned and local nodes all stay.
    expect(markerKeys()).toEqual([KEY_FRESH, KEY_UNKNOWN, KEY_TELEMETRY, KEY_LOCAL]);
  });

  it('keeps the neighbour line to a hidden node', async () => {
    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    await waitFor(() => expect(linkKeys()).toHaveLength(1));
    fireEvent.click(toggle());
    expect(markerKeys()).not.toContain(KEY_STALE);
    expect(linkKeys()).toHaveLength(1);
  });

  it('persists per browser and restores on the next mount', () => {
    const first = render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    fireEvent.click(toggle());
    expect(localStorage.getItem(HIDE_POSITIONLESS_ADVERT_STORAGE_KEY)).toBe('true');
    first.unmount();

    render(<MeshCoreMap contacts={contacts} selectedPublicKey={null} />);
    expect(toggle().checked).toBe(true);
    expect(markerKeys()).not.toContain(KEY_STALE);
  });
});

// #5632: a Repeater source's contact list now holds every stored node, most of
// them advert-only with no coordinates. Those must never become a marker.
describe('MeshCoreMap — nodes with no stored position (#5632)', () => {
  const KEY_ADVERT_ONLY = 'e7'.repeat(32);
  const KEY_ZERO = 'e8'.repeat(32);
  const withPositionless = [
    ...contacts,
    // As the server sends it: no latitude/longitude keys at all.
    { publicKey: KEY_ADVERT_ONLY, advName: 'Advert Only', advType: 1, lastAdvertHadPosition: false, outPath: null, pathLen: null },
    { publicKey: KEY_ZERO, advName: 'Null Island', advType: 2, latitude: 0, longitude: 0 },
  ];

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  it('draws no marker for them, with the hide toggle off or on', () => {
    render(<MeshCoreMap contacts={withPositionless} selectedPublicKey={null} />);
    expect(markerKeys()).not.toContain(KEY_ADVERT_ONLY);
    expect(markerKeys()).not.toContain(KEY_ZERO);
    expect(markerKeys()).toContain(KEY_FRESH);
    fireEvent.click(toggle());
    expect(markerKeys()).not.toContain(KEY_ADVERT_ONLY);
  });

  it('selecting one draws nothing and does not throw', () => {
    render(<MeshCoreMap contacts={withPositionless} selectedPublicKey={KEY_ADVERT_ONLY} />);
    expect(markerKeys()).not.toContain(KEY_ADVERT_ONLY);
    expect(markerKeys()).toContain(KEY_FRESH);
  });

  it('a node whose later advert had no position keeps its marker at the stored fix', () => {
    // KEY_STALE is exactly that record: coordinates kept, flag false.
    render(<MeshCoreMap contacts={withPositionless} selectedPublicKey={null} />);
    expect(markerKeys()).toContain(KEY_STALE);
  });
});
