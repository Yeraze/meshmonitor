/**
 * Tropospheric ducting overlay (#5734).
 *
 * A child of `BaseMap`. Draws the GFS ducting grid for the step on view as
 * semi-transparent, non-interactive rectangles, so node markers stay readable
 * and clickable. Normal and sub-refractive cells are left clear.
 *
 * One atmosphere for every source: the grid is the same whichever sources the
 * map shows (the source filter still decides which nodes are drawn).
 *
 * Fetches only while the admin switch is on, and only the step on view (see
 * `useDuctingForecast`). It sends no mesh traffic.
 */
import { Rectangle } from 'react-leaflet';
import { useDuctingEnabled, useDuctingForecast, type DuctingForecast } from '../../../hooks/useDuctingForecast';
import { ductingCellBounds, ductingCellStyle } from './ductingGeometry';
import styles from './DuctingLayer.module.css';

export interface DuctingLayerProps {
  /** The forecast step to draw, hours ahead. */
  hoursAhead: number;
}

const TONE_CLASS = { super: styles.super, duct: styles.duct } as const;

/** The cells to draw for one forecast. Exported for tests. */
export function DuctingCells({ forecast }: { forecast: DuctingForecast }) {
  const cells = [];
  const n = forecast.grid.ni * forecast.grid.nj;
  for (let k = 0; k < n; k++) {
    const style = ductingCellStyle(forecast.class[k] ?? null, forecast.ductStrengthM[k] ?? null);
    if (!style) continue;
    cells.push(
      <Rectangle
        // The tone is in the key: Leaflet sets a path's class only once.
        key={`${k}:${style.tone}`}
        bounds={ductingCellBounds(forecast.grid, k)}
        interactive={false}
        pathOptions={{
          stroke: false,
          fill: true,
          fillOpacity: style.fillOpacity,
          className: TONE_CLASS[style.tone],
        }}
      />,
    );
  }
  return <>{cells}</>;
}

export default function DuctingLayer({ hoursAhead }: DuctingLayerProps) {
  const enabled = useDuctingEnabled();
  const { data } = useDuctingForecast(hoursAhead, enabled);
  if (!enabled || !data) return null;
  return <DuctingCells forecast={data} />;
}
