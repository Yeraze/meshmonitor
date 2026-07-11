/**
 * AccuracyRegionsLayer — draws the Meshtastic obscured-position accuracy square
 * for each node reporting a low `precision_bits` (issue #4016).
 *
 * Mirrors the Dashboard map's "Show Accuracy Regions" rectangle. The rectangle is
 * centered on the node's TRUE reported position (`resolveNodeLatLng`), NOT the
 * #4016 within-cell offset applied to the marker in `useAnalysisNodes` — so an
 * offset marker visibly sits inside its own uncertainty square.
 *
 * Thin adapter (Map Consolidation epic #4047, Phase 7, WP6): owns all
 * MapAnalysis-specific data derivation (`useAnalysisNodes`, un-offset
 * `resolveNodeLatLng` center, `precisionCellBounds`/`hasAccuracyCell`) and
 * maps its output onto the shared descriptor-based
 * `src/components/map/layers/AccuracyRegionsLayer` for rendering. No
 * `pathOptions` override is supplied — the shared layer's canonical gray
 * default reproduces this surface's look byte-for-byte.
 */
import { useMemo } from 'react';
import { useAnalysisNodes } from '../useAnalysisNodes';
import { resolveNodeLatLng } from '../nodePositionUtil';
import { precisionCellBounds, hasAccuracyCell } from '../../../utils/precisionOffset';
import {
  AccuracyRegionsLayer as SharedAccuracyRegionsLayer,
  type AccuracyRegionDescriptor,
} from '../../map/layers/AccuracyRegionsLayer';

export default function AccuracyRegionsLayer() {
  const analysisNodes = useAnalysisNodes();

  const regions = useMemo<AccuracyRegionDescriptor[]>(() => {
    return analysisNodes
      .map(({ node, key }) => {
        if (!hasAccuracyCell(node.positionPrecisionBits, node.positionIsOverride)) return null;
        // Center on the un-offset reported position, not the jittered marker.
        const center = resolveNodeLatLng(node);
        if (!center) return null;
        const bounds = precisionCellBounds(center[0], center[1], node.positionPrecisionBits as number);
        return { key: `accuracy-${key}`, bounds };
      })
      .filter((r): r is AccuracyRegionDescriptor => r !== null);
  }, [analysisNodes]);

  return <SharedAccuracyRegionsLayer regions={regions} />;
}
