import { Circle } from 'react-leaflet';

/** One estimated-position uncertainty circle's render inputs. */
export interface EstimatedPositionRadius {
  /** Stable, unique React key. */
  key: string;
  center: [number, number];
  radiusMeters: number;
  /** Stroke and fill colour (the adapter picks it, e.g. a hop colour). */
  color: string;
}

export interface EstimatedPositionRadiiLayerProps {
  radii: EstimatedPositionRadius[];
}

/**
 * Dashed uncertainty circles for estimated positions (#6260 WP5). Extracted
 * from NodesTab so Meshtastic and MeshCore maps draw the same look. A child of
 * `MapContainer`; all filtering and colour choice stays in the adapter.
 */
export function EstimatedPositionRadiiLayer({ radii }: EstimatedPositionRadiiLayerProps) {
  return (
    <>
      {radii.map(({ key, center, radiusMeters, color }) => (
        <Circle
          key={key}
          center={center}
          radius={radiusMeters}
          pathOptions={{
            color,
            fillColor: color,
            fillOpacity: 0.1,
            opacity: 0.4,
            weight: 2,
            dashArray: '5, 5',
          }}
        />
      ))}
    </>
  );
}

export default EstimatedPositionRadiiLayer;
