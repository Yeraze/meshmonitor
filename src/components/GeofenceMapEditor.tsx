import React, { useEffect, useState, useRef, useCallback, useMemo, useId } from 'react';
import L from 'leaflet';
import { useMap, useMapEvents } from 'react-leaflet';
import { useTranslation } from 'react-i18next';
import type { GeofenceShape } from './auto-responder/types';
import { BaseMap } from './map/BaseMap';
import mapFrame from './map/EmbeddedMapFrame.module.css';
import styles from './GeofenceMapEditor.module.css';
import { GEOFENCE_RADIUS_KM_MAX } from './automationInputLimits';
import { UiIcon } from './icons';
import {
  circleEdgePoint,
  clampRadiusMeters,
  DEFAULT_RADIUS_KM,
  GEOFENCE_FIELD_COMMIT_DELAY_MS,
  isInvalidRadius,
  isOutOfRange,
} from './geofenceEditorGeometry';

interface NodePosition {
  nodeNum: number;
  lat: number;
  lng: number;
  longName?: string;
}

interface GeofenceMapEditorProps {
  shape: GeofenceShape | null;
  onShapeChange: (shape: GeofenceShape) => void;
  shapeType: 'circle' | 'polygon';
  nodePositions?: NodePosition[];
}

type CircleShape = Extract<GeofenceShape, { type: 'circle' }>;
type CircleField = 'lat' | 'lng' | 'radius';

/** A non-empty field holding a number inside [min, max]. */
const isValidCoordinate = (value: string, min: number, max: number) =>
  value.trim() !== '' && !isOutOfRange(value, min, max);

interface CircleShapeData {
  center: { lat: number; lng: number };
  radiusKm: number;
}

interface PolygonShapeData {
  vertices: Array<{ lat: number; lng: number }>;
}

