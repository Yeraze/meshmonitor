/**
 * Fit the map view to `points` once per `fitKey` (extracted from CoverageMap's
 * private `FitCoverageBounds`, #5891 P2).
 *
 * The caller builds `fitKey` from the FILTER SET (never a refresh anchor and,
 * for the walkabout hex map, never the H3 resolution). A refetch of the same
 * set arrives as a new `points` array reference and must NOT yank the view out
 * from under a user who has since panned or zoomed; only a new `fitKey` re-fits.
 */
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';

export interface FitBoundsOnceProps {
  points: Array<[number, number]>;
  fitKey: string;
  /** Zoom cap for a multi-point fit. Default 15. */
  maxZoom?: number;
}

export const FitBoundsOnce: React.FC<FitBoundsOnceProps> = ({ points, fitKey, maxZoom = 15 }) => {
  const map = useMap();
  const lastFittedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (points.length === 0) return;
    if (lastFittedKeyRef.current === fitKey) return;
    lastFittedKeyRef.current = fitKey;
    if (points.length === 1) {
      map.setView(points[0], 13);
      return;
    }
    const bounds = L.latLngBounds(points);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom });
  }, [map, points, fitKey, maxZoom]);
  return null;
};
