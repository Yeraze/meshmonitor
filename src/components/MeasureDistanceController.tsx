import React, { useEffect, useRef, useState } from 'react';
import { CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet';
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
 * Rendered as a child of a react-leaflet `<MapContainer>`. While `active`, it
 * intercepts clicks anywhere on the map — including directly on node markers —
 * via a **capture-phase** listener on the map container. That fires before the
 * marker's own click handler, so we can convert the click to a lat/lng, snap to
 * the nearest node in `points`, and suppress the marker popup while measuring.
 * (A plain `useMapEvents` click never fires for marker hits, so clicking on a
 * node used to just open its popup.)
 *
 * First pick sets anchor A, second sets B and draws the line + distance label,
 * a third pick restarts from a new A. Escape or toggling the tool off clears it.
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
  const [anchors, setAnchors] = useState<MeasurePoint[]>([]);

  const enabled = active && points.length >= 2;

  // Keep the latest points reachable from the (stable) click listener without
  // re-subscribing on every poll that returns a fresh array.
  const pointsRef = useRef(points);
  pointsRef.current = points;

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
    if (!enabled) setAnchors([]);
  }, [enabled]);

  // Capture-phase click interception. Registered on the map container so it
  // fires before Leaflet's marker/map click handlers — letting a click land on
  // a node marker without opening its popup.
  useEffect(() => {
    if (!enabled) return;
    const container = map.getContainer();
    const onClick = (e: MouseEvent) => {
      // Let map controls (zoom, attribution, tileset toggle) work normally.
      const target = e.target as HTMLElement | null;
      if (target && target.closest('.leaflet-control')) return;
      // Stop the marker popup / map click from also handling this event.
      e.stopPropagation();
      e.preventDefault();
      const latlng = map.mouseEventToLatLng(e);
      const picked = nearestPoint(pointsRef.current, latlng.lat, latlng.lng);
      if (!picked) return;
      setAnchors((prev) => {
        if (prev.length === 0) return [picked];
        if (prev.length === 1) {
          // Ignore re-picking the same node as the first anchor.
          return prev[0].id === picked.id ? prev : [prev[0], picked];
        }
        return [picked]; // completed pair -> restart from a new A
      });
    };
    container.addEventListener('click', onClick, true);
    return () => container.removeEventListener('click', onClick, true);
  }, [enabled, map]);

  // Escape clears / exits.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setAnchors([]);
      onExit?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onExit]);

  if (!enabled) return null;

  const [anchorA, anchorB] = anchors;
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
