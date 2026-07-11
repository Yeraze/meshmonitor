/**
 * BBoxMapEditor — interactive rectangular bounding-box editor.
 *
 * Built for the mqtt_bridge filter's geographic bbox (issue #3003), which
 * is rectangular by definition. The auto-responder `GeofenceShape`
 * (circle / polygon) intentionally doesn't grow a bbox variant — it's a
 * different feature with different lifetime — so this component owns its
 * own data model: `{ minLat, maxLat, minLng, maxLng }`.
 *
 * UX:
 * - No bbox set: hint reads "click two corners to draw the bounding box".
 * - First click stores corner A and shows a marker.
 * - Mouse move draws a dashed preview rectangle from A to the cursor.
 * - Second click finalizes the bbox; the dashed rectangle becomes solid
 *   with 4 draggable corner handles.
 * - Dragging any corner resizes — the opposite corner stays put.
 * - The numeric inputs below the map (rendered by the parent) are
 *   two-way bound, so the user can also type precise values.
 * - "Clear" button removes the bbox entirely.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap, useMapEvents } from 'react-leaflet';
import { useTranslation } from 'react-i18next';
import { BaseMap } from './map/BaseMap';

export interface BBoxValue {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

interface BBoxMapEditorProps {
  /** The current bbox, or null when none is defined. */
  bbox: BBoxValue | null;
  /** Called whenever the bbox changes — either from user interaction on
   *  the map, or when the parent re-renders with a new prop value. */
  onChange: (bbox: BBoxValue | null) => void;
  /** Map height in CSS units. Default: 300px. */
  height?: string;
}

interface PendingCorner {
  lat: number;
  lng: number;
}

function normalize(a: L.LatLng, b: L.LatLng): BBoxValue {
  return {
    minLat: Math.min(a.lat, b.lat),
    maxLat: Math.max(a.lat, b.lat),
    minLng: Math.min(a.lng, b.lng),
    maxLng: Math.max(a.lng, b.lng),
  };
}

