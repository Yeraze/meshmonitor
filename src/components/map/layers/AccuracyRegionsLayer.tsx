import { Rectangle } from 'react-leaflet';
import type { PathOptions } from 'leaflet';

/** Canonical gray precision-cell look, shared verbatim by MapAnalysis and
 *  DashboardMap prior to this promotion. Adapters that want a different look
 *  (e.g. NodesTab's hop-colored variant) pass their own `pathOptions` per
 *  descriptor. Not exported — kept module-private so this component file only
 *  exports the component + its types (react-refresh/only-export-components);
 *  consumers that need the literal value (e.g. tests) inline it themselves. */
const DEFAULT_ACCURACY_REGION_PATH_OPTIONS: PathOptions = {
  color: '#888',
  fillColor: '#888',
  fillOpacity: 0.08,
  opacity: 0.5,
  weight: 1,
};

/** One accuracy-region rectangle's render inputs, resolved consumer-side. */
export interface AccuracyRegionDescriptor {
  /** Stable, unique React key. */
  key: string;
  /** Rectangle bounds, e.g. from `precisionCellBounds` (`utils/precisionOffset`). */
  bounds: [[number, number], [number, number]];
  /** Per-region style override. Default: the canonical gray
   *  (`color`/`fillColor` `#888`, `fillOpacity` 0.08, `opacity` 0.5, `weight` 1).
   *  NodesTab supplies a hop-colored override here so the rectangle ties
   *  visually to its hop-colored marker. */
  pathOptions?: PathOptions;
}

export interface AccuracyRegionsLayerProps {
  regions: AccuracyRegionDescriptor[];
}

/**
 * Shared position-accuracy region render layer (Map Consolidation epic #4047,
 * Phase 7, WP3). Promoted from `MapAnalysis/layers/AccuracyRegionsLayer.tsx`
 * (the closest existing implementation to this shape — already props/data
 * driven rather than reading context directly) and generalized to a
 * descriptor-array so every consumer supplies its own bounds computation and
 * an optional style override.
 *
 * A child of `MapContainer`. Renders one `<Rectangle>` per descriptor with no
 * mechanics beyond the default-gray fallback — all data derivation
 * (`precisionCellBounds`/`hasAccuracyCell`, node filtering, hop coloring)
 * stays in the per-consumer adapter.
 */
export function AccuracyRegionsLayer({ regions }: AccuracyRegionsLayerProps) {
  return (
    <>
      {regions.map(({ key, bounds, pathOptions }) => (
        <Rectangle
          key={key}
          bounds={bounds}
          pathOptions={pathOptions ?? DEFAULT_ACCURACY_REGION_PATH_OPTIONS}
        />
      ))}
    </>
  );
}

export default AccuracyRegionsLayer;
