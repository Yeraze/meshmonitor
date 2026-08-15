/**
 * Origin picker for the Site Planner (#4727).
 *
 * Maintainer decision: the prediction origin may be an existing node OR an
 * arbitrary clicked point — siting a repeater is the main use, and that means
 * asking about places where no node exists yet.
 *
 * Shares `resolvePickedPoint` with the Terrain Link Profile tool so both agree
 * on what counts as clicking "on" a node. This differs from that tool in
 * taking exactly ONE point: each click replaces the origin rather than
 * building a pair.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { resolvePickedPoint, type PickCandidate } from './mapClickPicker';

export interface SitePlannerOrigin extends PickCandidate {
  isNode: boolean;
  name?: string;
}

export interface SitePlannerOriginControllerProps {
  active: boolean;
  /** Positioned nodes eligible for snapping. */
  points: PickCandidate[];
  origin: SitePlannerOrigin | null;
  onPick: (origin: SitePlannerOrigin) => void;
  onExit?: () => void;
}

export default function SitePlannerOriginController({
  active,
  points,
  origin,
  onPick,
  onExit,
}: SitePlannerOriginControllerProps) {
  const map = useMap();
  const { t } = useTranslation();

  // Keep the latest candidates reachable from the stable click handler without
  // re-registering the listener on every render.
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    if (!active) return;
    const container = map.getContainer();
    const prev = container.style.cursor;
    container.style.cursor = 'crosshair';
    return () => { container.style.cursor = prev; };
  }, [active, map]);

  useEffect(() => {
    if (!active) return;
    const container = map.getContainer();
    const onClick = (e: MouseEvent) => {
      const picked = resolvePickedPoint(map, e, pointsRef.current);
      if (!picked) return; // a Leaflet control — leave it alone
      // Suppress the marker popup / map click that would otherwise follow.
      e.stopPropagation();
      e.preventDefault();
      onPickRef.current(picked as SitePlannerOrigin);
    };
    container.addEventListener('click', onClick, true);
    return () => container.removeEventListener('click', onClick, true);
  }, [active, map]);

  useEffect(() => {
    if (!active || !onExit) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onExit(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onExit]);

  if (!active || !origin) return null;

  return (
    <CircleMarker
      center={[origin.lat, origin.lng]}
      radius={7}
      // Filled for a snapped node, hollow for a bare coordinate — the same
      // visual grammar the Link Profile tool uses for the same distinction.
      pathOptions={{
        color: '#7b61ff',
        weight: 2,
        fillColor: '#7b61ff',
        fillOpacity: origin.isNode ? 0.9 : 0,
      }}
      className="site-planner-origin"
    >
      <Tooltip permanent direction="top" offset={[0, -8]}>
        {origin.isNode ? (origin.name ?? t('site_planner.transmitter')) : t('site_planner.proposed_site')}
      </Tooltip>
    </CircleMarker>
  );
}