const Layer: React.FC<{
  bbox: BBoxValue | null;
  pending: PendingCorner | null;
  onPendingChange: (corner: PendingCorner | null) => void;
  onBBoxChange: (bbox: BBoxValue | null) => void;
}> = ({ bbox, pending, onPendingChange, onBBoxChange }) => {
  const map = useMap();
  const rectRef = useRef<L.Rectangle | null>(null);
  const cornerMarkersRef = useRef<L.Marker[]>([]);
  const pendingMarkerRef = useRef<L.Marker | null>(null);
  const previewRectRef = useRef<L.Rectangle | null>(null);
  const internalChangeRef = useRef(false);

  const cornerIcon = useMemo(
    () =>
      L.divIcon({
        className: 'bbox-corner-icon',
        html: '<div style="width:14px;height:14px;background:var(--ctp-blue,#89b4fa);border:2px solid white;border-radius:3px;cursor:move;box-shadow:0 0 4px rgba(0,0,0,0.4);"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
    [],
  );

  const pendingIcon = useMemo(
    () =>
      L.divIcon({
        className: 'bbox-pending-icon',
        html: '<div style="width:12px;height:12px;background:var(--ctp-yellow,#f9e2af);border:2px solid white;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,0.4);"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
    [],
  );

  const clearRect = useCallback(() => {
    if (rectRef.current) {
      map.removeLayer(rectRef.current);
      rectRef.current = null;
    }
    cornerMarkersRef.current.forEach((m) => map.removeLayer(m));
    cornerMarkersRef.current = [];
  }, [map]);

  const clearPending = useCallback(() => {
    if (pendingMarkerRef.current) {
      map.removeLayer(pendingMarkerRef.current);
      pendingMarkerRef.current = null;
    }
    if (previewRectRef.current) {
      map.removeLayer(previewRectRef.current);
      previewRectRef.current = null;
    }
  }, [map]);

  const renderRect = useCallback(
    (value: BBoxValue, fit: boolean) => {
      clearRect();
      const sw = L.latLng(value.minLat, value.minLng);
      const ne = L.latLng(value.maxLat, value.maxLng);
      const nw = L.latLng(value.maxLat, value.minLng);
      const se = L.latLng(value.minLat, value.maxLng);

      const rect = L.rectangle(L.latLngBounds(sw, ne), {
        color: 'var(--ctp-blue, #89b4fa)',
        fillColor: 'var(--ctp-blue, #89b4fa)',
        fillOpacity: 0.18,
        weight: 2,
      }).addTo(map);
      rectRef.current = rect;

      // Four draggable corner markers — SW, NW, NE, SE.
      // Each corner's drag updates the bbox such that the OPPOSITE corner stays
      // fixed (i.e. dragging SW updates minLat + minLng; NE stays put).
      const corners: Array<{ pos: L.LatLng; updateFromDrag: (p: L.LatLng) => BBoxValue }> = [
        {
          pos: sw,
          updateFromDrag: (p) => ({
            minLat: Math.min(p.lat, value.maxLat),
            maxLat: Math.max(p.lat, value.maxLat),
            minLng: Math.min(p.lng, value.maxLng),
            maxLng: Math.max(p.lng, value.maxLng),
          }),
        },
        {
          pos: nw,
          updateFromDrag: (p) => ({
            minLat: Math.min(p.lat, value.minLat),
            maxLat: Math.max(p.lat, value.minLat),
            minLng: Math.min(p.lng, value.maxLng),
            maxLng: Math.max(p.lng, value.maxLng),
          }),
        },
        {
          pos: ne,
          updateFromDrag: (p) => ({
            minLat: Math.min(p.lat, value.minLat),
            maxLat: Math.max(p.lat, value.minLat),
            minLng: Math.min(p.lng, value.minLng),
            maxLng: Math.max(p.lng, value.minLng),
          }),
        },
        {
          pos: se,
          updateFromDrag: (p) => ({
            minLat: Math.min(p.lat, value.maxLat),
            maxLat: Math.max(p.lat, value.maxLat),
            minLng: Math.min(p.lng, value.minLng),
            maxLng: Math.max(p.lng, value.minLng),
          }),
        },
      ];

      const markers: L.Marker[] = [];
      for (const c of corners) {
        const marker = L.marker(c.pos, { icon: cornerIcon, draggable: true }).addTo(map);
        marker.on('drag', () => {
          const next = c.updateFromDrag(marker.getLatLng());
          rect.setBounds(
            L.latLngBounds(L.latLng(next.minLat, next.minLng), L.latLng(next.maxLat, next.maxLng)),
          );
        });
        marker.on('dragend', () => {
          internalChangeRef.current = true;
          onBBoxChange(c.updateFromDrag(marker.getLatLng()));
        });
        markers.push(marker);
      }
      cornerMarkersRef.current = markers;

      if (fit) {
        map.fitBounds(rect.getBounds(), { padding: [24, 24], maxZoom: 12 });
      }
    },
    [map, cornerIcon, clearRect, onBBoxChange],
  );

  // Re-render the rectangle when the bbox prop changes. Skip when the
  // change originated from a corner drag (we just told the parent what
  // we drew; redrawing would fight the drag).
  useEffect(() => {
    if (internalChangeRef.current) {
      internalChangeRef.current = false;
      return;
    }
    if (bbox) {
      renderRect(bbox, true);
    } else {
      clearRect();
    }
  }, [bbox, renderRect, clearRect]);

  // Pending-corner preview while drawing
  useEffect(() => {
    if (!pending) {
      clearPending();
      return;
    }
    if (!pendingMarkerRef.current) {
      pendingMarkerRef.current = L.marker(L.latLng(pending.lat, pending.lng), {
        icon: pendingIcon,
        interactive: false,
      }).addTo(map);
    } else {
      pendingMarkerRef.current.setLatLng(L.latLng(pending.lat, pending.lng));
    }
  }, [pending, pendingIcon, map, clearPending]);

  useMapEvents({
    click: (e) => {
      // If a finalized bbox already exists, ignore map clicks — the user
      // should drag corners or use the Clear button.
      if (bbox) return;
      if (!pending) {
        onPendingChange({ lat: e.latlng.lat, lng: e.latlng.lng });
        return;
      }
      // Second click — finalize.
      const a = L.latLng(pending.lat, pending.lng);
      const b = e.latlng;
      // Reject zero-area rectangles (single double-click on same spot).
      if (a.equals(b)) return;
      const next = normalize(a, b);
      onPendingChange(null);
      onBBoxChange(next);
    },
    mousemove: (e) => {
      if (bbox || !pending) return;
      // Live preview rectangle from anchor to cursor
      const a = L.latLng(pending.lat, pending.lng);
      const next = normalize(a, e.latlng);
      const bounds = L.latLngBounds(
        L.latLng(next.minLat, next.minLng),
        L.latLng(next.maxLat, next.maxLng),
      );
      if (previewRectRef.current) {
        previewRectRef.current.setBounds(bounds);
      } else {
        previewRectRef.current = L.rectangle(bounds, {
          color: 'var(--ctp-yellow, #f9e2af)',
          fillColor: 'var(--ctp-yellow, #f9e2af)',
          fillOpacity: 0.1,
          weight: 2,
          dashArray: '5, 5',
        }).addTo(map);
      }
    },
  });

  useEffect(() => {
    return () => {
      clearRect();
      clearPending();
    };
  }, [clearRect, clearPending]);

  return null;
};

const BBoxMapEditor: React.FC<BBoxMapEditorProps> = ({ bbox, onChange, height = '300px' }) => {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingCorner | null>(null);

  // Map-default view: world view if no bbox, else fit. The child Layer
  // calls map.fitBounds itself when bbox arrives, so the initial view here
  // is fine as a fallback.
  const initialCenter = useMemo<[number, number]>(() => {
    if (bbox) return [(bbox.minLat + bbox.maxLat) / 2, (bbox.minLng + bbox.maxLng) / 2];
    return [30, 0];
  }, [bbox]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          height,
          border: '1px solid var(--ctp-surface2)',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      >
        <BaseMap center={initialCenter} zoom={bbox ? 5 : 2}>
          <Layer
            bbox={bbox}
            pending={pending}
            onPendingChange={setPending}
            onBBoxChange={(next) => {
              setPending(null);
              onChange(next);
            }}
          />
        </BaseMap>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 11,
          color: 'var(--ctp-subtext0)',
        }}
      >
        <span>
          {bbox
            ? t(
                'bbox.hint.drag_corners',
                'Drag any corner to resize, or edit the numeric values below.',
              )
            : pending
              ? t('bbox.hint.click_second', 'Now click the opposite corner to finalize.')
              : t('bbox.hint.click_first', 'Click two corners on the map to draw the bounding box.')}
        </span>
        {(bbox || pending) && (
          <button
            type="button"
            onClick={() => {
              setPending(null);
              onChange(null);
            }}
            style={{
              background: 'transparent',
              border: '1px solid var(--ctp-surface2)',
              color: 'var(--ctp-text)',
              padding: '2px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            {t('common.clear', 'Clear')}
          </button>
        )}
      </div>
    </div>
  );
};

export default BBoxMapEditor;
