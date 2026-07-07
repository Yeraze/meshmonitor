/**
 * PolarGridLayer — renders the polar grid overlay (range rings + azimuth
 * sectors, #2307) on the Map Analysis canvas (#3971).
 *
 * Map Analysis is scoped per source, so one grid is drawn per active source
 * that has a resolvable own-node position, centered on that node. The theme-
 * aware `overlayColors.polarGrid` palette is used (matching NodesTab); the
 * per-source coloring is reserved for the Unified/Dashboard map where several
 * grids routinely overlap.
 */
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { useOwnNodePositions } from '../../../hooks/useOwnNodePositions';
import PolarGridOverlay from '../../PolarGridOverlay';

export default function PolarGridLayer() {
  const { config } = useMapAnalysisCtx();
  // config.sources empty = "all sources" (unified semantics), matching the
  // marker/source filters elsewhere in Map Analysis.
  const ownPositions = useOwnNodePositions(config.sources);

  return (
    <>
      {ownPositions.map((op) => (
        <PolarGridOverlay key={op.sourceId} center={{ lat: op.lat, lng: op.lng }} />
      ))}
    </>
  );
}
