/**
 * AtakContactsLayer — renders one Marker per positioned ATAK contact per
 * source (ATAK/CoT Phase 2, issue #3691).
 *
 * Modeled on `WaypointsLayer`'s `PerSourceWaypoints`: contacts are sparse
 * (one row per distinct ATAK EUD), so direct `<Marker>` rendering is correct
 * — this does NOT route through `NodeMarkersLayer`'s spiderfier machinery,
 * which exists for dense node piles (spec §1 "Self-fetching per-source map
 * layer").
 */
import { useMemo } from 'react';
import { Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { useMapAnalysisCtx } from '../../MapAnalysis/MapAnalysisContext';
import { useAtakContacts } from '../../../hooks/useAtakContacts';
import type { AtakContact } from '../../../types/atakContact';
import { createAtakContactIcon } from '../markerIcons';
import { teamColor, teamLabel, roleLabel } from '../../../utils/atakTeam';
import { formatRelativeTime } from '../../../utils/datetime';
import { UiIcon } from '../../icons';
import styles from './AtakContactsLayer.module.css';

export interface SourceInfo {
  id: string;
  name?: string;
}

/** Internal shape used to build each marker; kept for clarity even though
 *  rendering is direct (spec §2i "Descriptor shape reference"). */
interface AtakContactDescriptor {
  key: string;
  position: [number, number];
  iconSig: string;
  buildIcon: () => L.DivIcon;
  contact: AtakContact;
}

function buildDescriptor(contact: AtakContact): AtakContactDescriptor | null {
  if (contact.latitude === null || contact.longitude === null) return null;
  const color = teamColor(contact.team);
  return {
    key: `${contact.sourceId}:${contact.uid}`,
    position: [contact.latitude, contact.longitude],
    iconSig: `${color}:${contact.callsign ?? ''}:${contact.stale}`,
    buildIcon: () =>
      createAtakContactIcon({ color, callsign: contact.callsign, stale: contact.stale }),
    contact,
  };
}

export function AtakContactsLayer({ source }: { source: SourceInfo }) {
  const { contacts } = useAtakContacts(source.id);

  const descriptors = useMemo(
    () => contacts.map(buildDescriptor).filter((d): d is AtakContactDescriptor => d !== null),
    [contacts],
  );

  if (descriptors.length === 0) return null;

  return (
    <>
      {descriptors.map((d) => {
        const { contact } = d;
        const color = teamColor(contact.team);
        return (
          // zIndexOffset: an ATAK EUD is typically carried alongside a
          // Meshtastic node, so co-location is the COMMON case — without a
          // boost the node marker's latitude-derived z-index covers the
          // contact and makes it unclickable (#3691). Explicitly-toggled
          // ATAK contacts render above node icons.
          <Marker key={d.key} position={d.position} icon={d.buildIcon()} zIndexOffset={1000}>
            <Popup>
              <div className="node-popup">
                <div className="node-popup-header">
                  <div className="node-popup-title">
                    {contact.callsign || contact.deviceCallsign || 'ATAK Contact'}
                  </div>
                </div>
                <div className="node-popup-content">
                  <div className={styles.grid}>
                    <div className={styles.item}>
                      <span className={styles.teamSwatch} style={{ backgroundColor: color }} />
                      <span className={styles.value}>{teamLabel(contact.team)}</span>
                    </div>
                    <div className={styles.item}>
                      <UiIcon name="identity" size={15} />
                      <span className={styles.value}>{roleLabel(contact.role)}</span>
                    </div>
                    {contact.battery !== null && (
                      <div className={styles.item}>
                        <UiIcon name="battery" size={15} />
                        <span className={styles.value}>{contact.battery}%</span>
                      </div>
                    )}
                    {contact.course !== null && (
                      <div className={styles.item}>
                        <UiIcon name="route" size={15} />
                        <span className={styles.value}>{contact.course}°</span>
                      </div>
                    )}
                    {contact.speed !== null && (
                      <div className={styles.item}>
                        <UiIcon name="activity" size={15} />
                        <span className={styles.value}>{contact.speed} m/s</span>
                      </div>
                    )}
                    {contact.altitude !== null && (
                      <div className={styles.item}>
                        <UiIcon name="altitude" size={15} />
                        <span className={styles.value}>{contact.altitude} m HAE</span>
                      </div>
                    )}
                    <div className={styles.item}>
                      <UiIcon name="time" size={15} />
                      <span className={styles.value}>{formatRelativeTime(contact.lastSeen)}</span>
                    </div>
                  </div>
                  {contact.stale && (
                    <div className={styles.staleBadge}>
                      <UiIcon name="alert" size={13} />
                      STALE
                    </div>
                  )}
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

/**
 * MapAnalysis-flavored default export: iterates the config-selected sources
 * (empty = all), mirroring `WaypointsLayer`'s default export.
 */
export default function AtakContactsLayer_MapAnalysis() {
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
        <AtakContactsLayer key={s.id} source={s} />
      ))}
    </>
  );
}
