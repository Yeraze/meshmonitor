import React, { useMemo, useState, useEffect } from 'react';
import { Circle, Polyline, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useSettings } from '../contexts/SettingsContext.js';
import { getOverlayColors, getSchemeForTileset } from '../config/overlayColors.js';
import { getPolarGridRings, getSectorEndpoint } from '../utils/polarGrid.js';

interface PolarGridOverlayProps {
  center: { lat: number; lng: number };
}

const SECTOR_BEARINGS = Array.from({ length: 12 }, (_, i) => i * 30);
const CARDINAL_BEARINGS = new Set([0, 90, 180, 270]);
const DEGREE_LABELS = ['0', '30', '60', '90', '120', '150', '180', '210', '240', '270', '300', '330'];

export const PolarGridOverlay: React.FC<PolarGridOverlayProps> = ({ center }) => {
  const map = useMap();
  const { distanceUnit, selectedTileset, customOverlayScheme } = useSettings();
  const [zoom, setZoom] = useState(map.getZoom());

  useEffect(() => {
    const onZoomEnd = () => setZoom(map.getZoom());
    map.on('zoomend', onZoomEnd);
    return () => { map.off('zoomend', onZoomEnd); };
  }, [map]);

  const scheme = getSchemeForTileset(selectedTileset || 'osm', customOverlayScheme);
  const colors = getOverlayColors(scheme);
  const centerLatLng: [number, number] = [center.lat, center.lng];

  const rings = useMemo(
    () => getPolarGridRings(zoom, distanceUnit),
    [zoom, distanceUnit]
  );

  const outerRadius = rings.length > 0 ? rings[rings.length - 1].radiusMeters : 0;

  const sectorLines = useMemo(() => {
    if (outerRadius === 0) return [];
    return SECTOR_BEARINGS.map((bearing) => {
      const endpoint = getSectorEndpoint(center, bearing, outerRadius);
      return {
        bearing,
        positions: [centerLatLng, [endpoint.lat, endpoint.lng] as [number, number]],
        isCardinal: CARDINAL_BEARINGS.has(bearing),
      };
    });
  }, [center.lat, center.lng, outerRadius]);

  const distanceLabels = useMemo(() => {
    return rings.map((ring) => {
      const pos = getSectorEndpoint(center, 0, ring.radiusMeters);
      return {
        position: [pos.lat, pos.lng] as [number, number],
        label: ring.label,
      };
    });
  }, [center.lat, center.lng, rings]);

  const degreeLabels = useMemo(() => {
    if (outerRadius === 0) return [];
    return SECTOR_BEARINGS.map((bearing, i) => {
      const pos = getSectorEndpoint(center, bearing, outerRadius * 1.08);
      return {
        position: [pos.lat, pos.lng] as [number, number],
        label: DEGREE_LABELS[i] + '\u00B0',
      };
    });
  }, [center.lat, center.lng, outerRadius]);

  return (
    <>
      {rings.map((ring) => (
        <Circle
          key={`polar-ring-${ring.radiusMeters}`}
          center={centerLatLng}
          radius={ring.radiusMeters}
          pathOptions={{
            color: colors.polarGrid.rings,
            weight: 1,
            fill: false,
            interactive: false,
          }}
        />
      ))}

      {sectorLines.map((sector) => (
        <Polyline
          key={`polar-sector-${sector.bearing}`}
          positions={sector.positions}
          pathOptions={{
            color: sector.isCardinal
              ? colors.polarGrid.cardinalSectors
              : colors.polarGrid.sectors,
            weight: 1,
            dashArray: sector.isCardinal ? undefined : '4 4',
            interactive: false,
          }}
        />
      ))}

      {distanceLabels.map((item) => (
        <Marker
          key={`polar-dist-${item.label}`}
          position={item.position}
          interactive={false}
          icon={L.divIcon({
            className: 'polar-grid-label',
            html: `<span style="color:${colors.polarGrid.labels};font-size:11px;font-family:monospace;white-space:nowrap;text-shadow:0 0 3px rgba(0,0,0,0.7)">${item.label}</span>`,
            iconSize: [0, 0],
            iconAnchor: [-4, 6],
          })}
        />
      ))}

      {degreeLabels.map((item) => (
        <Marker
          key={`polar-deg-${item.label}`}
          position={item.position}
          interactive={false}
          icon={L.divIcon({
            className: 'polar-grid-label',
            html: `<span style="color:${colors.polarGrid.labels};font-size:10px;font-family:monospace;white-space:nowrap;text-shadow:0 0 3px rgba(0,0,0,0.7)">${item.label}</span>`,
            iconSize: [0, 0],
            iconAnchor: [8, 8],
          })}
        />
      ))}
    </>
  );
};

export default PolarGridOverlay;
