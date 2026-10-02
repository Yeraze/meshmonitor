/**
 * @vitest-environment jsdom
 *
 * #5516: vector basemaps + node clustering crashed with "Map has no maxZoom
 * specified". This runs REAL Leaflet, react-leaflet and leaflet.markercluster;
 * only the MapLibre adapter is faked (jsdom has no WebGL). The fake mirrors
 * the real adapter's shape: a plain `L.Layer` that stores its options, so it
 * never registers a zoom bound on its own.
 */
import { createRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import L from 'leaflet';
import { MapContainer } from 'react-leaflet';
import { BaseMap } from './BaseMap';
import { ZoomCeilingBackstop } from './ZoomCeilingBackstop';
import { NodeMarkerCluster } from './layers/NodeMarkerCluster';
import type { CustomTileset } from '../../config/tilesets';

vi.mock('@maplibre/maplibre-gl-leaflet', async () => {
  const leaflet = (await import('leaflet')).default;
  const FakeMaplibreLayer = leaflet.Layer.extend({
    initialize(options: Record<string, unknown>) {
      leaflet.setOptions(this, options);
    },
    onAdd() {},
    onRemove() {},
  });
  (leaflet as unknown as { maplibreGL: (o: unknown) => L.Layer }).maplibreGL = (o) =>
    new (FakeMaplibreLayer as unknown as new (o: unknown) => L.Layer)(o);
  return {};
});
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('react-leaflet-cluster/dist/assets/MarkerCluster.css', () => ({}));
vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});

const customVector: CustomTileset = {
  id: 'custom-vec',
  name: 'Self-hosted vector',
  url: 'https://tiles.example.com/{z}/{x}/{y}.pbf',
  attribution: 'x',
  maxZoom: 16,
  description: '',
  createdAt: 0,
  updatedAt: 0,
};

function renderWithCluster(tilesetId: string, customTilesets: CustomTileset[] = []) {
  const mapRef = createRef<L.Map>();
  const utils = render(
    <div style={{ width: 400, height: 300 }}>
      <BaseMap center={[0, 0]} zoom={3} tilesetId={tilesetId} customTilesets={customTilesets} mapRef={mapRef}>
        <NodeMarkerCluster>{null}</NodeMarkerCluster>
      </BaseMap>
    </div>,
  );
  return { mapRef, ...utils };
}

describe('BaseMap zoom ceiling with clustering (#5516)', () => {
  afterEach(() => cleanup());

  it('a custom vector tileset gives the map its finite maxZoom and clustering mounts', () => {
    const { mapRef } = renderWithCluster('custom-vec', [customVector]);
    expect(mapRef.current!.getMaxZoom()).toBe(16);
  });

  it('a custom vector tileset with a broken maxZoom falls back to 18', () => {
    const { mapRef } = renderWithCluster('custom-vec', [{ ...customVector, maxZoom: NaN }]);
    expect(mapRef.current!.getMaxZoom()).toBe(18);
  });

  it('a CARTO vector preset gives the map its finite maxZoom and clustering mounts', () => {
    const { mapRef } = renderWithCluster('cartoVoyager');
    expect(mapRef.current!.getMaxZoom()).toBe(19);
  });

  it('follows the ceiling when switching vector -> raster with a lower cap', () => {
    const mapRef = createRef<L.Map>();
    const el = (id: string) => (
      <BaseMap center={[0, 0]} zoom={3} tilesetId={id} customTilesets={[customVector]} mapRef={mapRef}>
        <NodeMarkerCluster>{null}</NodeMarkerCluster>
      </BaseMap>
    );
    const { rerender } = render(el('custom-vec'));
    expect(mapRef.current!.getMaxZoom()).toBe(16);
    rerender(el('openTopo'));
    expect(mapRef.current!.getMaxZoom()).toBe(17);
    rerender(el('cartoPositron'));
    expect(mapRef.current!.getMaxZoom()).toBe(19);
  });
});

describe('ZoomCeilingBackstop (#5516)', () => {
  afterEach(() => cleanup());

  it('gives a map with no bounded layer a ceiling before clustering mounts', () => {
    const mapRef = createRef<L.Map>();
    render(
      <MapContainer center={[0, 0]} zoom={3} ref={mapRef}>
        <ZoomCeilingBackstop maxZoom={17} />
        <NodeMarkerCluster>{null}</NodeMarkerCluster>
      </MapContainer>,
    );
    expect(mapRef.current!.getMaxZoom()).toBe(17);
  });

  it('leaves an existing layer ceiling alone', () => {
    const mapRef = createRef<L.Map>();
    render(
      <BaseMap center={[0, 0]} zoom={3} tilesetId="openTopo" mapRef={mapRef} />,
    );
    expect(mapRef.current!.options.maxZoom).toBeUndefined();
    expect(mapRef.current!.getMaxZoom()).toBe(17);
  });
});
