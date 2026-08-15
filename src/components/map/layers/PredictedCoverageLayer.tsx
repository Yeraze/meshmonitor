/**
 * Predicted RF coverage layer (#4727).
 *
 * A child of `MapContainer`. Draws the modelled reach polygon returned by
 * `POST /api/rf/coverage`.
 *
 * **Deliberately unlike the observed-coverage layer.** `CoverageHeatmapLayer`
 * renders measured receptions as a diffuse `leaflet.heat` blob; this renders a
 * hard-edged **dashed** outline. The two must not be mistakable for one
 * another — conflating "signals were actually received here" with "a model
 * says signals should reach here" is the failure mode the issue calls out, and
 * the boundary is exactly where a prediction is least trustworthy, so a dashed
 * edge is the honest way to draw it.
 *
 * The model's assumptions ride in a popup on the polygon itself rather than
 * living only in a side panel, so the caveats cannot be separated from the
 * shape they qualify.
 */
import { Polygon, Popup } from 'react-leaflet';
import type { PathOptions } from 'leaflet';
import {
  coverageToPolygon,
  hasAnyDataGaps,
  hasAnyPockets,
  radiusLimitedFraction,
  type PredictedCoverage,
} from './predictedCoverageGeometry';

export interface PredictedCoverageLayerProps {
  coverage: PredictedCoverage | null;
  /** Hidden without unmounting, so a re-toggle does not refetch. */
  visible?: boolean;
  /** Style override; the dashed default is load-bearing, so change with care. */
  pathOptions?: PathOptions;
}

/**
 * Dashed, translucent, and thin. Reads as an annotation over the map rather
 * than as data drawn on it.
 */
const PREDICTED_PATH_OPTIONS: PathOptions = {
  color: '#7b61ff',
  weight: 2,
  dashArray: '6 4',
  fillColor: '#7b61ff',
  fillOpacity: 0.12,
};

export default function PredictedCoverageLayer({
  coverage,
  visible = true,
  pathOptions,
}: PredictedCoverageLayerProps) {
  if (!visible || !coverage) return null;

  const positions = coverageToPolygon(coverage);
  if (positions.length < 3) return null;

  const gaps = hasAnyDataGaps(coverage);
  const pockets = hasAnyPockets(coverage);
  const limited = radiusLimitedFraction(coverage);

  return (
    <Polygon
      positions={positions}
      pathOptions={{ ...PREDICTED_PATH_OPTIONS, ...pathOptions }}
      // Not a testid on a Leaflet path (it renders to SVG without passing
      // arbitrary props through), so consumers/tests key off the class.
      className="predicted-coverage-polygon"
    >
      <Popup>
        <strong>Predicted coverage</strong>
        <ul>
          {coverage.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        {/* Caveats that depend on THIS result, not on the model in general. */}
        {limited > 0 && (
          <p>
            {Math.round(limited * 100)}% of directions still had signal at the
            edge of the search radius — the true reach that way is further than drawn.
          </p>
        )}
        {pockets && (
          <p>
            Some directions have reachable ground beyond the drawn boundary
            (for example a hilltop visible over a nearer ridge). The boundary is
            where coverage first stops, not the furthest reachable point.
          </p>
        )}
        {gaps && <p>Terrain data was missing in places; those directions are less reliable.</p>}
      </Popup>
    </Polygon>
  );
}
