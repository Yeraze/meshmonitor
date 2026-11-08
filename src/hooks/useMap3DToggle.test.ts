/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const caps = vi.hoisted(() => ({ value: { enabled: true, terrainTiles: true, isLoading: false } }));
vi.mock('./useTerrainCapabilities', () => ({ useTerrainCapabilities: () => caps.value }));
vi.mock('../init', () => ({ appBasename: '/meshmonitor' }));

import { useMap3DToggle } from './useMap3DToggle';

describe('useMap3DToggle', () => {
  beforeEach(() => {
    caps.value = { enabled: true, terrainTiles: true, isLoading: false };
  });

  it('starts in 2D and goes 3D when terrain is available', () => {
    const { result } = renderHook(() => useMap3DToggle('osm', [], null));
    expect(result.current.canUse3D).toBe(true);
    expect(result.current.viewMode).toBe('2d');
    expect(result.current.effective3D).toBe(false);
    act(() => result.current.setViewMode('3d'));
    expect(result.current.effective3D).toBe(true);
  });

  it('builds the terrain URL from the base path and a raster basemap', () => {
    const { result } = renderHook(() => useMap3DToggle('osm', [], null));
    expect(result.current.terrainTileUrl).toBe('/meshmonitor/api/elevation/tiles/{z}/{x}/{y}');
    expect(result.current.basemap3D.tiles.length).toBeGreaterThan(0);
  });

  it('forces 2D when terrain is unavailable, even in 3D view mode', () => {
    caps.value = { enabled: false, terrainTiles: false, isLoading: false };
    const { result } = renderHook(() => useMap3DToggle('osm', [], null));
    expect(result.current.canUse3D).toBe(false);
    act(() => result.current.setViewMode('3d'));
    expect(result.current.viewMode).toBe('3d');
    expect(result.current.effective3D).toBe(false);
  });

  it('treats a loading capability read as unavailable', () => {
    caps.value = { enabled: true, terrainTiles: true, isLoading: true };
    const { result } = renderHook(() => useMap3DToggle('osm', [], null));
    expect(result.current.canUse3D).toBe(false);
  });
});
