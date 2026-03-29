import React, { useEffect, useState, useCallback } from 'react';
import { GeoJSON } from 'react-leaflet';
import L from 'leaflet';
import type { GeoJsonLayer } from '../server/services/geojsonService.js';
import api from '../services/api';

interface GeoJsonOverlayProps {
  layers: GeoJsonLayer[];
}

type GeoJsonData = GeoJSON.GeoJsonObject;

const GeoJsonOverlay: React.FC<GeoJsonOverlayProps> = ({ layers }) => {
  const [dataCache, setDataCache] = useState<Record<string, GeoJsonData>>({});

  const fetchLayerData = useCallback(async (layer: GeoJsonLayer) => {
    try {
      const baseUrl = await api.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/geojson/layers/${layer.id}/data`);
      if (!response.ok) return;
      const data = await response.json();
      setDataCache(prev => ({ ...prev, [layer.id]: data }));
    } catch (err) {
      console.error(`Failed to fetch GeoJSON data for layer ${layer.id}:`, err);
    }
  }, []);

  useEffect(() => {
    layers.forEach(layer => {
      if (layer.visible && !dataCache[layer.id]) {
        fetchLayerData(layer);
      }
    });
  }, [layers, dataCache, fetchLayerData]);

  const getStyleForFeature = (layer: GeoJsonLayer, featureProps: Record<string, unknown> | null) => {
    const base = {
      color: (featureProps?.['stroke'] as string) ?? layer.style.color,
      weight: (featureProps?.['stroke-width'] as number) ?? layer.style.weight,
      opacity: (featureProps?.['stroke-opacity'] as number) ?? layer.style.opacity,
      fillColor: (featureProps?.['fill'] as string) ?? layer.style.color,
      fillOpacity: (featureProps?.['fill-opacity'] as number) ?? layer.style.fillOpacity,
    };
    return base;
  };

  const getMarkerColor = (layer: GeoJsonLayer, featureProps: Record<string, unknown> | null): string => {
    return (featureProps?.['marker-color'] as string) ?? layer.style.color;
  };

  const getMarkerRadius = (featureProps: Record<string, unknown> | null): number => {
    const size = featureProps?.['marker-size'] as string;
    if (size === 'large') return 10;
    if (size === 'small') return 4;
    return 6;
  };

  return (
    <>
      {layers.map(layer => {
        if (!layer.visible) return null;
        const data = dataCache[layer.id];
        if (!data) return null;

        return (
          <GeoJSON
            key={`${layer.id}-${layer.updatedAt}`}
            data={data}
            style={(feature) => {
              const props = (feature?.properties ?? null) as Record<string, unknown> | null;
              return getStyleForFeature(layer, props);
            }}
            pointToLayer={(feature, latlng) => {
              const props = (feature?.properties ?? null) as Record<string, unknown> | null;
              const color = getMarkerColor(layer, props);
              const radius = getMarkerRadius(props);
              return L.circleMarker(latlng, {
                radius,
                color,
                fillColor: color,
                fillOpacity: layer.style.fillOpacity,
                weight: layer.style.weight,
                opacity: layer.style.opacity,
              });
            }}
            onEachFeature={(feature, leafletLayer) => {
              const props = feature.properties ?? {};
              const title = (props['title'] ?? props['name']) as string | undefined;
              if (title) {
                leafletLayer.bindPopup(title);
                leafletLayer.bindTooltip(title, { permanent: false, sticky: true });
              }
            }}
          />
        );
      })}
    </>
  );
};

export default GeoJsonOverlay;
