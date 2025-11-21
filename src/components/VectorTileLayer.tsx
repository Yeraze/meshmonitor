import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import '@maplibre/maplibre-gl-leaflet';

// Extend Leaflet types to include MapLibre GL
declare module 'leaflet' {
  interface MaplibreGLOptions {
    style: unknown;
    attribution?: string;
  }
  function maplibreGL(options: MaplibreGLOptions): L.Layer;
}

interface VectorTileLayerProps {
  url: string;
  attribution?: string;
  maxZoom?: number;
}

/**
 * Vector tile layer component for rendering .pbf/.mvt tiles using MapLibre GL
 *
 * Uses MapLibre GL renderer wrapped as a Leaflet layer to display vector tiles.
 * Vector tiles are rendered client-side with a default style.
 */
export function VectorTileLayer({ url, attribution, maxZoom = 14 }: VectorTileLayerProps) {
  const map = useMap();

  useEffect(() => {
    if (!map) return;

    // Create MapLibre GL style object for vector tiles
    const style = {
      version: 8,
      sources: {
        'vector-tiles': {
          type: 'vector',
          tiles: [url],
          maxzoom: maxZoom
        }
      },
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: {
            'background-color': '#f8f8f8'
          }
        },
        {
          id: 'water',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'water',
          paint: {
            'fill-color': '#a0c8f0'
          }
        },
        {
          id: 'landuse',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'landuse',
          paint: {
            'fill-color': '#e8eddb'
          }
        },
        {
          id: 'landcover',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'landcover',
          paint: {
            'fill-color': '#d4e2c6',
            'fill-opacity': 0.5
          }
        },
        {
          id: 'park',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'park',
          paint: {
            'fill-color': '#c8e6b6'
          }
        },
        {
          id: 'building',
          type: 'fill',
          source: 'vector-tiles',
          'source-layer': 'building',
          paint: {
            'fill-color': '#d9d0c9',
            'fill-opacity': 0.7
          }
        },
        {
          id: 'road-casing',
          type: 'line',
          source: 'vector-tiles',
          'source-layer': 'transportation',
          paint: {
            'line-color': '#cfcdca',
            'line-width': {
              base: 1.4,
              stops: [
                [6, 0.5],
                [20, 10]
              ]
            }
          }
        },
        {
          id: 'road',
          type: 'line',
          source: 'vector-tiles',
          'source-layer': 'transportation',
          paint: {
            'line-color': '#ffffff',
            'line-width': {
              base: 1.4,
              stops: [
                [6, 0.3],
                [20, 8]
              ]
            }
          }
        },
        {
          id: 'boundary',
          type: 'line',
          source: 'vector-tiles',
          'source-layer': 'boundary',
          paint: {
            'line-color': '#9e9cab',
            'line-dasharray': [4, 2]
          }
        },
        {
          id: 'place-label',
          type: 'symbol',
          source: 'vector-tiles',
          'source-layer': 'place',
          layout: {
            'text-field': '{name}',
            'text-font': ['Open Sans Regular'],
            'text-size': {
              base: 1,
              stops: [
                [0, 10],
                [10, 14]
              ]
            }
          },
          paint: {
            'text-color': '#333',
            'text-halo-color': '#fff',
            'text-halo-width': 1
          }
        }
      ]
    };

    // Create MapLibre GL layer using Leaflet's extended API
    const vectorLayer = L.maplibreGL({
      style: style,
      attribution: attribution
    });

    // Add to map
    vectorLayer.addTo(map);

    // Cleanup on unmount
    return () => {
      map.removeLayer(vectorLayer);
    };
  }, [map, url, attribution, maxZoom]);

  return null;
}
