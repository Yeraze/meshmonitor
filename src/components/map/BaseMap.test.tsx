/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BaseMap } from './BaseMap';
import { getTilesetById } from '../../config/tilesets';

// ---------------------------------------------------------------------------
// Mocks (mirrors src/components/Dashboard/DashboardMap.test.tsx)
// ---------------------------------------------------------------------------

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children, ...props }: { children?: ReactNode; scrollWheelZoom?: boolean }) => (
    <div
      data-testid="map-container"
      data-scrollwheel={String(props.scrollWheelZoom)}
      data-own-option-keys={['scrollWheelZoom', 'doubleClickZoom', 'zoomControl', 'attributionControl']
        .filter((k) => k in props)
        .join(',')}
    >
      {children}
    </div>
  ),
  TileLayer: (props: { url?: string; maxZoom?: number }) => (
    <div data-testid="raster-tile" data-url={props.url} data-maxzoom={String(props.maxZoom)} />
  ),
  useMap: () => ({ invalidateSize: vi.fn() }),
  useMapEvents: () => ({ invalidateSize: vi.fn() }),
}));

vi.mock('../VectorTileLayer', () => ({
  VectorTileLayer: (p: { url?: string }) => <div data-testid="vector-tile" data-url={p.url} />,
}));

vi.mock('../TilesetSelector', () => ({
  TilesetSelector: (p: { selectedTilesetId?: string }) => (
    <div data-testid="tileset-selector" data-selected={p.selectedTilesetId} />
  ),
}));

vi.mock('../MapResizeHandler', () => ({
  default: () => <div data-testid="resize-handler" />,
}));

// leafletDefaultIcon is a side-effect module (mutates the global L.Icon.Default);
// stub it out for the mocked-react-leaflet tests so they don't depend on real leaflet.
vi.mock('./leafletDefaultIcon', () => ({}));

// Wrap the real getTilesetById in a vi.fn so individual tests can override its
// return value (vector-branch test) while everything else uses the real
// implementation (raster/fallback tests, which must reflect the actual osm URL).
vi.mock('../../config/tilesets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/tilesets')>();
  return {
    ...actual,
    getTilesetById: vi.fn(actual.getTilesetById),
  };
});

const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

