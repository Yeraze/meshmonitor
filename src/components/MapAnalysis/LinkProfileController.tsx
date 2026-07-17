import React, { useEffect, useRef } from 'react';
import { CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet';
import { useSettings } from '../../contexts/SettingsContext';
import { nearestPoint, measureLabel } from '../../utils/measureDistance';
import type { LinkEndpoint, LinkVerdict } from '../../utils/linkProfile';
import { VERDICT_COLOR } from '../../utils/linkProfile';
import './LinkProfileController.css';

/** Screen-space snap threshold (px) for treating a click as "on" a node. */
const SNAP_PX = 24;

/** Amber shown while the drawer hasn't resolved a verdict yet (or none applies). */
const PENDING_COLOR = '#f59e0b';

export interface LinkProfileControllerProps {
  /** When false the tool is inert (no cursor change, no listeners fire visibly). */
  active: boolean;
  /** Candidate node endpoints — positioned nodes eligible for snapping. */
  points: LinkEndpoint[];
  /** Currently picked endpoints (0..2), owned by the parent (MapAnalysisContext). */
  endpoints: LinkEndpoint[];
  /** Called with the next endpoint array whenever a pick changes it. */
  onPick: (next: LinkEndpoint[]) => void;
  /** Called when the user presses Escape so the parent can flip `active` off. */
  onExit?: () => void;
  /**
   * Computed Link Profile verdict for the current endpoint pair (#4111 Phase
   * 3 WP-3), owned by the drawer via `MapAnalysisContext`. Colors the
   * connecting Polyline + endpoint rings via the shared `VERDICT_COLOR`;
   * falls back to amber while `null` (pending/no analysis yet).
   */
  verdict?: LinkVerdict | null;
}

/**
 * Two-point picker for the Terrain Link Profile tool (epic #4111 Phase 2).
 *
 * Clones `MeasureDistanceController`'s capture-phase click interception
 * (fires before marker/map click handlers so a click on a node doesn't open
 * its popup) but differs in two ways per the spec
 * (`docs/internal/dev-notes/LINK_PROFILE_TOOL_SPEC.md` §2.7):
 *
 *  - It is a **controlled** component: picked endpoints live in
 *    `MapAnalysisContext` (`linkEndpoints`), not local state, so the bottom
 *    drawer can read them too. Every pick is emitted via `onPick`.
 *  - A click that doesn't land within `SNAP_PX` screen pixels of the nearest
 *    candidate node still picks — as an arbitrary (non-node) endpoint at the
 *    raw clicked lat/lng. This lets the tool profile a link to/from a point
 *    that has no node, unlike the node-only Measure tool.
 *
 * First pick sets endpoint A, second sets B and draws the connecting line +
 * distance label, a third pick restarts from a new A. Escape (or the parent
 * toggling `active` off) clears the pair.
 */
const LinkProfileController: React.FC<LinkProfileControllerProps> = ({
  active,
  points,
  endpoints,
  onPick,
  onExit,
  verdict,
}) => {
  const { distanceUnit } = useSettings();
  const map = useMap();

  // Arbitrary (non-node) endpoints are always pickable, so the tool doesn't
  // need >=2 candidate nodes to function — the toolbar button gates that for
  // UX parity with Measure, but the controller itself only cares about
  // `active` (spec §2.7: "arbitrary points allowed even with 0 nodes").
  const enabled = active;

  // Keep the latest points/endpoints reachable from the (stable) click
  // listener without re-subscribing on every render that returns fresh arrays.
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;

  // Crosshair affordance while picking; always restore on cleanup.
  useEffect(() => {
    if (!enabled) return;
    const container = map.getContainer();
    const prev = container.style.cursor;
    container.style.cursor = 'crosshair';
    return () => {
      container.style.cursor = prev;
    };
  }, [enabled, map]);

  // Capture-phase click interception. Registered on the map container so it
  // fires before Leaflet's marker/map click handlers — letting a click land
  // on a node marker without opening its popup.
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
      const nearest = nearestPoint(pointsRef.current, latlng.lat, latlng.lng);

      let picked: LinkEndpoint | null = null;
      if (nearest) {
        const rect = container.getBoundingClientRect();
        const clickPx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const nearestPx = map.latLngToContainerPoint([nearest.lat, nearest.lng]);
        const distPx = Math.hypot(clickPx.x - nearestPx.x, clickPx.y - nearestPx.y);
        if (distPx < SNAP_PX) {
          picked = { ...nearest, isNode: true };
        }
      }
      if (!picked) {
        picked = { id: `pt-${latlng.lat},${latlng.lng}`, lat: latlng.lat, lng: latlng.lng, isNode: false };
      }

      const prev = endpointsRef.current;
      let next: LinkEndpoint[];
      if (prev.length === 0) {
        next = [picked];
      } else if (prev.length === 1) {
        // Ignore re-picking the same node as the first endpoint.
        if (prev[0].id === picked.id) return;
        next = [prev[0], picked];
      } else {
        next = [picked]; // completed pair -> restart from a new A
      }
      onPick(next);
    };
    container.addEventListener('click', onClick, true);
    return () => container.removeEventListener('click', onClick, true);
  }, [enabled, map, onPick]);

  // Escape clears / exits.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onPick([]);
      onExit?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onPick, onExit]);

  if (!enabled) return null;

  const [endpointA, endpointB] = endpoints;
  // Verdict-driven color (#4111 Phase 3 WP-3): amber while pending (no
  // resolved analysis yet), otherwise the shared clear/marginal/obstructed
  // color also used by the drawer's chart and stat pill.
  const verdictColor = verdict ? VERDICT_COLOR[verdict] : PENDING_COLOR;
  const ringStyle = (endpoint: LinkEndpoint) => ({
    color: verdictColor,
    weight: 3,
    fillColor: verdictColor,
    // Filled for a snapped node, hollow for an arbitrary map point — visually
    // distinguishes the two endpoint kinds (spec §2.7).
    fillOpacity: endpoint.isNode ? 0.6 : 0,
  });

  // Antimeridian fix (#4111 Phase 3 WP-3): unwrap endpoint B's longitude into
  // the same 360° window as endpoint A before building the Polyline so a
  // link crossing +/-180 draws the short way across the map instead of
  // wrapping the long way around. Only affects the drawn line's coordinates —
  // the endpoint CircleMarker and any API calls keep the true lng.
  const bLngUnwrapped =
    endpointA && endpointB ? endpointB.lng + 360 * Math.round((endpointA.lng - endpointB.lng) / 360) : undefined;

  return (
    <>
      {endpointA && (
        <CircleMarker center={[endpointA.lat, endpointA.lng]} radius={12} pathOptions={ringStyle(endpointA)} />
      )}
      {endpointB && (
        <CircleMarker center={[endpointB.lat, endpointB.lng]} radius={12} pathOptions={ringStyle(endpointB)} />
      )}
      {endpointA && endpointB && bLngUnwrapped !== undefined && (
        <Polyline
          positions={[
            [endpointA.lat, endpointA.lng],
            [endpointB.lat, bLngUnwrapped],
          ]}
          pathOptions={{ color: verdictColor, weight: 3 }}
        >
          <Tooltip permanent direction="center" className="link-profile-label">
            {measureLabel(endpointA, endpointB, distanceUnit)}
          </Tooltip>
        </Polyline>
      )}
    </>
  );
};

export default LinkProfileController;
