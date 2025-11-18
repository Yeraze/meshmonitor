import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import * as L from 'leaflet';
import { PMTiles, Protocol, TileType } from 'pmtiles';

interface PMTilesLayerProps {
  url: string;
  attribution: string;
  maxZoom?: number;
}

// Global protocol instance (shared across all PMTiles layers)
let globalProtocol: Protocol | null = null;

/**
 * PMTiles Layer Component for Leaflet
 *
 * This component integrates PMTiles with react-leaflet, allowing
 * for efficient loading of locally hosted map tiles without requiring
 * a tile server.
 *
 * PMTiles uses HTTP range requests to fetch only the tiles needed,
 * making it ideal for offline or low-bandwidth scenarios.
 */
export function PMTilesLayer({ url, attribution, maxZoom = 14 }: PMTilesLayerProps) {
  const map = useMap();
  const layerRef = useRef<L.TileLayer | null>(null);
  const pmtilesRef = useRef<PMTiles | null>(null);

  useEffect(() => {
    if (!map) return;

    // Initialize global protocol instance (only once)
    if (!globalProtocol) {
      globalProtocol = new Protocol();
    }

    // Create PMTiles instance for this archive
    const pmtiles = new PMTiles(url);
    pmtilesRef.current = pmtiles;

    // Add this PMTiles instance to the global protocol
    globalProtocol.add(pmtiles);

    // Get tile type and set up the layer
    pmtiles.getHeader().then((header) => {
      const tileType = header.tileType;
      let tileUrl: string;

      // Determine the tile URL template based on tile type
      if (tileType === TileType.Png) {
        tileUrl = `pmtiles://${url}/{z}/{x}/{y}.png`;
      } else if (tileType === TileType.Jpeg) {
        tileUrl = `pmtiles://${url}/{z}/{x}/{y}.jpg`;
      } else if (tileType === TileType.Webp) {
        tileUrl = `pmtiles://${url}/{z}/{x}/{y}.webp`;
      } else {
        // Default to MVT (Mapbox Vector Tiles)
        tileUrl = `pmtiles://${url}/{z}/{x}/{y}.mvt`;
      }

      // Create the tile layer
      const tileLayer = L.tileLayer(tileUrl, {
        attribution,
        maxZoom,
        tileSize: 256,
      });

      // Override getTileUrl to use PMTiles protocol
      const originalGetTileUrl = tileLayer.getTileUrl.bind(tileLayer);
      tileLayer.getTileUrl = function (coords: L.Coords) {
        const originalUrl = originalGetTileUrl(coords);
        // The protocol handler will intercept pmtiles:// URLs
        return originalUrl;
      };

      // Add layer to map
      tileLayer.addTo(map);
      layerRef.current = tileLayer;
    }).catch((error) => {
      console.error('Failed to load PMTiles header:', error);
    });

    // Cleanup function
    return () => {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
      if (pmtilesRef.current && globalProtocol) {
        // Note: PMTiles Protocol doesn't have a remove method in current version
        // The protocol will be cleaned up when the page reloads
        pmtilesRef.current = null;
      }
    };
  }, [map, url, attribution, maxZoom]);

  return null;
}
