/**
 * AircraftTrailsLayer — flight trails for likely aircraft (#5364/#5365
 * Phase 3). Presentational: both Map Features panels build descriptors with
 * `buildAircraftTrailDescriptors` (`../aircraftTrails.ts`) and hand them in,
 * like `TraceroutePathsLayer`.
 *
 * Each trail draws as a dark outline under a coloured line (the Map Analysis
 * `PositionTrailsLayer` look), plus direction arrows from the shared
 * `generatePositionHistoryArrows`. Hovering the line shows the node name and
 * the time of the fix nearest the cursor.
 */
import { memo, useMemo, useState } from 'react';
import { Polyline, Tooltip } from 'react-leaflet';
import type { LeafletMouseEvent } from 'leaflet';
import { generatePositionHistoryArrows } from '../../../utils/mapHelpers';
import { bearingBetween } from '../../../utils/neighborLinks';
import type { PositionHistoryItem } from '../../../contexts/MapContext';
import { arrowIndices, nearestPointIndex, type AircraftTrailDescriptor } from '../aircraftTrails';

const TRAIL_WEIGHT = 4;
const OUTLINE_WEIGHT = 7;
const OUTLINE_COLOR = 'rgba(0,0,0,0.4)';
const TRAIL_OPACITY = 0.85;
/** Direction arrows per trail. Each is a dot plus a heading triangle. */
const ARROWS_PER_TRAIL = 12;

export interface AircraftTrailsLayerProps {
  trails: AircraftTrailDescriptor[];
  /** Tooltip text for a hovered trail. Defaults to "label · local time". */
  formatTooltip?: (label: string, ts: number) => string;
}

const defaultFormatTooltip = (label: string, ts: number): string =>
  `${label} · ${new Date(ts).toLocaleString()}`;

/** The fixes to put arrows on, each with the heading it was flying. */
function arrowItems(trail: AircraftTrailDescriptor): PositionHistoryItem[] {
  const n = trail.positions.length;
  return arrowIndices(n, ARROWS_PER_TRAIL).map((i) => {
    const from = trail.positions[i === 0 ? 0 : i - 1];
    const to = trail.positions[i === 0 ? Math.min(1, n - 1) : i];
    const heading = (bearingBetween(from, to) + 360) % 360;
    return {
      latitude: trail.positions[i][0],
      longitude: trail.positions[i][1],
      timestamp: trail.times[i],
      groundTrack: heading,
    };
  });
}

function TrailLine({
  trail,
  formatTooltip,
}: {
  trail: AircraftTrailDescriptor;
  formatTooltip: (label: string, ts: number) => string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number>(trail.times.length - 1);
  const arrows = useMemo(
    () => generatePositionHistoryArrows(arrowItems(trail), [trail.color], ARROWS_PER_TRAIL),
    [trail],
  );
  const hoverTs = trail.times[Math.min(Math.max(hoverIdx, 0), trail.times.length - 1)];

  return (
    <>
      <Polyline
        positions={trail.positions}
        pathOptions={{
          color: OUTLINE_COLOR,
          weight: OUTLINE_WEIGHT,
          opacity: TRAIL_OPACITY * 0.6,
          lineCap: 'round',
          lineJoin: 'round',
        }}
        interactive={false}
      />
      <Polyline
        positions={trail.positions}
        pathOptions={{
          color: trail.color,
          weight: TRAIL_WEIGHT,
          opacity: TRAIL_OPACITY,
          lineCap: 'round',
          lineJoin: 'round',
        }}
        eventHandlers={{
          mousemove: (e: LeafletMouseEvent) => {
            const idx = nearestPointIndex(trail.positions, e.latlng.lat, e.latlng.lng);
            if (idx >= 0) setHoverIdx(idx);
          },
        }}
      >
        <Tooltip sticky direction="top" opacity={0.9}>
          {formatTooltip(trail.label, hoverTs)}
        </Tooltip>
      </Polyline>
      {arrows}
    </>
  );
}

function AircraftTrailsLayerImpl({ trails, formatTooltip = defaultFormatTooltip }: AircraftTrailsLayerProps) {
  return (
    <>
      {trails.map((trail) => (
        <TrailLine key={trail.key} trail={trail} formatTooltip={formatTooltip} />
      ))}
    </>
  );
}

const AircraftTrailsLayer = memo(AircraftTrailsLayerImpl);
export default AircraftTrailsLayer;
