/**
 * WaypointsLayer — renders one Marker per waypoint per visible source.
 *
 * Pulls the source list from `useDashboardSources` (the same source the other
 * MapAnalysis layers use) and fetches waypoints per-source via the
 * `useWaypoints` hook. Waypoints render as a leaflet `divIcon` using each
 * waypoint's emoji, with a popup that exposes name, description, owner,
 * source, and an expires countdown.
 */
import { useMemo } from 'react';
import { Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import {
  useDashboardSources,
} from '../../../hooks/useDashboardData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { useWaypoints } from '../../../hooks/useWaypoints';
import type { Waypoint } from '../../../types/waypoint';

const FALLBACK_EMOJI = '\u{1F4CD}';

function emojiDivIcon(emoji: string | null | undefined, isLocked: boolean): L.DivIcon {
  const display = emoji && emoji.length > 0 ? emoji : FALLBACK_EMOJI;
  const ring = isLocked
    ? 'box-shadow: 0 0 0 2px rgba(220,80,80,0.85);'
    : 'box-shadow: 0 0 0 2px rgba(255,255,255,0.85);';
  const html = `
    <div class="waypoint-pin" style="
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: rgba(255,255,255,0.9);
      ${ring}
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      line-height: 1;
      pointer-events: auto;
    ">${display}</div>
  `;
  return L.divIcon({
    html,
    className: 'waypoint-icon',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
}

function formatExpire(expireAt: number | null): string {
  if (expireAt === null || expireAt === 0) return 'never';
  const now = Math.floor(Date.now() / 1000);
  const remaining = expireAt - now;
  if (remaining <= 0) return 'expired';
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

interface SourceInfo {
  id: string;
  name?: string;
}

function PerSourceWaypoints({ source }: { source: SourceInfo }) {
  const { waypoints } = useWaypoints(source.id);

  if (!waypoints || waypoints.length === 0) return null;

  return (
    <>
      {waypoints.map((wp: Waypoint) => {
        const icon = emojiDivIcon(wp.iconEmoji, Boolean(wp.lockedTo));
        const ownerLabel =
          wp.ownerNodeNum != null
            ? `!${Number(wp.ownerNodeNum).toString(16).padStart(8, '0')}`
            : 'unknown';
        return (
          <Marker
            key={`${wp.sourceId}:${wp.waypointId}`}
            position={[wp.latitude, wp.longitude]}
            icon={icon}
          >
            <Popup>
              <div style={{ minWidth: 180 }}>
                <strong>{wp.name || `Waypoint ${wp.waypointId}`}</strong>
                {wp.description && (
                  <div style={{ marginTop: 4, fontSize: '0.9em' }}>{wp.description}</div>
                )}
                <div style={{ marginTop: 6, fontSize: '0.85em', color: '#666' }}>
                  <div>Source: {source.name ?? source.id}</div>
                  <div>Owner: {ownerLabel}</div>
                  <div>Expires: {formatExpire(wp.expireAt)}</div>
                  {wp.lockedTo && (
                    <div style={{ color: '#c0392b' }}>
                      Locked to !{Number(wp.lockedTo).toString(16).padStart(8, '0')}
                    </div>
                  )}
                  {wp.isVirtual && <div style={{ fontStyle: 'italic' }}>Virtual (local-only)</div>}
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

export default function WaypointsLayer() {
  const { config } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();
  const sourceList = sources as SourceInfo[];

  const visibleSources = useMemo(() => {
    if (config.sources.length === 0) return sourceList;
    return sourceList.filter((s) => config.sources.includes(s.id));
  }, [sourceList, config.sources]);

  return (
    <>
      {visibleSources.map((s) => (
        <PerSourceWaypoints key={s.id} source={s} />
      ))}
    </>
  );
}
