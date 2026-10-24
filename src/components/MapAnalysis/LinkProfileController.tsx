import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CircleMarker, Pane, Polyline, Tooltip, useMap } from 'react-leaflet';
import type L from 'leaflet';
import { useSettings } from '../../contexts/SettingsContext';
import { measureLabel } from '../../utils/measureDistance';
import { resolvePickedLatLng, resolvePickedPoint } from './mapClickPicker';
import { PICK_MOVE_TOLERANCE_PX, usePickGestureGuard } from './pickGestureGuard';
import type { LinkEndpoint, LinkVerdict } from '../../utils/linkProfile';
import { VERDICT_COLOR } from '../../utils/linkProfile';
import './LinkProfileController.css';

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
 *  - A click that doesn't land within `MAP_PICK_SNAP_PX` screen pixels of the nearest
 *    candidate node still picks — as an arbitrary (non-node) endpoint at the
 *    raw clicked lat/lng. This lets the tool profile a link to/from a point
 *    that has no node, unlike the node-only Measure tool.
 *
 * First pick sets endpoint A, second sets B and draws the connecting line +
 * distance label. Once both are set, further map clicks do nothing (#5959):
 * drag an endpoint to move it, or clear it from the drawer. Escape (or the
 * parent toggling `active` off) clears the pair.
 *
 * #5959: a click that ends a pan, pinch or box zoom, or one made while Space
 * is held (navigate only), never places a point (see pickGestureGuard).
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

  // Crosshair cursor, plus the pan/pinch/Space guard (#5959).
  const guardRef = usePickGestureGuard(map, enabled);

  // Endpoint being dragged (#5959): its index and the live position.
  const [drag, setDrag] = useState<{ index: number; lat: number; lng: number } | null>(null);
  // A press on an endpoint ring is followed by a click; it must not pick.
  const suppressClickRef = useRef(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const startDrag = useCallback(
    (index: number, down: PointerEvent) => {
      if (guardRef.current?.isNavigating()) return;
      if (down.pointerType === 'mouse' && down.button !== 0) return;
      suppressClickRef.current = true;
      map.dragging?.disable();
      const start = endpointsRef.current[index];
      if (!start) return;
      setDrag({ index, lat: start.lat, lng: start.lng });
      const pointerId = down.pointerId;

      const onMove = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        const ll = map.mouseEventToLatLng(e);
        setDrag({ index, lat: ll.lat, lng: ll.lng });
      };
      const finish = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', finish, true);
        document.removeEventListener('pointercancel', finish, true);
        map.dragging?.enable();
        setDrag(null);
        // The click that follows this release fires before this timer; clear
        // the flag after it so a release with no click cannot eat a later one.
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        // A cancelled pointer, or a release outside the map, leaves it put.
        if (e.type === 'pointercancel') return;
        if (!map.getContainer().contains(e.target as Node)) return;
        const current = endpointsRef.current;
        const moved = resolvePickedLatLng(map, map.mouseEventToLatLng(e), pointsRef.current) as LinkEndpoint;
        if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) <= PICK_MOVE_TOLERANCE_PX) return;
        const other = current[index === 0 ? 1 : 0];
        // Dropping onto the other endpoint's node would make a zero-length link.
        if (other && other.id === moved.id) return;
        const next = [...current];
        next[index] = moved;
        onPickRef.current(next);
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', finish, true);
      document.addEventListener('pointercancel', finish, true);
    },
    [map, guardRef],
  );

  // Native listeners straight on each endpoint ring. Leaflet's map drag sits
  // on the map pane, an ancestor of the ring, so it sees a press before any
  // Leaflet layer event would; stopping the press here keeps the map still
  // while the endpoint moves. (The same reason Leaflet's own marker drag
  // listens on the icon element.)
  const ringRefs = useRef<(L.CircleMarker | null)[]>([null, null]);
  const endpointCount = endpoints.length;
  useEffect(() => {
    if (!enabled) return;
    const cleanups: (() => void)[] = [];
    ringRefs.current.forEach((ring, index) => {
      const el = ring?.getElement() as HTMLElement | SVGElement | undefined;
      if (!el) return;
      const onDown = (e: Event) => {
        e.stopPropagation();
        startDrag(index, e as PointerEvent);
      };
      const stop = (e: Event) => e.stopPropagation();
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('mousedown', stop);
      el.addEventListener('touchstart', stop);
      cleanups.push(() => {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('mousedown', stop);
        el.removeEventListener('touchstart', stop);
      });
    });
    return () => cleanups.forEach((fn) => fn());
  }, [enabled, endpointCount, startDrag]);

  // Capture-phase click interception. Registered on the map container so it
  // fires before Leaflet's marker/map click handlers — letting a click land
  // on a node marker without opening its popup.
  useEffect(() => {
    if (!enabled) return;
    const container = map.getContainer();
    const onClick = (e: MouseEvent) => {
      // Shared with the Site Planner so both tools agree on what counts as
      // "on" a node (see mapClickPicker). Returns null for clicks on Leaflet
      // controls, which must keep working while a pick tool is active.
      const picked = resolvePickedPoint(map, e, pointsRef.current) as LinkEndpoint | null;
      if (!picked) return;
      if (suppressClickRef.current) {
        // The click that ends a press or drag on an endpoint ring.
        suppressClickRef.current = false;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      // The end of a pan, pinch or box zoom, or Space held: let the map have it.
      if (guardRef.current?.isGesture(e)) return;
      // Stop the marker popup / map click from also handling this event.
      e.stopPropagation();
      e.preventDefault();

      const prev = endpointsRef.current;
      let next: LinkEndpoint[];
      if (prev.length === 0) {
        next = [picked];
      } else if (prev.length === 1) {
        // Ignore re-picking the same node as the first endpoint.
        if (prev[0].id === picked.id) return;
        next = [prev[0], picked];
      } else {
        return; // pair complete: locked until an endpoint is cleared (#5959)
      }
      onPick(next);
    };
    container.addEventListener('click', onClick, true);
    return () => container.removeEventListener('click', onClick, true);
  }, [enabled, map, onPick, guardRef]);

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

  // While dragging, draw the endpoint at the pointer.
  const shown = endpoints.map((p, i) => (drag && drag.index === i ? { ...p, lat: drag.lat, lng: drag.lng } : p));
  const [endpointA, endpointB] = shown;
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
      {/* #5959: endpoints sit in their own pane, above node markers and other
          analysis layers (overlay 400, markers 600), so a press on a ring
          reaches it and drags the endpoint instead of the layer beneath. */}
      <Pane name="link-profile-endpoints" style={{ zIndex: 640 }}>
      {endpointA && (
        <CircleMarker
          center={[endpointA.lat, endpointA.lng]}
          radius={12}
          pathOptions={ringStyle(endpointA)}
          className="link-profile-endpoint"
          ref={(el) => {
            ringRefs.current[0] = el;
          }}
        />
      )}
      {endpointB && (
        <CircleMarker
          center={[endpointB.lat, endpointB.lng]}
          radius={12}
          pathOptions={ringStyle(endpointB)}
          className="link-profile-endpoint"
          ref={(el) => {
            ringRefs.current[1] = el;
          }}
        />
      )}
      </Pane>
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
