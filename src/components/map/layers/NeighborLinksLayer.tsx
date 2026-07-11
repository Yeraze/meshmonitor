import { Fragment, type ReactNode } from 'react';
import { Marker, Polyline } from 'react-leaflet';
import type { PathOptions, LeafletEventHandlerFnMap } from 'leaflet';
import { createArrowIcon } from '../../../utils/mapHelpers';
import { bearingBetween, neighborArrowFractions } from '../../../utils/neighborLinks';

/**
 * One neighbor-link line's render inputs, resolved consumer-side (Map
 * Consolidation epic #4047, Phase 7, WP2 — mirrors the descriptor shape of
 * `NodeMarkersLayer`). Every visual decision (color, weight, opacity, dash,
 * arrows, popup/tooltip content, click handling) is consumer-owned so each
 * surface's exact current look is preserved byte-for-byte — this is a PURE
 * REFACTOR of the render mechanics, NOT a visual-convergence pass (that is
 * deliberately deferred, see MAP_CONSOLIDATION_P7_SPEC.md §6.1).
 */
export interface NeighborLinkDescriptor {
  /** Stable, unique React key. */
  key: string;
  /** The two line endpoints, `[[lat, lng], [lat, lng]]`. When `arrows` is
   *  set, the arrow points FROM `positions[1]` TO `positions[0]` — matching
   *  NodesTab's "arrow points from neighbor to node" convention
   *  (`positions = [[nodeLat, nodeLng], [neighborLat, neighborLng]]`). */
  positions: [[number, number], [number, number]];
  /** Color / weight / opacity / dashArray — fully consumer-owned. */
  pathOptions: PathOptions;
  /** e.g. NodesTab's `neighbor-line node-X node-Y` hover-dim hook. */
  className?: string;
  /** Unidirectional direction-arrow decorations along the line. Optional —
   *  only NodesTab draws these today. */
  arrows?: {
    color: string;
    /** Fractions along the line (0–1) at which to draw an arrow. Default:
     *  {@link neighborArrowFractions} (25%/50%/75%). */
    fractions?: number[];
  };
  /** `<Popup>`/`<Tooltip>` — consumer owns content. Omit for a select-only
   *  (no popup) line. */
  children?: ReactNode;
  /** Plain leaflet handlers (e.g. MapAnalysis's click → `setSelected`). */
  eventHandlers?: LeafletEventHandlerFnMap;
}

export interface NeighborLinksLayerProps {
  links: NeighborLinkDescriptor[];
}

/**
 * Shared neighbor-link render layer (Map Consolidation epic #4047, Phase 7,
 * WP2). Promoted from the 7 near-identical inline/layer renderings across
 * NodesTab, DashboardMap (meshtastic + MeshCore), MapAnalysis
 * (`NeighborLinksLayer` + `MeshCoreNeighborLinksLayer`), MeshCoreMap, and
 * EmbedMap — "one `<Polyline>` per neighbor edge between two positioned
 * nodes", optionally with direction-arrow decorations and a popup/tooltip.
 *
 * A child of `MapContainer`. Owns only the render mechanics: it maps each
 * descriptor to a `<Polyline>` (with `pathOptions`/`className`/
 * `eventHandlers`/`children` passed through verbatim) and, when `arrows` is
 * present, a set of non-interactive arrow `<Marker>`s at the requested
 * fractions along the line (bearing via `bearingBetween`, icon via the
 * existing shared `createArrowIcon` from `mapHelpers`). All data derivation
 * (fetching neighbor edges, resolving endpoint positions, computing
 * SNR→opacity/weight, transport-class coloring, dedup) stays in each
 * consumer's own thin adapter — see §4.1 of the Phase-7 spec for the
 * per-consumer `pathOptions` this layer must reproduce losslessly.
 */
export function NeighborLinksLayer({ links }: NeighborLinksLayerProps) {
  return (
    <>
      {links.map((link) => {
        const [nodePos, neighborPos] = link.positions;
        const arrows = link.arrows;
        const fractions = arrows?.fractions ?? neighborArrowFractions;
        const bearing = arrows ? bearingBetween(neighborPos, nodePos) : 0;

        return (
          <Fragment key={link.key}>
            <Polyline
              positions={link.positions}
              pathOptions={link.pathOptions}
              className={link.className}
              eventHandlers={link.eventHandlers}
            >
              {link.children}
            </Polyline>
            {arrows &&
              fractions.map((fraction) => (
                <Marker
                  key={`${link.key}-arrow-${fraction}`}
                  position={[
                    neighborPos[0] + (nodePos[0] - neighborPos[0]) * fraction,
                    neighborPos[1] + (nodePos[1] - neighborPos[1]) * fraction,
                  ]}
                  icon={createArrowIcon(bearing, arrows.color)}
                  interactive={false}
                />
              ))}
          </Fragment>
        );
      })}
    </>
  );
}

export default NeighborLinksLayer;
