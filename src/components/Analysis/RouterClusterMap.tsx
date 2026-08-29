/**
 * RouterClusterMap — small embedded map for a Router Cluster (B1) finding on
 * the Mesh Issues report (#4974). Draws one marker per positioned cluster
 * member so the user can see the cluster's geography at a glance; the
 * best-sited member (the one the recommendation says to keep as ROUTER) is
 * highlighted. Members without a stored position are counted in a note under
 * the map rather than guessed at.
 *
 * The map is collapsed behind a "Show map" toggle so a report page with many
 * findings doesn't eagerly mount N Leaflet instances (and their tile loads).
 * Follows the MeshCoreMessageRouteModal embedded-map pattern: BaseMap +
 * fit-to-bounds controller + CircleMarkers with permanent labels.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import { CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { BaseMap } from '../map/BaseMap';
import { UiIcon } from '../icons';
import { hexNodeId, type EvidenceNodeRef } from './meshIssueTypes';
import styles from './RouterClusterMap.module.css';

interface PositionedMember {
  nodeNum: number;
  label: string;
  lat: number;
  lon: number;
  bestSited: boolean;
}

/** Finite, non-null-island coordinates only. */
function memberPosition(m: EvidenceNodeRef): { lat: number; lon: number } | null {
  const { latitude: lat, longitude: lon } = m;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return null;
  if (typeof lon !== 'number' || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** Fit the map view to the cluster once per member set. */
const FitClusterBounds: React.FC<{ members: PositionedMember[] }> = ({ members }) => {
  const map = useMap();
  useEffect(() => {
    const latLngs = members.map((m) => [m.lat, m.lon] as [number, number]);
    if (latLngs.length === 1) {
      map.setView(latLngs[0], 13);
      return;
    }
    const bounds = L.latLngBounds(latLngs);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [map, members]);
  return null;
};

interface RouterClusterMapProps {
  members: EvidenceNodeRef[];
  bestSitedNodeNum: number | null;
}

/** Marker colors follow the embedded route-flow map precedent
 * (MeshCoreMessageRouteModal) — Leaflet pathOptions take literal colors, not
 * CSS variables. */
const CLUSTER_COLOR = '#89b4fa';
const BEST_SITED_COLOR = '#a6e3a1';

export const RouterClusterMap: React.FC<RouterClusterMapProps> = ({ members, bestSitedNodeNum }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const positioned = useMemo<PositionedMember[]>(
    () =>
      members.flatMap((m) => {
        const pos = memberPosition(m);
        if (!pos) return [];
        return [
          {
            nodeNum: m.nodeNum,
            label: m.name ?? hexNodeId(m.nodeNum),
            lat: pos.lat,
            lon: pos.lon,
            bestSited: m.nodeNum === bestSitedNodeNum,
          },
        ];
      }),
    [members, bestSitedNodeNum],
  );

  if (positioned.length === 0) return null;
  const unpositionedCount = members.length - positioned.length;

  return (
    <div className={styles.clusterMapSection}>
      <button
        type="button"
        className={`reports-btn reports-btn--ghost ${styles.mapToggle}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <UiIcon name="map" size={14} />
        {open
          ? t('analysis.mesh_issues.hide_map', 'Hide map')
          : t('analysis.mesh_issues.show_map', 'Show map')}
      </button>
      {open && (
        <>
          <div className={styles.clusterMap} data-testid="router-cluster-map">
            <BaseMap
              center={[positioned[0].lat, positioned[0].lon]}
              zoom={12}
              zoomControl={false}
              attributionControl={false}
              scrollWheelZoom={false}
            >
              <FitClusterBounds members={positioned} />
              {positioned.map((m) => (
                <CircleMarker
                  key={m.nodeNum}
                  center={[m.lat, m.lon]}
                  radius={m.bestSited ? 8 : 6}
                  pathOptions={{
                    color: m.bestSited ? BEST_SITED_COLOR : CLUSTER_COLOR,
                    fillColor: m.bestSited ? BEST_SITED_COLOR : CLUSTER_COLOR,
                    fillOpacity: 0.85,
                  }}
                >
                  <Tooltip permanent direction="top" offset={[0, -8]} className={styles.markerLabel}>
                    {m.label}
                  </Tooltip>
                </CircleMarker>
              ))}
            </BaseMap>
          </div>
          {unpositionedCount > 0 && (
            <div className={styles.unpositionedNote}>
              {t('analysis.mesh_issues.unpositioned_members', '{{count}} member(s) have no stored position and are not shown.', {
                count: unpositionedCount,
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default RouterClusterMap;
