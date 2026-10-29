/**
 * @vitest-environment jsdom
 *
 * Map centre/zoom live in an external store, not MapContext, so a pan
 * re-renders no MapContext consumer and a zoom re-renders only components
 * whose selected value flips. These tests pin that and the localStorage
 * persistence of the last view.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { MapProvider, useMapContext } from './MapContext';
import { createMapViewStore, useMapViewStore, useMapViewSelector, useMapZoom, DEFAULT_MAP_ZOOM } from './mapViewStore';

vi.mock('./CsrfContext', () => ({ useCsrf: () => ({ getToken: () => 'tok', refreshToken: vi.fn() }) }));
vi.mock('../services/api', () => ({ default: { getBaseUrl: () => Promise.resolve('') } }));

beforeEach(() => {
  localStorage.clear();
  // MapProvider loads saved map preferences on mount; answer "nothing saved".
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))) as unknown as typeof fetch;
});

describe('createMapViewStore', () => {
  it('starts from the saved view, or the default zoom with no centre', () => {
    expect(createMapViewStore().get()).toEqual({ center: null, zoom: DEFAULT_MAP_ZOOM });
    localStorage.setItem('mapCenter', JSON.stringify([10, 20]));
    localStorage.setItem('mapZoom', '7.5');
    expect(createMapViewStore().get()).toEqual({ center: [10, 20], zoom: 7.5 });
  });

  it('ignores a corrupt saved view', () => {
    localStorage.setItem('mapCenter', '{not json');
    localStorage.setItem('mapZoom', 'abc');
    expect(createMapViewStore().get()).toEqual({ center: null, zoom: DEFAULT_MAP_ZOOM });
  });

  it('persists changes and only notifies when the view actually changes', () => {
    const store = createMapViewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setCenter([1, 2]);
    store.setCenter([1, 2]);
    store.setZoom(9);
    store.setZoom(9);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem('mapCenter')).toBe('[1,2]');
    expect(localStorage.getItem('mapZoom')).toBe('9');
  });
});

describe('map view render isolation', () => {
  function setup() {
    const counts = { consumer: 0, labels: 0, zoom: 0 };
    let store: ReturnType<typeof useMapViewStore> | null = null;
    const Consumer = () => {
      counts.consumer++;
      useMapContext();
      return null;
    };
    // Like MapPositionHandler / ZoomHandler: writes without subscribing.
    const Writer = () => {
      store = useMapViewStore();
      return null;
    };
    const Labels = () => {
      counts.labels++;
      useMapViewSelector((s) => s.zoom >= 13);
      return null;
    };
    const Zoom = () => {
      counts.zoom++;
      useMapZoom();
      return null;
    };
    render(
      <MapProvider>
        <Consumer />
        <Writer />
        <Labels />
        <Zoom />
      </MapProvider>
    );
    return { counts, store: () => store! };
  }

  it('panning re-renders no MapContext consumer and no zoom subscriber', () => {
    const { counts, store } = setup();
    const before = { ...counts };
    act(() => {
      for (let i = 0; i < 5; i++) store().setCenter([40 + i, -70 - i]);
    });
    expect(counts).toEqual(before);
    expect(store().get().center).toEqual([44, -74]);
  });

  it('zooming re-renders a selector only when its value flips, and never the MapContext consumer', () => {
    const { counts, store } = setup();
    act(() => store().setZoom(13));
    const before = { ...counts };
    act(() => store().setZoom(14)); // still >= 13
    act(() => store().setZoom(15)); // still >= 13
    expect(counts.labels).toBe(before.labels);
    expect(counts.zoom).toBe(before.zoom + 2);
    act(() => store().setZoom(10)); // flips
    expect(counts.labels).toBe(before.labels + 1);
    expect(counts.consumer).toBe(before.consumer);
  });
});
