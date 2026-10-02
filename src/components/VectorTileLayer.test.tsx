/**
 * @vitest-environment jsdom
 *
 * VectorTileLayer — styleUrl branch + Carto transformRequest (#5448,
 * CARTO_API_KEY_PLAN.md §2c). `L.maplibreGL` is mocked so we can assert the
 * exact options MapLibre would be constructed with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const { maplibreGL, addTo, fakeMap } = vi.hoisted(() => {
  const addTo = vi.fn();
  return {
    addTo,
    maplibreGL: vi.fn(() => ({ addTo })),
    fakeMap: { removeLayer: vi.fn(), _addZoomLimit: vi.fn(), _removeZoomLimit: vi.fn() },
  };
});

vi.mock('leaflet', () => ({ default: { maplibreGL } }));
vi.mock('@maplibre/maplibre-gl-leaflet', () => ({}));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('react-leaflet', () => ({ useMap: () => fakeMap }));

import { VectorTileLayer } from './VectorTileLayer';

type Options = {
  style: unknown;
  maxZoom?: number;
  minZoom?: number;
  attribution?: string;
  transformRequest?: (url: string) => { url: string } | undefined;
};

function lastOptions(): Options {
  const calls = maplibreGL.mock.calls as unknown as Options[][];
  return calls[calls.length - 1][0];
}

describe('VectorTileLayer', () => {
  beforeEach(() => {
    maplibreGL.mockClear();
    addTo.mockClear();
  });
  afterEach(() => {
    cleanup();
    document.querySelectorAll('base').forEach((b) => b.remove());
  });

  it('passes an absolute styleUrl straight to MapLibre', () => {
    render(
      <VectorTileLayer
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"
        styleUrl="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"
        attribution="OSM CARTO"
      />,
    );
    const opts = lastOptions();
    expect(opts.style).toBe('https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json');
    expect(opts.attribution).toBe('OSM CARTO');
    expect(addTo).toHaveBeenCalledWith(fakeMap);
  });

  it('styleUrl wins over a styleJson passthrough', () => {
    render(
      <VectorTileLayer
        url="https://x/{z}/{x}/{y}.png"
        styleUrl="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
        styleJson={{ version: 8, sources: {}, layers: [] }}
      />,
    );
    expect(lastOptions().style).toBe('https://basemaps.cartocdn.com/gl/positron-gl-style/style.json');
  });

  it('resolves a bundled relative style against the <base href> sub-path', () => {
    const base = document.createElement('base');
    base.setAttribute('href', '/meshmonitor/');
    document.head.appendChild(base);
    render(<VectorTileLayer url="https://x/{z}/{x}/{y}.png" styleUrl="map-styles/carto-voyager-dark.json" />);
    expect(lastOptions().style).toBe(`${window.location.origin}/meshmonitor/map-styles/carto-voyager-dark.json`);
  });

  it('resolves a bundled relative style at the origin root when there is no <base>', () => {
    render(<VectorTileLayer url="https://x/{z}/{x}/{y}.png" styleUrl="map-styles/carto-voyager-dark.json" />);
    expect(lastOptions().style).toBe(`${window.location.origin}/map-styles/carto-voyager-dark.json`);
  });

  it('installs a transformRequest that keys CARTO hosts only', () => {
    render(
      <VectorTileLayer
        url="https://x/{z}/{x}/{y}.png"
        styleUrl="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"
        cartoApiKey="KEY123"
      />,
    );
    const { transformRequest } = lastOptions();
    expect(transformRequest).toBeTypeOf('function');
    expect(transformRequest!('https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json')).toEqual({
      url: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json?key=KEY123',
    });
    expect(transformRequest!('https://tiles-b.basemaps.cartocdn.com/vectortiles/carto.streets/v1/3/1/2.mvt')).toEqual({
      url: 'https://tiles-b.basemaps.cartocdn.com/vectortiles/carto.streets/v1/3/1/2.mvt?key=KEY123',
    });
    expect(transformRequest!('https://tiles.example.com/3/1/2.pbf')).toBeUndefined();
    expect(transformRequest!(`${window.location.origin}/map-styles/carto-voyager-dark.json`)).toBeUndefined();
  });

  it('transformRequest is a no-op without a key', () => {
    render(
      <VectorTileLayer
        url="https://x/{z}/{x}/{y}.png"
        styleUrl="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"
      />,
    );
    expect(lastOptions().transformRequest!('https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json')).toBeUndefined();
  });

  it('keeps the synthesized default style for a plain .pbf template (no styleUrl)', () => {
    render(<VectorTileLayer url="https://tiles.example.com/{z}/{x}/{y}.pbf" maxZoom={14} />);
    const style = lastOptions().style as { sources: Record<string, { tiles: string[] }> };
    expect(style.sources['vector-tiles'].tiles).toEqual(['https://tiles.example.com/{z}/{x}/{y}.pbf']);
  });

  it('hands MapLibre the zoom ceiling and registers it with the map (#5516)', () => {
    fakeMap._addZoomLimit.mockClear();
    fakeMap._removeZoomLimit.mockClear();
    const { unmount } = render(
      <VectorTileLayer
        url="https://x/{z}/{x}/{y}.png"
        styleUrl="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"
        maxZoom={19}
      />,
    );
    const opts = lastOptions();
    expect(opts.maxZoom).toBe(19);
    // MapLibre runs one level below Leaflet; a forwarded floor of 0 would clamp it.
    expect(opts.minZoom).toBeUndefined();
    const layer = maplibreGL.mock.results[maplibreGL.mock.results.length - 1].value;
    expect(fakeMap._addZoomLimit).toHaveBeenCalledWith(layer);
    unmount();
    expect(fakeMap._removeZoomLimit).toHaveBeenCalledWith(layer);
  });
});
