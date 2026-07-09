/**
 * AccuracyRegionsLayer — draws the Meshtastic obscured-position accuracy square
 * for each node reporting a low `precision_bits` (issue #4016).
 *
 * Mirrors the Dashboard map's "Show Accuracy Regions" rectangle. The rectangle is
 * centered on the node's TRUE reported position (`resolveNodeLatLng`), NOT the
 * #4016 within-cell offset applied to the marker in `useAnalysisNodes` — so an
 * offset marker visibly sits inside its own uncertainty square.
 */
import { useMemo } from 'react';
import { Rectangle } from 'react-leaflet';
import { useAnalysisNodes } from '../useAnalysisNodes';
import { resolveNodeLatLng } from '../nodePositionUtil';
import { precisionCellBounds } from '../../../utils/precisionOffset';

/** Obscured-position nodes: a defined, non-full precision that isn't a user override. */
function isObscured(bits: number | null | undefined, isOverride: boolean | null | undefined): boolean {
  if (isOverride) return false;
  if (bits == null) return false;
  return bits > 0 && bits < 32;
}

export default function AccuracyRegionsLayer() {
  const analysisNodes = useAnalysisNodes();

  const regions = useMemo(() => {
    return analysisNodes
      .map(({ node, key }) => {
        if (!isObscured(node.positionPrecisionBits, node.positionIsOverride)) return null;
        // Center on the un-offset reported position, not the jittered marker.
        const center = resolveNodeLatLng(node);
        if (!center) return null;
        const bounds = precisionCellBounds(center[0], center[1], node.positionPrecisionBits as number);
        return { key, bounds };
      })
      .filter((r): r is { key: string; bounds: [[number, number], [number, number]] } => r !== null);
  }, [analysisNodes]);

  return (
    <>
      {regions.map(({ key, bounds }) => (
        <Rectangle
          key={`accuracy-${key}`}
          bounds={bounds}
          pathOptions={{
            color: '#888',
            fillColor: '#888',
            fillOpacity: 0.08,
            opacity: 0.5,
            weight: 1,
          }}
        />
      ))}
    </>
  );
}
