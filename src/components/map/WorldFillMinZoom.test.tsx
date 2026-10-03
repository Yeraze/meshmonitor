/**
 * @vitest-environment jsdom
 *
 * WorldFillMinZoom (#5556): the zoom floor is the smallest zoom at which one
 * world covers the whole container. Runs against a real Leaflet map; jsdom
 * has no layout, so the container size is stubbed through `getSize`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import L from 'leaflet';

const holder = vi.hoisted(() => ({ map: null as unknown }));
vi.mock('react-leaflet', () => ({ useMap: () => holder.map }));

import { WorldFillMinZoom } from './WorldFillMinZoom';

let size = L.point(0, 0);

function makeMap(zoom: number): L.Map {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const map = L.map(el, { center: [0, 0], zoom, zoomAnimation: false, fadeAnimation: false });
  map.getSize = () => size.clone();
  holder.map = map;
  return map;
}

afterEach(() => {
  cleanup();
  const m = holder.map as { remove?: () => void } | null;
  if (typeof m?.remove === 'function') m.remove();
  holder.map = null;
  document.body.innerHTML = '';
});

describe('WorldFillMinZoom', () => {
  it('floors a wide desktop map at the zoom where the world spans its width', () => {
    size = L.point(1920, 1080);
    const map = makeMap(1);
    render(<WorldFillMinZoom />);
    // 256·2^3 = 2048 px ≥ 1920; zoom 2 (1024 px) would leave grey bars.
    expect(map.getMinZoom()).toBe(3);
    // A map opened below the floor jumps up to it.
    expect(map.getZoom()).toBe(3);
  });

  it('floors a tall phone map by its height', () => {
    size = L.point(390, 800);
    const map = makeMap(5);
    render(<WorldFillMinZoom />);
    expect(map.getMinZoom()).toBe(2);
    // Already above the floor: the view is left alone.
    expect(map.getZoom()).toBe(5);
  });

  it('keeps a low floor for a small widget map', () => {
    size = L.point(300, 200);
    const map = makeMap(4);
    render(<WorldFillMinZoom />);
    expect(map.getMinZoom()).toBe(1);
  });

  it('recomputes the floor when the container resizes', () => {
    size = L.point(300, 200);
    const map = makeMap(4);
    render(<WorldFillMinZoom />);
    expect(map.getMinZoom()).toBe(1);
    size = L.point(1920, 1080);
    map.fire('resize');
    expect(map.getMinZoom()).toBe(3);
  });

  it('leaves the floor alone while the container is hidden (0×0)', () => {
    size = L.point(0, 0);
    const map = makeMap(1);
    render(<WorldFillMinZoom />);
    expect(map.getMinZoom()).toBe(0);
    expect(map.getZoom()).toBe(1);
  });

  it('stops listening for resizes on unmount', () => {
    size = L.point(300, 200);
    const map = makeMap(4);
    const { unmount } = render(<WorldFillMinZoom />);
    unmount();
    size = L.point(1920, 1080);
    map.fire('resize');
    expect(map.getMinZoom()).toBe(1);
  });

  it('is a no-op on a partial map mock', () => {
    holder.map = { invalidateSize: vi.fn() };
    expect(() => render(<WorldFillMinZoom />)).not.toThrow();
  });
});
