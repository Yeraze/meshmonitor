/**
 * RouteFlowMap — small, non-interactive map that traces a route's geospatial
 * flow: labeled endpoint / hop markers joined by a line. Shared by the MeshCore
 * message-route modal (fixed dashed line) and the contact Trace Path card
 * (per-hop SNR coloring via the shared `TraceroutePathsLayer`).
 *
 * Pure presentation: callers decide which points exist and hide the map when a
 * partial line would misrepresent the route.
 */
import React, { useEffect } from 'react';
import L from 'leaflet';
import { CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet';
import { BaseMap } from './BaseMap';
import { TraceroutePathsLayer } from './layers/TraceroutePathsLayer';
import type { SnrColorScale } from '../../utils/mapHelpers';
import type { TracerouteRenderSegment } from '../../utils/tracerouteSegments';
import styles from './RouteFlowMap.module.css';

/** A labeled point on the flow map. */
export interface RouteFlowPoint {
  key: string;
  label: string;
  lat: number;
  lon: number;
  /** 'endpoint' = sender / local node, 'hop' = relay. */
  kind: 'endpoint' | 'hop';
}

export interface RouteFlowMapProps {
  points: RouteFlowPoint[];
  /** When set, draws these (SNR-colored) segments instead of the fixed dashed line. */
  segments?: TracerouteRenderSegment[];
  snrColors: SnrColorScale;
  /**
   * 'snr' (default) colours each segment by its SNR. 'leg' colours by direction
   * instead: segments with `leg: 'return'` use `legColors.return`, the rest
   * `legColors.forward`.
   */
  colorMode?: 'snr' | 'leg';
  /** Required for `colorMode: 'leg'`. */
  legColors?: { forward: string; return: string };
}

// Leaflet path options take literal color strings, not CSS variables.
const HOP_COLOR = '#89b4fa';
const ENDPOINT_COLOR = '#7f849c';

/** Fit the map view to the flow line once per point set. */
const FitFlowBounds: React.FC<{ points: RouteFlowPoint[] }> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    const latLngs = points.map((p) => [p.lat, p.lon] as [number, number]);
    if (latLngs.length === 1) {
      map.setView(latLngs[0], 13);
      return;
    }
    const bounds = L.latLngBounds(latLngs);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  }, [map, points]);
  return null;
};

export const RouteFlowMap: React.FC<RouteFlowMapProps> = ({ points, segments, snrColors, colorMode = 'snr', legColors }) => {
  if (points.length === 0) return null;
  return (
    <div className={`${styles.map} mc-route-flow-map`}>
      <BaseMap
        center={[points[0].lat, points[0].lon]}
        zoom={11}
        zoomControl={false}
        attributionControl={false}
        scrollWheelZoom={false}
      >
        <FitFlowBounds points={points} />
        {segments && segments.length > 0 ? (
          <TraceroutePathsLayer
            segments={segments}
            snrColors={snrColors}
            colorMode={colorMode === 'leg' && legColors ? 'fixed-leg' : 'snr'}
            legColors={colorMode === 'leg' ? legColors : undefined}
            weight={4}
            opacity={0.9}
            dashMode="never"
          />
        ) : (
          points.length > 1 && (
            <Polyline
              positions={points.map((p) => [p.lat, p.lon] as [number, number])}
              pathOptions={{ color: HOP_COLOR, weight: 3, opacity: 0.85, dashArray: '6 6' }}
            />
          )
        )}
        {points.map((p) => (
          <CircleMarker
            key={p.key}
            center={[p.lat, p.lon]}
            radius={p.kind === 'hop' ? 7 : 5}
            pathOptions={{
              color: p.kind === 'hop' ? HOP_COLOR : ENDPOINT_COLOR,
              fillColor: p.kind === 'hop' ? HOP_COLOR : ENDPOINT_COLOR,
              fillOpacity: 0.85,
            }}
          >
            <Tooltip permanent direction="top" offset={[0, -8]} className="mc-route-flow-label">
              {p.label}
            </Tooltip>
          </CircleMarker>
        ))}
      </BaseMap>
    </div>
  );
};
