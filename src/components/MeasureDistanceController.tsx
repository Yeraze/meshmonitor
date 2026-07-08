import React, { useEffect, useState } from 'react';
import { CircleMarker, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { useSettings } from '../contexts/SettingsContext';
import { nearestPoint, measureLabel, type MeasurePoint } from '../utils/measureDistance';
import './MeasureDistanceController.css';

export interface MeasureDistanceControllerProps {
  /** When false the tool is inert (no cursor change, no listeners fire visibly). */
  active: boolean;
  /** Candidate endpoints — each map maps its positioned-node memo into these. */
  points: MeasurePoint[];
  /** Called when the user presses Escape so the parent can flip `active` off. */
  onExit?: () => void;
}

/**
 * Node-to-node line-of-sight (LOS) distance measurement tool (issue #3636).
 *
 * Rendered as a child of a react-leaflet `<MapContainer>`. While `active`, each
 * map click snaps to the nearest node in `points` (Leaflet map-background clicks
 * don't fire on marker hits, so snapping keeps this map-agnostic — clicking near
 * a node selects it). First click sets anchor A, second sets anchor B and draws
 * the line + distance label, a third click restarts from a new A. Escape or
 * toggling the tool off clears the measurement.
 *
 * This one component serves every map view; the activation toggle and the
 * `points` array are supplied per-map.
 */
const MeasureDistanceController: React.FC<MeasureDistanceControllerProps> = ({
  active,
  points,
  onExit,
}) => {
  const { distanceUnit } = useSettings();
  const map = useMap();
  const [anchorA, setAnchorA] = useState<MeasurePoint | null>(null);
  const [anchorB, setAnchorB] = useState<MeasurePoint | null>(null);

  const enabled = active && points.length >= 2;

  // Crosshair affordance while measuring; always restore on cleanup.
  useEffect(() => {
    if (!enabled) return;
    const container = map.getContainer();
    const prev = container.style.cursor;
    container.style.cursor = 'crosshair';
    return () => {
      container.style.cursor = prev;
    };
  }, [enabled, map]);

  // Clear anchors whenever the tool is switched off (or loses enough nodes).
  useEffect(() => {
    if (!enabled) {
      setAnchorA(null);
      setAnchorB(null);
    }
  }, [enabled]);

  // Escape clears / exits.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setAnchorA(null);
      setAnchorB(null);
      onExit?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onExit]);

  useMapEvents({
    click: (e) => {
      if (!enabled) return;
      const picked = nearestPoint(points, e.latlng.lat, e.latlng.lng);
      if (!picked) return;
      setAnchorA((prevA) => {
        // No A yet, or a completed pair -> start fresh with this pick as A.
        if (!prevA || anchorB) {
          setAnchorB(null);
          return picked;
        }
        // Have A, no B -> this pick becomes B (ignore re-picking the same node).
        if (picked.id === prevA.id) return prevA;
        setAnchorB(picked);
        return prevA;
      });
    },
  });

  if (!enabled) return null;

  const ringStyle = { color: '#38bdf8', weight: 3, fillColor: '#38bdf8', fillOpacity: 0.15 };

  return (
    <>
      {anchorA && (
        <CircleMarker center={[anchorA.lat, anchorA.lng]} radius={12} pathOptions={ringStyle} />
      )}
      {anchorB && (
        <CircleMarker center={[anchorB.lat, anchorB.lng]} radius={12} pathOptions={ringStyle} />
      )}
      {anchorA && anchorB && (
        <Polyline
          positions={[
            [anchorA.lat, anchorA.lng],
            [anchorB.lat, anchorB.lng],
          ]}
          pathOptions={{ color: '#38bdf8', weight: 3, dashArray: '8 8' }}
        >
          <Tooltip permanent direction="center" className="measure-distance-label">
            {measureLabel(anchorA, anchorB, distanceUnit)}
          </Tooltip>
        </Polyline>
      )}
    </>
  );
};

export default MeasureDistanceController;
