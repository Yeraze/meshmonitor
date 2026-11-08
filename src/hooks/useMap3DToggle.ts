/**
 * useMap3DToggle — the 2D/3D toggle state every map surface shares (#4704).
 *
 * `viewMode` is ephemeral (not persisted). The toggle is only offered when the
 * server can serve DEM terrain tiles, and any capability loss forces 2D on the
 * spot (`effective3D`). Shared by NodesTab, DashboardMap and MeshCoreMap so the
 * set-up cannot drift between them.
 */
import { useMemo, useState } from 'react';
import { resolve3DBasemap, buildTerrainTileUrl, type Basemap3DSource } from '../config/basemap3d';
import { useTerrainCapabilities } from './useTerrainCapabilities';
import { appBasename } from '../init';

type CustomTilesets = Parameters<typeof resolve3DBasemap>[1];

export interface Map3DToggle {
  canUse3D: boolean;
  viewMode: '2d' | '3d';
  setViewMode: (mode: '2d' | '3d') => void;
  /** `viewMode === '3d'` AND the server can serve terrain. */
  effective3D: boolean;
  basemap3D: Basemap3DSource;
  terrainTileUrl: string;
}

export function useMap3DToggle(
  tilesetId: Parameters<typeof resolve3DBasemap>[0],
  customTilesets: CustomTilesets,
  cartoApiKey: Parameters<typeof resolve3DBasemap>[2],
): Map3DToggle {
  const terrainCaps = useTerrainCapabilities();
  const canUse3D = !terrainCaps.isLoading && terrainCaps.enabled && terrainCaps.terrainTiles;
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');
  const basemap3D = useMemo(
    () => resolve3DBasemap(tilesetId, customTilesets, cartoApiKey),
    [tilesetId, customTilesets, cartoApiKey],
  );
  // `appBasename` is the base-path prefix `ApiService` was seeded with at
  // startup: a module-scope constant that never changes.
  const terrainTileUrl = useMemo(() => buildTerrainTileUrl(appBasename), []);
  return {
    canUse3D,
    viewMode,
    setViewMode,
    effective3D: viewMode === '3d' && canUse3D,
    basemap3D,
    terrainTileUrl,
  };
}
