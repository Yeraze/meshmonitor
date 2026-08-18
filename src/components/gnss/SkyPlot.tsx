/**
 * `SkyPlot` — a self-contained, presentational SVG polar sky plot for a GNSS
 * constellation (#4729). North is at the top, azimuth increases clockwise, and
 * elevation maps to radius so the zenith (90°) sits at the centre and the
 * horizon (0°) on the outer ring.
 *
 * Pure and data-driven: it fetches nothing. A consumer passes the satellite
 * list (and optional DOP) from `useSkyView`. Colours come from the app's theme
 * CSS variables (via the co-located CSS module), so it reads correctly in both
 * light and dark themes.
 */
import React from 'react';
import styles from './SkyPlot.module.css';

export interface SkyPlotSatellite {
  name: string;
  /** Azimuth in degrees, 0=North increasing clockwise. */
  azDeg: number;
  /** Elevation in degrees, 0=horizon, 90=zenith. */
  elDeg: number;
}

export interface SkyPlotDop {
  gdop: number;
  pdop: number;
  hdop: number;
  vdop: number;
}

export interface SkyPlotProps {
  satellites: SkyPlotSatellite[];
  dop?: SkyPlotDop | null;
  /** Overall square size in px. Default 240. */
  size?: number;
}

/** Elevation rings drawn inside the horizon circle. */
const RING_ELEVATIONS = [30, 60] as const;

/**
 * Project an (azimuth, elevation) pair onto SVG coordinates. Elevation is the
 * radius: elDeg=90 → r=0 (centre), elDeg=0 → r=R (outer horizon ring). Azimuth
 * 0° points up (North) and increases clockwise.
 */
function project(
  azDeg: number,
  elDeg: number,
  cx: number,
  cy: number,
  R: number,
): { x: number; y: number } {
  const clampedEl = Math.max(0, Math.min(90, elDeg));
  const r = (R * (90 - clampedEl)) / 90;
  const rad = (azDeg * Math.PI) / 180;
  return {
    x: cx + r * Math.sin(rad),
    y: cy - r * Math.cos(rad),
  };
}

export const SkyPlot: React.FC<SkyPlotProps> = ({ satellites, dop, size = 240 }) => {
  // A margin leaves room for the cardinal labels outside the horizon ring.
  const margin = 16;
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - margin;

  const cardinals: Array<{ label: string; az: number }> = [
    { label: 'N', az: 0 },
    { label: 'E', az: 90 },
    { label: 'S', az: 180 },
    { label: 'W', az: 270 },
  ];

  return (
    <div className={styles.skyplot}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width="100%"
        role="img"
        aria-label={`Sky plot with ${satellites.length} satellite${satellites.length === 1 ? '' : 's'}`}
        className={styles.svg}
      >
        {/* Horizon disc */}
        <circle cx={cx} cy={cy} r={R} className={styles.disc} />

        {/* Elevation rings */}
        {RING_ELEVATIONS.map((el) => (
          <circle
            key={el}
            cx={cx}
            cy={cy}
            r={(R * (90 - el)) / 90}
            className={styles.ring}
            data-testid="skyplot-ring"
          />
        ))}

        {/* Cardinal cross-hairs */}
        <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} className={styles.ring} />
        <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} className={styles.ring} />

        {/* Cardinal labels */}
        {cardinals.map(({ label, az }) => {
          const p = project(az, 0, cx, cy, R + margin * 0.7);
          return (
            <text
              key={label}
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className={styles.cardinal}
            >
              {label}
            </text>
          );
        })}

        {/* Satellites */}
        {satellites.map((sat, i) => {
          const p = project(sat.azDeg, sat.elDeg, cx, cy, R);
          return (
            <g key={`${sat.name}-${i}`} className={styles.sat} data-testid="skyplot-sat">
              <circle cx={p.x} cy={p.y} r={4} className={styles.satDot}>
                <title>{`${sat.name} · az ${Math.round(sat.azDeg)}° el ${Math.round(sat.elDeg)}°`}</title>
              </circle>
              <text x={p.x + 6} y={p.y - 5} className={styles.satLabel}>
                {sat.name}
              </text>
            </g>
          );
        })}
      </svg>

      {dop && (
        <div className={styles.dopRow} aria-label="Dilution of precision">
          <span className={styles.dopItem} title="Position DOP">
            PDOP <strong>{dop.pdop.toFixed(1)}</strong>
          </span>
          <span className={styles.dopItem} title="Horizontal DOP">
            HDOP <strong>{dop.hdop.toFixed(1)}</strong>
          </span>
          <span className={styles.dopItem} title="Vertical DOP">
            VDOP <strong>{dop.vdop.toFixed(1)}</strong>
          </span>
        </div>
      )}
    </div>
  );
};

export default SkyPlot;
