/**
 * Map view (centre + zoom) store.
 *
 * The map's centre changes on every pan and its zoom on every zoom step. Both
 * used to be state on `MapContext`, which App and ~10 other components read,
 * so each pan re-rendered all of them. They now live in this small external
 * store. Nothing subscribes to the centre (it is only read as a mount-time
 * starting point), and zoom subscribers pick the narrowest value they need via
 * `useMapViewSelector` (e.g. "zoom < 8"), so they re-render only when that
 * value flips.
 *
 * The store persists the last view to localStorage under the same keys as
 * before (`mapCenter`, `mapZoom`). `MapProvider` owns one store per provider;
 * outside a provider the hooks fall back to a module-level store.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';

export type MapCenter = [number, number];

export interface MapViewState {
  center: MapCenter | null;
  zoom: number;
}

export interface MapViewStore {
  get: () => MapViewState;
  setCenter: (center: MapCenter | null) => void;
  setZoom: (zoom: number) => void;
  subscribe: (listener: () => void) => () => void;
}

/** Zoom used when nothing is saved (city/neighbourhood level). */
export const DEFAULT_MAP_ZOOM = 13;

function readSavedCenter(): MapCenter | null {
  try {
    const saved = localStorage.getItem('mapCenter');
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) && parsed.length === 2 ? (parsed as MapCenter) : null;
  } catch {
    return null;
  }
}

function readSavedZoom(): number {
  try {
    const saved = localStorage.getItem('mapZoom');
    if (saved) {
      const zoom = parseFloat(saved);
      if (!isNaN(zoom)) return zoom;
    }
  } catch {
    // storage unavailable: fall through to the default
  }
  return DEFAULT_MAP_ZOOM;
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable or full: the view just won't be remembered
  }
}

export function createMapViewStore(): MapViewStore {
  let state: MapViewState = { center: readSavedCenter(), zoom: readSavedZoom() };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    get: () => state,
    setCenter: (center) => {
      const prev = state.center;
      if (center === prev || (center && prev && center[0] === prev[0] && center[1] === prev[1])) return;
      state = { ...state, center };
      if (center) persist('mapCenter', JSON.stringify(center));
      emit();
    },
    setZoom: (zoom) => {
      if (zoom === state.zoom) return;
      state = { ...state, zoom };
      persist('mapZoom', zoom.toString());
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const MapViewContext = createContext<MapViewStore | null>(null);

let fallbackStore: MapViewStore | null = null;

/** The store itself — stable identity, never causes a re-render. */
export function useMapViewStore(): MapViewStore {
  const store = useContext(MapViewContext);
  if (store) return store;
  if (!fallbackStore) fallbackStore = createMapViewStore();
  return fallbackStore;
}

/**
 * Subscribe to a value derived from the map view. Re-renders only when the
 * selected value changes (by `Object.is`), so return a primitive.
 */
export function useMapViewSelector<T>(selector: (state: MapViewState) => T): T {
  const store = useMapViewStore();
  const getSnapshot = () => selector(store.get());
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Current zoom; re-renders on every zoom change. */
export function useMapZoom(): number {
  return useMapViewSelector((s) => s.zoom);
}
