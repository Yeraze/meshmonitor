import { useMapAnalysisCtx } from './MapAnalysisContext';
import { useTerrainCapabilities } from '../../hooks/useTerrainCapabilities';
import type { MapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';

export interface EffectiveViewMode {
  /** The view mode actually being rendered right now. */
  effectiveViewMode: MapAnalysisConfig['viewMode'];
  /**
   * True when the persisted config says `'3d'` but capabilities have resolved
   * unavailable. `MapAnalysisCanvas` owns the correcting effect that writes
   * `'2d'` back to the persisted config — read-only consumers just render.
   */
  forced2d: boolean;
}

/**
 * Which map surface is actually on screen (#3826 Phase 2 WP-D spec §3.11,
 * shared in #4371).
 *
 * A persisted `viewMode:'3d'` must never strand the user once capabilities
 * resolve unavailable (elevation disabled, or a JSON elevation source with no
 * DEM tiles). While the capabilities fetch is still in flight we deliberately
 * keep reporting `'3d'`, so a legitimately-available 3D view doesn't flash to
 * 2D and back.
 *
 * Shared by the canvas (which renders the branch and owns the effect that
 * corrects the persisted config) and the toolbar (whose "2D view only" layer
 * gating must describe the surface actually on screen). Reading raw
 * `config.viewMode` in the toolbar instead left a window where the canvas had
 * already fallen back to 2D but the toolbar still greyed out the 2D-only
 * layer toggles.
 */
export function useEffectiveViewMode(): EffectiveViewMode {
  const { config } = useMapAnalysisCtx();
  const terrainCaps = useTerrainCapabilities();
  const capsUnavailable =
    !terrainCaps.isLoading && !(terrainCaps.enabled && terrainCaps.terrainTiles);
  const forced2d = config.viewMode === '3d' && capsUnavailable;
  return { effectiveViewMode: forced2d ? '2d' : config.viewMode, forced2d };
}
