/**
 * DashboardMap — self-contained map component for the Dashboard page.
 *
 * Renders node markers, marker popups, and neighbor link polylines on a
 * react-leaflet MapContainer. Automatically fits the map bounds to nodes
 * that have valid GPS positions.
 */

import { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import { createNodeIcon } from '../../utils/mapIcons';
import { getTilesetById } from '../../config/tilesets';
import type { CustomTileset } from '../../config/tilesets';

export interface DashboardMapProps {
  nodes: any[];
  neighborInfo: any[];
  traceroutes: any[];
  channels: any[];
  tilesetId: string;
  customTilesets: CustomTileset[];
  defaultCenter: { lat: number; lng: number };
}

/** Returns true when the position is usable (non-null, non-zero lat and lng). */
function hasValidPosition(node: any): boolean {
  const pos = node?.position;
  if (!pos) return false;
  const lat = pos.latitude;
  const lng = pos.longitude;
  return lat != null && lng != null && (lat !== 0 || lng !== 0);
}

// ---------------------------------------------------------------------------
// MapBoundsUpdater — internal helper that calls fitBounds inside the map ctx
// ---------------------------------------------------------------------------

interface MapBoundsUpdaterProps {
  positions: [number, number][];
}

function MapBoundsUpdater({ positions }: MapBoundsUpdaterProps) {
  const map = useMap();

  useEffect(() => {
    if (positions.length === 0) return;
    const bounds = L.latLngBounds(positions);
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [map, positions]);

  return null;
}

// ---------------------------------------------------------------------------
// DashboardMap
// ---------------------------------------------------------------------------

export default function DashboardMap({
  nodes,
  neighborInfo,
  tilesetId,
  customTilesets,
  defaultCenter,
}: DashboardMapProps) {
  const tileset = getTilesetById(tilesetId, customTilesets);

  const nodesWithPosition = nodes.filter(hasValidPosition);

  const nodePositions: [number, number][] = nodesWithPosition.map((n) => [
    n.position.latitude,
    n.position.longitude,
  ]);

  const hasNodes = nodesWithPosition.length > 0;

  return (
    <div className="dashboard-map-container" style={{ position: 'relative' }}>
      <MapContainer
        center={[defaultCenter.lat, defaultCenter.lng]}
        zoom={10}
        style={{ height: '100%', width: '100%' }}
        zoomControl
      >
        <TileLayer
          url={tileset.url}
          attribution={tileset.attribution}
          maxZoom={tileset.maxZoom}
        />

        {hasNodes && <MapBoundsUpdater positions={nodePositions} />}

        {nodesWithPosition.map((node) => {
          const lat = node.position.latitude;
          const lng = node.position.longitude;
          const hops = node.hopsAway ?? 999;
          const shortName = node.user?.shortName;
          const isRouter = node.role === 2;
          const icon = createNodeIcon({
            hops,
            isSelected: false,
            isRouter,
            shortName,
            showLabel: true,
          });

          return (
            <Marker
              key={node.user?.id}
              position={[lat, lng]}
              icon={icon}
            >
              <Popup>
                <div>
                  <strong>{node.user?.longName ?? 'Unknown'}</strong>
                  {shortName && <span> ({shortName})</span>}
                  <br />
                  <span>
                    {lat.toFixed(5)}, {lng.toFixed(5)}
                  </span>
                  {hops !== 999 && (
                    <>
                      <br />
                      <span>Hops: {hops}</span>
                    </>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {neighborInfo.map((link, idx) => {
          const { nodeLatitude, nodeLongitude, neighborLatitude, neighborLongitude, bidirectional } = link;
          if (
            nodeLatitude == null ||
            nodeLongitude == null ||
            neighborLatitude == null ||
            neighborLongitude == null
          ) {
            return null;
          }

          const positions: [number, number][] = [
            [nodeLatitude, nodeLongitude],
            [neighborLatitude, neighborLongitude],
          ];

          const pathOptions = bidirectional
            ? { color: 'blue', weight: 2, opacity: 0.6 }
            : { color: 'gray', weight: 1, opacity: 0.6, dashArray: '5, 5' };

          return (
            <Polyline
              key={`neighbor-link-${idx}`}
              positions={positions}
              pathOptions={pathOptions}
            />
          );
        })}
      </MapContainer>

      {!hasNodes && (
        <div className="dashboard-map-empty">
          <div className="dashboard-map-empty-content">
            <h3>No node positions</h3>
            <p>Select a source with nodes that have GPS positions to see them on the map.</p>
          </div>
        </div>
      )}
    </div>
  );
}
