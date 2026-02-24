import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { useTranslation } from 'react-i18next';
import type { GeofenceShape } from './auto-responder/types';

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

  const centerIcon = useMemo(() => L.divIcon({
    className: 'custom-center-icon',
    html: '<div style="width: 12px; height: 12px; background: var(--ctp-blue); border: 2px solid white; border-radius: 50%; cursor: move;"></div>',
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  }), []);

  const radiusIcon = useMemo(() => L.divIcon({
    className: 'custom-radius-icon',
    html: '<div style="width: 10px; height: 10px; background: var(--ctp-green); border: 2px solid white; border-radius: 50%; cursor: move;"></div>',
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  }), []);

  const vertexIcon = useMemo(() => L.divIcon({
    className: 'custom-vertex-icon',
    html: '<div style="width: 14px; height: 14px; background: var(--ctp-mauve); border: 2px solid white; border-radius: 50%; cursor: move; box-shadow: 0 0 4px rgba(0,0,0,0.4);"></div>',
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
    const radiusKm = radiusMeters / 1000;
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
      color: 'var(--ctp-blue)',
      fillColor: 'var(--ctp-blue)',
      fillOpacity: 0.2,
      weight: 2,
    }).addTo(map);
    circleRef.current = circle;

    const centerMarker = L.marker(center, {
      icon: centerIcon,
      draggable: true,
    }).addTo(map);

    centerMarker.on('drag', () => {
      const newCenter = centerMarker.getLatLng();
      circle.setLatLng(newCenter);

      if (radiusHandleRef.current) {
        const radiusPoint = L.latLng(newCenter.lat, newCenter.lng + (radiusMeters / 111320));
        radiusHandleRef.current.setLatLng(radiusPoint);
      }
    });

    centerMarker.on('dragend', () => {
      updateCircleShape(centerMarker.getLatLng(), radiusMeters, true);
    });

    centerMarkerRef.current = centerMarker;

    const radiusPoint = L.latLng(center.lat, center.lng + (radiusMeters / 111320));
    const radiusHandle = L.marker(radiusPoint, {
      icon: radiusIcon,
      draggable: true,
    }).addTo(map);

    radiusHandle.on('drag', () => {
      const handlePos = radiusHandle.getLatLng();
      const newRadius = center.distanceTo(handlePos);
      circle.setRadius(newRadius);
    });

    radiusHandle.on('dragend', () => {
      const handlePos = radiusHandle.getLatLng();
      const newRadius = center.distanceTo(handlePos);
      updateCircleShape(center, newRadius, true);
    });

    radiusHandleRef.current = radiusHandle;

    map.fitBounds(circle.getBounds());
  }, [map, centerIcon, radiusIcon, clearCircle, updateCircleShape]);

  const renderPolygon = useCallback((polygonData: PolygonShapeData) => {
    clearPolygon();

    if (polygonData.vertices.length < 3) return;

    const latLngs = polygonData.vertices.map(c => L.latLng(c.lat, c.lng));

    const polygon = L.polygon(latLngs, {
      color: 'var(--ctp-mauve)',
      fillColor: 'var(--ctp-mauve)',
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

  useMapEvents({
    click: (e) => {
      if (shapeType === 'circle' && !circleRef.current) {
        const defaultRadiusKm = 10;
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
        const newVertices = [...polygonVertices, e.latlng];
        setPolygonVertices(newVertices);
      }
    },
    dblclick: () => {
      if (shapeType === 'polygon' && isDrawingPolygon && polygonVertices.length >= 3) {
        setIsDrawingPolygon(false);
        updatePolygonShape(polygonVertices);
        setPolygonVertices([]);
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
          color: 'var(--ctp-mauve)',
          fillColor: 'var(--ctp-mauve)',
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

  useEffect(() => {
    if (shape && shape.type === 'circle') {
      setCenterLat(shape.center.lat.toFixed(6));
      setCenterLng(shape.center.lng.toFixed(6));
      setRadiusKm(shape.radiusKm.toFixed(2));
    } else {
      setCenterLat('');
      setCenterLng('');
      setRadiusKm('');
    }
  }, [shape]);

  const handleCenterLatChange = (value: string) => {
    setCenterLat(value);
    const lat = parseFloat(value);
    if (!isNaN(lat) && lat >= -90 && lat <= 90 && shape?.type === 'circle') {
      onShapeChange({
        ...shape,
        center: { ...shape.center, lat },
      });
    }
  };

  const handleCenterLngChange = (value: string) => {
    setCenterLng(value);
    const lng = parseFloat(value);
    if (!isNaN(lng) && lng >= -180 && lng <= 180 && shape?.type === 'circle') {
      onShapeChange({
        ...shape,
        center: { ...shape.center, lng },
      });
    }
  };

  const handleRadiusChange = (value: string) => {
    setRadiusKm(value);
    const radius = parseFloat(value);
    if (!isNaN(radius) && radius > 0 && shape?.type === 'circle') {
      onShapeChange({
        ...shape,
        radiusKm: radius,
      });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ height: '400px', border: '1px solid var(--ctp-surface2)', borderRadius: '8px', overflow: 'hidden' }}>
        <MapContainer
          center={[30, 0]}
          zoom={3}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapDrawingLayer
            shapeType={shapeType}
            shape={shape}
            onShapeChange={onShapeChange}
            nodePositions={nodePositions}
          />
        </MapContainer>
      </div>

      {shapeType === 'circle' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: '8px',
            padding: '12px',
            background: 'var(--ctp-surface0)',
            borderRadius: '8px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
              {t('automation.geofence_triggers.center_lat')}
            </label>
            <input
              type="number"
              step="0.000001"
              min="-90"
              max="90"
              value={centerLat}
              onChange={(e) => handleCenterLatChange(e.target.value)}
              style={{
                padding: '6px 8px',
                background: 'var(--ctp-base)',
                border: '1px solid var(--ctp-surface2)',
                borderRadius: '4px',
                color: 'var(--ctp-text)',
                fontSize: '14px',
              }}
              placeholder="0.000000"
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
              {t('automation.geofence_triggers.center_lng')}
            </label>
            <input
              type="number"
              step="0.000001"
              min="-180"
              max="180"
              value={centerLng}
              onChange={(e) => handleCenterLngChange(e.target.value)}
              style={{
                padding: '6px 8px',
                background: 'var(--ctp-base)',
                border: '1px solid var(--ctp-surface2)',
                borderRadius: '4px',
                color: 'var(--ctp-text)',
                fontSize: '14px',
              }}
              placeholder="0.000000"
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--ctp-subtext0)' }}>
              {t('automation.geofence_triggers.radius_km')}
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={radiusKm}
              onChange={(e) => handleRadiusChange(e.target.value)}
              style={{
                padding: '6px 8px',
                background: 'var(--ctp-base)',
                border: '1px solid var(--ctp-surface2)',
                borderRadius: '4px',
                color: 'var(--ctp-text)',
                fontSize: '14px',
              }}
              placeholder="10.00"
            />
          </div>
        </div>
      )}

      {shapeType === 'polygon' && shape?.type === 'polygon' && (
        <div
          style={{
            padding: '12px',
            background: 'var(--ctp-surface0)',
            borderRadius: '8px',
          }}
        >
          <div style={{ fontSize: '14px', color: 'var(--ctp-text)' }}>
            {t('automation.geofence_triggers.vertices_count')}: {shape.vertices.length}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--ctp-subtext0)', marginTop: '4px' }}>
            {t('automation.geofence_triggers.click_to_add_vertex')}
          </div>
        </div>
      )}

      {shapeType === 'polygon' && !shape && (
        <div
          style={{
            padding: '12px',
            background: 'var(--ctp-surface0)',
            borderRadius: '8px',
            fontSize: '12px',
            color: 'var(--ctp-subtext0)',
          }}
        >
          {t('automation.geofence_triggers.click_map_to_start')}
        </div>
      )}
    </div>
  );
};

export default GeofenceMapEditor;