const MapDrawingLayer: React.FC<{
  shapeType: 'circle' | 'polygon';
  shape: GeofenceShape | null;
  onShapeChange: (shape: GeofenceShape) => void;
  nodePositions?: NodePosition[];
}> = ({ shapeType, shape, onShapeChange, nodePositions = [] }) => {
  const map = useMap();
  const circleRef = useRef<L.Circle | null>(null);
  const centerMarkerRef = useRef<L.Marker | null>(null);
  const radiusHandleRef = useRef<L.Marker | null>(null);
  const polygonRef = useRef<L.Polygon | null>(null);
  const vertexMarkersRef = useRef<L.Marker[]>([]);
  const nodeMarkersRef = useRef<L.CircleMarker[]>([]);
  const internalChangeRef = useRef(false);
  const [isDrawingPolygon, setIsDrawingPolygon] = useState(false);
  const [polygonVertices, setPolygonVertices] = useState<L.LatLng[]>([]);
  // Ref mirrors polygonVertices so Leaflet event handlers (which capture stale
  // closures) always see the latest vertices. Without this, the dblclick handler
  // sees the pre-double-click array and the >= 3 check fails. (#2474)
  const polygonVerticesRef = useRef<L.LatLng[]>([]);

  const centerIcon = useMemo(() => L.divIcon({
    className: 'custom-center-icon',
    html: '<div style="width: 12px; height: 12px; background: var(--color-accent); border: 2px solid white; border-radius: 50%; cursor: move;"></div>',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  }), []);

  const radiusIcon = useMemo(() => L.divIcon({
    className: 'custom-radius-icon',
    html: '<div style="width: 10px; height: 10px; background: var(--color-success); border: 2px solid white; border-radius: 50%; cursor: move;"></div>',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  }), []);

  const vertexIcon = useMemo(() => L.divIcon({
    className: 'custom-vertex-icon',
    html: '<div style="width: 14px; height: 14px; background: var(--color-accent-alt); border: 2px solid white; border-radius: 50%; cursor: move; box-shadow: 0 0 4px rgba(0,0,0,0.4);"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  }), []);

  const clearCircle = useCallback(() => {
    if (circleRef.current) {
      map.removeLayer(circleRef.current);
      circleRef.current = null;
    }
    if (centerMarkerRef.current) {
      map.removeLayer(centerMarkerRef.current);
      centerMarkerRef.current = null;
    }
    if (radiusHandleRef.current) {
      map.removeLayer(radiusHandleRef.current);
      radiusHandleRef.current = null;
    }
  }, [map]);

  const clearPolygon = useCallback(() => {
    if (polygonRef.current) {
      map.removeLayer(polygonRef.current);
      polygonRef.current = null;
    }
    vertexMarkersRef.current.forEach(marker => map.removeLayer(marker));
    vertexMarkersRef.current = [];
  }, [map]);

  const updateCircleShape = useCallback((center: L.LatLng, radiusMeters: number, isInternal = false) => {
    // A drag on the radius handle can't produce a radius the form would refuse.
    const radiusKm = clampRadiusMeters(radiusMeters) / 1000;
    if (isInternal) {
      internalChangeRef.current = true;
    }
    onShapeChange({
      type: 'circle',
      center: { lat: center.lat, lng: center.lng },
      radiusKm,
    });
  }, [onShapeChange]);

  const updatePolygonShape = useCallback((vertices: L.LatLng[], isInternal = false) => {
    if (vertices.length >= 3) {
      if (isInternal) {
        internalChangeRef.current = true;
      }
      onShapeChange({
        type: 'polygon',
        vertices: vertices.map(v => ({ lat: v.lat, lng: v.lng })),
      });
    }
  }, [onShapeChange]);

  const renderCircle = useCallback((circleData: CircleShapeData) => {
    clearCircle();

    const center = L.latLng(circleData.center.lat, circleData.center.lng);
    const radiusMeters = circleData.radiusKm * 1000;

    const circle = L.circle(center, {
      radius: radiusMeters,
      color: 'var(--color-accent)',
      fillColor: 'var(--color-accent)',
      fillOpacity: 0.2,
      weight: 2,
    }).addTo(map);
    circleRef.current = circle;

    const centerMarker = L.marker(center, {
      icon: centerIcon,
      draggable: true,
    }).addTo(map);

    // Every handler reads the circle's LIVE centre and radius. A drag commits
    // an internal shape change that skips the re-render below, so values
    // captured when the circle was drawn go stale after the first drag.
    centerMarker.on('drag', () => {
      const newCenter = centerMarker.getLatLng();
      circle.setLatLng(newCenter);
      radiusHandleRef.current?.setLatLng(circleEdgePoint(newCenter, circle.getRadius()));
    });

    centerMarker.on('dragend', () => {
      updateCircleShape(centerMarker.getLatLng(), circle.getRadius(), true);
    });

    centerMarkerRef.current = centerMarker;

    const radiusHandle = L.marker(circleEdgePoint(center, radiusMeters), {
      icon: radiusIcon,
      draggable: true,
    }).addTo(map);

    radiusHandle.on('drag', () => {
      circle.setRadius(clampRadiusMeters(circle.getLatLng().distanceTo(radiusHandle.getLatLng())));
    });

    radiusHandle.on('dragend', () => {
      const liveCenter = circle.getLatLng();
      const newRadius = clampRadiusMeters(liveCenter.distanceTo(radiusHandle.getLatLng()));
      circle.setRadius(newRadius);
      // Put the handle back on the edge: it may have been dropped past the cap.
      radiusHandle.setLatLng(circleEdgePoint(liveCenter, newRadius));
      updateCircleShape(liveCenter, newRadius, true);
    });

    radiusHandleRef.current = radiusHandle;

    map.fitBounds(circle.getBounds());
  }, [map, centerIcon, radiusIcon, clearCircle, updateCircleShape]);

  const renderPolygon = useCallback((polygonData: PolygonShapeData) => {
    clearPolygon();

    if (polygonData.vertices.length < 3) return;

    const latLngs = polygonData.vertices.map(c => L.latLng(c.lat, c.lng));

    const polygon = L.polygon(latLngs, {
      color: 'var(--color-accent-alt)',
      fillColor: 'var(--color-accent-alt)',
      fillOpacity: 0.2,
      weight: 2,
    }).addTo(map);
    polygonRef.current = polygon;

    const markers: L.Marker[] = [];
    latLngs.forEach((latLng, index) => {
      const marker = L.marker(latLng, {
        icon: vertexIcon,
        draggable: true,
      }).addTo(map);

      marker.on('drag', () => {
        // Read current positions from the polygon itself (not the captured array)
        const currentLatLngs = (polygon.getLatLngs()[0] as L.LatLng[]).slice();
        currentLatLngs[index] = marker.getLatLng();
        polygon.setLatLngs(currentLatLngs);
      });

      marker.on('dragend', () => {
        const newLatLngs = polygon.getLatLngs()[0] as L.LatLng[];
        updatePolygonShape(newLatLngs, true);
      });

      markers.push(marker);
    });

    vertexMarkersRef.current = markers;

    map.fitBounds(polygon.getBounds());
  }, [map, vertexIcon, clearPolygon, updatePolygonShape]);

  const renderNodePositions = useCallback(() => {
    nodeMarkersRef.current.forEach(marker => map.removeLayer(marker));
    nodeMarkersRef.current = [];

    nodePositions.forEach(node => {
      const marker = L.circleMarker([node.lat, node.lng], {
        radius: 4,
        color: '#888',
        fillColor: '#666',
        fillOpacity: 0.8,
        weight: 1,
      }).addTo(map);

      if (node.longName) {
        marker.bindTooltip(node.longName, { permanent: false, direction: 'top' });
      }

      nodeMarkersRef.current.push(marker);
    });
  }, [map, nodePositions]);

  // Disable double-click zoom when drawing polygons so the dblclick event
  // reaches our handler instead of being consumed by Leaflet's zoom
  useEffect(() => {
    if (shapeType === 'polygon') {
      map.doubleClickZoom.disable();
    } else {
      map.doubleClickZoom.enable();
    }
  }, [map, shapeType]);

  useMapEvents({
    click: (e) => {
      if (shapeType === 'circle' && !circleRef.current) {
        const defaultRadiusKm = DEFAULT_RADIUS_KM;
        renderCircle({
          center: { lat: e.latlng.lat, lng: e.latlng.lng },
          radiusKm: defaultRadiusKm,
        });
        updateCircleShape(e.latlng, defaultRadiusKm * 1000);
      } else if (shapeType === 'polygon') {
        // Auto-start drawing on first click, continue adding vertices
        if (!isDrawingPolygon) {
          setIsDrawingPolygon(true);
        }
        const newVertices = [...polygonVerticesRef.current, e.latlng];
        setPolygonVertices(newVertices);
        polygonVerticesRef.current = newVertices;

        // Update the shape progressively so the parent always has the latest
        // polygon — this also enables the save button as soon as 3+ vertices exist
        if (newVertices.length >= 3) {
          updatePolygonShape(newVertices, true);
        }
      }
    },
    dblclick: () => {
      // Finalize the polygon on double-click — use ref to avoid stale closure
      const currentVertices = polygonVerticesRef.current;
      if (shapeType === 'polygon' && isDrawingPolygon && currentVertices.length >= 3) {
        setIsDrawingPolygon(false);
        updatePolygonShape(currentVertices);
        setPolygonVertices([]);
        polygonVerticesRef.current = [];
      }
    },
  });

  useEffect(() => {
    renderNodePositions();
  }, [renderNodePositions]);

  useEffect(() => {
    // Skip re-rendering when the shape change originated from dragging markers
    if (internalChangeRef.current) {
      internalChangeRef.current = false;
      return;
    }

    if (shapeType === 'circle') {
      clearPolygon();
      setIsDrawingPolygon(false);
      setPolygonVertices([]);
      polygonVerticesRef.current = [];

      if (shape && shape.type === 'circle') {
        renderCircle(shape as CircleShapeData);
      }
    } else if (shapeType === 'polygon') {
      clearCircle();

      if (shape && shape.type === 'polygon') {
        renderPolygon({ vertices: shape.vertices });
      }
    }
  }, [shapeType, shape, renderCircle, renderPolygon, clearCircle, clearPolygon]);

  useEffect(() => {
    if (shapeType === 'polygon' && isDrawingPolygon) {
      if (polygonRef.current) {
        map.removeLayer(polygonRef.current);
      }

      if (polygonVertices.length >= 2) {
        const tempPolygon = L.polygon(polygonVertices, {
          color: 'var(--color-accent-alt)',
          fillColor: 'var(--color-accent-alt)',
          fillOpacity: 0.1,
          weight: 2,
          dashArray: '5, 5',
        }).addTo(map);
        polygonRef.current = tempPolygon;
      }
    }
  }, [map, shapeType, isDrawingPolygon, polygonVertices]);

  useEffect(() => {
    return () => {
      clearCircle();
      clearPolygon();
      nodeMarkersRef.current.forEach(marker => map.removeLayer(marker));
      nodeMarkersRef.current = [];
    };
  }, [map, clearCircle, clearPolygon]);

  return null;
};

const GeofenceMapEditor: React.FC<GeofenceMapEditorProps> = ({
  shape,
  onShapeChange,
  shapeType,
  nodePositions,
}) => {
  const { t } = useTranslation();
  const [centerLat, setCenterLat] = useState<string>('');
  const [centerLng, setCenterLng] = useState<string>('');
  const [radiusKm, setRadiusKm] = useState<string>('');

  // The debounced commit fires outside the render that scheduled it, so it
  // reads the latest draft text and shape from refs, not a stale closure.
  const draftRef = useRef<Record<CircleField, string>>({ lat: '', lng: '', radius: '' });
  const shapeRef = useRef<GeofenceShape | null>(shape);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setDraft = useCallback((field: CircleField, value: string) => {
    draftRef.current = { ...draftRef.current, [field]: value };
    if (field === 'lat') setCenterLat(value);
    else if (field === 'lng') setCenterLng(value);
    else setRadiusKm(value);
  }, []);

  const cancelPendingCommit = useCallback(() => {
    if (commitTimerRef.current !== null) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  }, []);

  useEffect(() => cancelPendingCommit, [cancelPendingCommit]);

  // The fields are a text draft. A shape this form emitted comes back as the
  // `shape` prop; reformatting the field from it on every keystroke turned
  // "1" into "1.000000", so typing "12" produced "1.0000002". Only a shape
  // change from somewhere else (the map, a trigger loaded for editing) or a
  // blur rewrites the text.
  const lastEmittedRef = useRef<GeofenceShape | null>(null);

  useEffect(() => {
    shapeRef.current = shape;
    if (shape !== null && shape === lastEmittedRef.current) return;
    // A change from elsewhere (a map drag) wins over a half-typed value.
    cancelPendingCommit();
    if (shape && shape.type === 'circle') {
      setDraft('lat', shape.center.lat.toFixed(6));
      setDraft('lng', shape.center.lng.toFixed(6));
      setDraft('radius', shape.radiusKm.toFixed(2));
    } else {
      setDraft('lat', '');
      setDraft('lng', '');
      setDraft('radius', '');
    }
  }, [shape, cancelPendingCommit, setDraft]);

  const emit = (next: GeofenceShape) => {
    lastEmittedRef.current = next;
    shapeRef.current = next;
    onShapeChange(next);
  };

  /**
   * Apply the typed values to the circle. Typing only edits the draft; this
   * runs on blur, on Enter, or after GEOFENCE_FIELD_COMMIT_DELAY_MS without a
   * keystroke, so the prefixes of a value ("1", "12" on the way to "123")
   * never move the map. An invalid or empty field keeps the circle's current
   * value. With no circle yet, one is created once lat and lng are valid,
   * defaulting an empty radius to DEFAULT_RADIUS_KM like a map click.
   * Returns the circle after the commit, or null when there is none.
   */
  const commitDraft = (): CircleShape | null => {
    cancelPendingCommit();
    const { lat: latText, lng: lngText, radius: radiusText } = draftRef.current;
    const current = shapeRef.current;
    const circle = current?.type === 'circle' ? current : null;

    if (!circle) {
      if (!isValidCoordinate(latText, -90, 90) || !isValidCoordinate(lngText, -180, 180)) return null;
      const radiusEmpty = radiusText.trim() === '';
      if (!radiusEmpty && isInvalidRadius(radiusText)) return null;
      const radius = radiusEmpty ? DEFAULT_RADIUS_KM : parseFloat(radiusText);
      if (radiusEmpty) setDraft('radius', DEFAULT_RADIUS_KM.toFixed(2));
      const created: CircleShape = {
        type: 'circle',
        center: { lat: parseFloat(latText), lng: parseFloat(lngText) },
        radiusKm: Math.min(GEOFENCE_RADIUS_KM_MAX, radius),
      };
      emit(created);
      return created;
    }

    const next: CircleShape = {
      type: 'circle',
      center: {
        lat: isValidCoordinate(latText, -90, 90) ? parseFloat(latText) : circle.center.lat,
        lng: isValidCoordinate(lngText, -180, 180) ? parseFloat(lngText) : circle.center.lng,
      },
      // Radius above the max is clamped rather than refused.
      radiusKm: radiusText.trim() !== '' && !isInvalidRadius(radiusText)
        ? Math.min(GEOFENCE_RADIUS_KM_MAX, parseFloat(radiusText))
        : circle.radiusKm,
    };
    if (
      next.center.lat === circle.center.lat
      && next.center.lng === circle.center.lng
      && next.radiusKm === circle.radiusKm
    ) {
      return circle;
    }
    emit(next);
    return next;
  };

  // Validation stays instant (it reads the draft); only the commit waits.
  const handleFieldChange = (field: CircleField, value: string) => {
    setDraft(field, value);
    cancelPendingCommit();
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      commitDraft();
    }, GEOFENCE_FIELD_COMMIT_DELAY_MS);
  };

  /**
   * Blur or Enter: commit now, then reformat the field. A valid field shows the
   * circle's value (so a clamped radius shows the cap). With no circle yet it
   * shows its own number, formatted the same way, so the result never depends
   * on whether a circle existed when the field was left. An invalid or empty
   * field keeps its text and its error.
   */
  const handleFieldCommit = (field: CircleField) => {
    const committed = commitDraft();
    const text = draftRef.current[field];
    if (text.trim() === '') return;
    if (field === 'radius') {
      if (isInvalidRadius(text)) return;
      const value = committed ? committed.radiusKm : Math.min(GEOFENCE_RADIUS_KM_MAX, parseFloat(text));
      setDraft('radius', value.toFixed(2));
      return;
    }
    const [min, max] = field === 'lat' ? [-90, 90] : [-180, 180];
    if (!isValidCoordinate(text, min, max)) return;
    const value = committed ? committed.center[field] : parseFloat(text);
    setDraft(field, value.toFixed(6));
  };

  const handleFieldKeyDown = (field: CircleField) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    // Enter applies the value here; it must not also submit an enclosing form.
    e.preventDefault();
    handleFieldCommit(field);
  };

  // #5649: these three fields stay raw number inputs, not `NumberInput`.
  // They already hold a text draft (so they can be cleared and retyped), mark
  // bad text with aria-invalid plus a visible reason, and never emit an invalid
  // value. What `NumberInput` cannot carry is the rest of their contract: the
  // fixed-width text they show ("10.500000", "7.00"), a blank that means "keep
  // the circle's value", the debounced commit that keeps "1", "12" on the way
  // to "123" off the map, and a radius past the cap that is clamped on commit
  // rather than refused. Listed as the one exception to no-raw-number-input.
  const blurOnWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    // A focused number input changes value on wheel while the page scrolls.
    if (document.activeElement === e.currentTarget) e.currentTarget.blur();
  };

  // An out-of-range coordinate never reaches the shape, so the map keeps the
  // last valid centre. Say so next to the field instead of failing silently.
  const latInvalid = isOutOfRange(centerLat, -90, 90);
  const lngInvalid = isOutOfRange(centerLng, -180, 180);
  const radiusInvalid = isInvalidRadius(radiusKm);
  const fieldId = useId();
  const latId = `${fieldId}-lat`;
  const lngId = `${fieldId}-lng`;
  const radiusId = `${fieldId}-radius`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div
        className={mapFrame.frame}
        data-testid="geofence-map-frame"
        style={{ height: '400px', border: '1px solid var(--color-surface-active)', borderRadius: '8px', overflow: 'hidden' }}
      >
        <BaseMap center={[30, 0]} zoom={3}>
          <MapDrawingLayer
            shapeType={shapeType}
            shape={shape}
            onShapeChange={onShapeChange}
            nodePositions={nodePositions}
          />
        </BaseMap>
      </div>

      {shapeType === 'circle' && (
        <div className={styles.circleFields} data-testid="geofence-circle-fields">
          <div className={styles.field}>
            <label htmlFor={latId} className={styles.fieldLabel}>
              {t('automation.geofence_triggers.center_lat')}
            </label>
            <input
              id={latId}
              type="number"
              step="0.000001"
              min="-90"
              max="90"
              value={centerLat}
              onChange={(e) => handleFieldChange('lat', e.target.value)}
              onBlur={() => handleFieldCommit('lat')}
              onKeyDown={handleFieldKeyDown('lat')}
              onWheel={blurOnWheel}
              className={latInvalid ? `${styles.fieldInput} ${styles.fieldInputInvalid}` : styles.fieldInput}
              aria-invalid={latInvalid || undefined}
              aria-describedby={latInvalid ? `${latId}-error` : undefined}
              placeholder="0.000000"
            />
            {latInvalid && (
              <div id={`${latId}-error`} className={styles.fieldError} role="alert">
                <UiIcon name="alert" size={14} className={styles.fieldErrorIcon} />
                <span>{t('automation.geofence_triggers.lat_out_of_range', 'Latitude must be between -90 and 90. The map keeps the last valid value.')}</span>
              </div>
            )}
          </div>

          <div className={styles.field}>
            <label htmlFor={lngId} className={styles.fieldLabel}>
              {t('automation.geofence_triggers.center_lng')}
            </label>
            <input
              id={lngId}
              type="number"
              step="0.000001"
              min="-180"
              max="180"
              value={centerLng}
              onChange={(e) => handleFieldChange('lng', e.target.value)}
              onBlur={() => handleFieldCommit('lng')}
              onKeyDown={handleFieldKeyDown('lng')}
              onWheel={blurOnWheel}
              className={lngInvalid ? `${styles.fieldInput} ${styles.fieldInputInvalid}` : styles.fieldInput}
              aria-invalid={lngInvalid || undefined}
              aria-describedby={lngInvalid ? `${lngId}-error` : undefined}
              placeholder="0.000000"
            />
            {lngInvalid && (
              <div id={`${lngId}-error`} className={styles.fieldError} role="alert">
                <UiIcon name="alert" size={14} className={styles.fieldErrorIcon} />
                <span>{t('automation.geofence_triggers.lng_out_of_range', 'Longitude must be between -180 and 180. The map keeps the last valid value.')}</span>
              </div>
            )}
          </div>

          <div className={styles.field}>
            <label htmlFor={radiusId} className={styles.fieldLabel}>
              {t('automation.geofence_triggers.radius_km')}
            </label>
            <input
              id={radiusId}
              type="number"
              step="0.01"
              min="0.01"
              max={GEOFENCE_RADIUS_KM_MAX}
              value={radiusKm}
              onChange={(e) => handleFieldChange('radius', e.target.value)}
              onBlur={() => handleFieldCommit('radius')}
              onKeyDown={handleFieldKeyDown('radius')}
              onWheel={blurOnWheel}
              className={radiusInvalid ? `${styles.fieldInput} ${styles.fieldInputInvalid}` : styles.fieldInput}
              aria-invalid={radiusInvalid || undefined}
              aria-describedby={radiusInvalid ? `${radiusId}-error` : undefined}
              placeholder="10.00"
            />
            {radiusInvalid && (
              <div id={`${radiusId}-error`} className={styles.fieldError} role="alert">
                <UiIcon name="alert" size={14} className={styles.fieldErrorIcon} />
                <span>{t('automation.geofence_triggers.radius_invalid', 'Radius must be greater than 0. The map keeps the last valid value.')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {shapeType === 'polygon' && shape?.type === 'polygon' && (
        <div
          style={{
            padding: '12px',
            background: 'var(--color-surface)',
            borderRadius: '8px',
          }}
        >
          <div style={{ fontSize: '14px', color: 'var(--color-text)' }}>
            {t('automation.geofence_triggers.vertices_count')}: {shape.vertices.length}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-subtle)', marginTop: '4px' }}>
            {t('automation.geofence_triggers.click_to_add_vertex')}
          </div>
        </div>
      )}

      {shapeType === 'polygon' && !shape && (
        <div
          style={{
            padding: '12px',
            background: 'var(--color-surface)',
            borderRadius: '8px',
            fontSize: '12px',
            color: 'var(--color-text-subtle)',
          }}
        >
          {t('automation.geofence_triggers.click_map_to_start')}
        </div>
      )}
    </div>
  );
};

export default GeofenceMapEditor;
