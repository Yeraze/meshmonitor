/**
 * LocalMarkerPlacementBridge — while `placing`, the next map click picks the
 * spot for a new local marker (#5686).
 *
 * Reuses the `waypoint-placing` container class: it sets the crosshair cursor
 * and makes overlay geometry click-through so the pick always wins over a
 * feature popup (#4342, see WaypointEditorModal.css). No right-click handler:
 * right-click stays with the waypoint editor.
 */
import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import type { LeafletMouseEvent } from 'leaflet';

export default function LocalMarkerPlacementBridge({ placing, onPick }: {
  placing: boolean;
  onPick: (lat: number, lon: number) => void;
}) {
  const map = useMap();

  useEffect(() => {
    if (!placing) return;
    const container = map.getContainer();
    container.classList.add('waypoint-placing');
    map.closePopup();
    const handleClick = (e: LeafletMouseEvent) => onPick(e.latlng.lat, e.latlng.lng);
    map.on('click', handleClick);
    return () => {
      container.classList.remove('waypoint-placing');
      map.off('click', handleClick);
    };
  }, [placing, map, onPick]);

  return null;
}