describe('BaseMap', () => {
  // 1. Raster branch (default props)
  it('renders a raster TileLayer by default (no tilesetId)', () => {
    render(<BaseMap center={[0, 0]} zoom={3} />);
    const rasterTile = screen.getByTestId('raster-tile');
    expect(rasterTile).toBeInTheDocument();
    expect(rasterTile.getAttribute('data-url')).toBe(OSM_URL);
    expect(screen.queryByTestId('vector-tile')).not.toBeInTheDocument();
  });

  // 2. Vector branch
  it('renders VectorTileLayer when the resolved tileset is a vector tileset', () => {
    vi.mocked(getTilesetById).mockReturnValueOnce({
      id: 'custom-vector',
      name: 'Vector',
      url: 'https://x/{z}/{x}/{y}.pbf',
      attribution: '',
      maxZoom: 14,
      isVector: true,
    });
    render(<BaseMap center={[0, 0]} zoom={3} tilesetId="custom-vector" />);
    const vectorTile = screen.getByTestId('vector-tile');
    expect(vectorTile).toBeInTheDocument();
    expect(vectorTile.getAttribute('data-url')).toBe('https://x/{z}/{x}/{y}.pbf');
    expect(screen.queryByTestId('raster-tile')).not.toBeInTheDocument();
  });

  // 3. Unknown-id fallback
  it('falls back to raster osm when given an unknown tileset id', () => {
    render(<BaseMap center={[0, 0]} zoom={3} tilesetId="does-not-exist" />);
    const rasterTile = screen.getByTestId('raster-tile');
    expect(rasterTile).toBeInTheDocument();
    expect(rasterTile.getAttribute('data-url')).toBe(OSM_URL);
  });

  // 3b. Tile-key remount (Phase 7 §2.1): the tile layer must remount (fresh
  // DOM node) when the resolved tileset id changes, and must NOT remount for
  // an unrelated re-render that leaves the tileset id unchanged.
  it('remounts the raster tile layer when tilesetId changes', () => {
    const { rerender, getByTestId } = render(<BaseMap center={[0, 0]} zoom={3} tilesetId="osm" />);
    const before = getByTestId('raster-tile');
    rerender(<BaseMap center={[0, 0]} zoom={3} tilesetId="osmHot" />);
    const after = getByTestId('raster-tile');
    expect(after).not.toBe(before);
  });

  it('does not remount the raster tile layer on an unrelated re-render (tilesetId unchanged)', () => {
    const { rerender, getByTestId } = render(<BaseMap center={[0, 0]} zoom={3} tilesetId="osm" />);
    const before = getByTestId('raster-tile');
    rerender(<BaseMap center={[0, 0]} zoom={4} tilesetId="osm" />);
    const after = getByTestId('raster-tile');
    expect(after).toBe(before);
  });

  it('remounts the 4 Phase-1 editors (no tilesetId) identically across re-renders — stable key', () => {
    const { rerender, getByTestId } = render(<BaseMap center={[0, 0]} zoom={3} />);
    const before = getByTestId('raster-tile');
    rerender(<BaseMap center={[0, 0]} zoom={5} />);
    const after = getByTestId('raster-tile');
    expect(after).toBe(before);
  });

  // 4. Selector gating (sibling, not child)
  it('does not render the TilesetSelector by default', () => {
    render(<BaseMap center={[0, 0]} zoom={3} />);
    expect(screen.queryByTestId('tileset-selector')).not.toBeInTheDocument();
  });

  it('renders the TilesetSelector as a sibling of MapContainer, not a descendant, when enabled', () => {
    render(<BaseMap center={[0, 0]} zoom={3} tilesetId="osm" showTilesetSelector />);
    const selector = screen.getByTestId('tileset-selector');
    expect(selector).toBeInTheDocument();
    expect(selector.getAttribute('data-selected')).toBe('osm');
    expect(screen.getByTestId('map-container')).not.toContainElement(selector);
  });

  // 5. Resize gating
  it('does not mount MapResizeHandler when resizeTrigger is omitted', () => {
    render(<BaseMap center={[0, 0]} zoom={3} />);
    expect(screen.queryByTestId('resize-handler')).not.toBeInTheDocument();
  });

  it('mounts MapResizeHandler when resizeTrigger is provided', () => {
    render(<BaseMap center={[0, 0]} zoom={3} resizeTrigger={1} />);
    expect(screen.getByTestId('resize-handler')).toBeInTheDocument();
  });

  // 6. Children passthrough
  it('renders children inside the map container', () => {
    render(
      <BaseMap center={[0, 0]} zoom={3}>
        <div data-testid="child" />
      </BaseMap>,
    );
    const child = screen.getByTestId('child');
    expect(child).toBeInTheDocument();
    expect(screen.getByTestId('map-container')).toContainElement(child);
  });

  // 7. Prop passthrough
  it('forwards scrollWheelZoom to MapContainer', () => {
    render(<BaseMap center={[0, 0]} zoom={3} scrollWheelZoom />);
    expect(screen.getByTestId('map-container').getAttribute('data-scrollwheel')).toBe('true');
  });

  it('omits interaction options entirely when not passed — an explicit undefined would override Leaflet defaults and disable the handlers (#4047 wheel-zoom regression)', () => {
    render(<BaseMap center={[0, 0]} zoom={3} />);
    expect(screen.getByTestId('map-container').getAttribute('data-own-option-keys')).toBe('');
  });

  it('includes only the interaction options that were explicitly passed', () => {
    render(<BaseMap center={[0, 0]} zoom={3} scrollWheelZoom={false} zoomControl />);
    expect(screen.getByTestId('map-container').getAttribute('data-own-option-keys')).toBe('scrollWheelZoom,zoomControl');
  });

  // 8. Icon fix applied (unmocked icon module, real leaflet)
  it('applies the shared default-icon fix once and idempotently', async () => {
    vi.doUnmock('./leafletDefaultIcon');
    vi.resetModules();
    const L = (await import('leaflet')).default;
    await import('./leafletDefaultIcon');
    // Leaflet's base `Icon.prototype` also defines `_getIconUrl`, so after
    // deleting the `Icon.Default.prototype` OWN override, a simple property
    // read still resolves through the prototype chain to the inherited base
    // method (that inheritance fallback is the actual mechanism of the fix —
    // the base method just reads `options.iconUrl` directly, unlike the
    // overridden version which prepends a CDN-detected `imagePath`). Assert
    // the own property was removed rather than that the resolved value is
    // undefined.
    expect(
      Object.prototype.hasOwnProperty.call(L.Icon.Default.prototype, '_getIconUrl'),
    ).toBe(false);
    expect((L.Icon.Default.prototype.options as any).iconUrl).toEqual(
      expect.stringContaining('.png'),
    );
    // Re-importing (simulating a second module evaluation) must not throw.
    await expect(import('./leafletDefaultIcon')).resolves.toBeDefined();
  });
});
