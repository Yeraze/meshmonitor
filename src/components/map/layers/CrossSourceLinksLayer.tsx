/**
 * CrossSourceLinksLayer — directional "heard here" edges between our own
 * sources (#5561). A child of the map (BaseMap / MapContainer).
 *
 * An edge A -> B means source A's radio was heard by source B (or by an MQTT
 * gateway on source B). It is one-way: A -> B says nothing about B -> A, so
 * every edge carries arrowheads pointing at the hearing radio. Likely-relay
 * edges are dotted and labelled inferred.
 *
 * Self-contained: it fetches its own data (nothing at all while `enabled` is
 * false) and the server has already applied the two-source read rule and the
 * position privacy gates. Rendering reuses the shared `NeighborLinksLayer`
 * line + arrow mechanics.
 */
import { useMemo } from 'react';
import { Popup } from 'react-leaflet';
import { useTranslation } from 'react-i18next';
import { NeighborLinksLayer, type NeighborLinkDescriptor } from './NeighborLinksLayer';
import { useCrossSourceLinks } from '../../../hooks/useCrossSourceLinks';
import { crossSourceLinkStyle } from '../../../utils/crossSourceLinkStyle';
import { crossSourceTransportLabel } from '../../../utils/crossSourceLabels';
import type { CrossSourceLinkDto } from '../../../types/crossSourceLinks';
import styles from './CrossSourceLinksLayer.module.css';

export interface CrossSourceLinksLayerProps {
  /** The map's "Show cross-source links" toggle. False = no fetch, no render. */
  enabled: boolean;
  /** Keep edges touching one of these sources; empty = every readable source. */
  sourceIds: string[];
  /** Same age window the map's other layers use. */
  lookbackHours: number;
}

function CrossSourceLinkPopup({ link }: { link: CrossSourceLinkDto }) {
  const { t } = useTranslation();
  const tx = link.txName ?? link.txNodeId;
  const rx = link.rxName ?? link.rxNodeId;
  return (
    <Popup>
      <div className={styles.popup} data-testid="cross-source-link-popup">
        <div className={styles.title}>
          {link.kind === 'relay'
            ? t('map.cross_source.popup_relay', '{{tx}} likely relayed to {{rx}}', { tx, rx })
            : t('map.cross_source.popup_origin', '{{tx}} heard by {{rx}}', { tx, rx })}
        </div>
        {link.inferred && (
          <div className={styles.inferred}>
            {t('map.cross_source.inferred', 'Inferred from the relay hash; not proven.')}
          </div>
        )}
        <div className={styles.row}>
          <span className={styles.label}>{t('map.cross_source.sources', 'Sources')}</span>
          <span>{t('map.cross_source.sources_value', '{{tx}} to {{rx}}', { tx: link.txSourceName, rx: link.rxSourceName })}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{t('map.cross_source.via', 'Via')}</span>
          <span>{crossSourceTransportLabel(t, link.transportClass)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{t('map.cross_source.count', 'Heard')}</span>
          <span>{t('map.cross_source.count_value', '{{count}} times', { count: link.count })}</span>
        </div>
        {link.snrAvg != null && (
          <div className={styles.row}>
            <span className={styles.label}>{t('map.cross_source.snr', 'SNR avg (min / max)')}</span>
            <span>
              {`${link.snrAvg.toFixed(1)} dB (${link.snrMin?.toFixed(1) ?? '-'} / ${link.snrMax?.toFixed(1) ?? '-'})`}
            </span>
          </div>
        )}
        {link.rssiAvg != null && (
          <div className={styles.row}>
            <span className={styles.label}>{t('map.cross_source.rssi', 'RSSI avg')}</span>
            <span>{`${Math.round(link.rssiAvg)} dBm`}</span>
          </div>
        )}
        <div className={styles.row}>
          <span className={styles.label}>{t('map.cross_source.last_heard', 'Last heard')}</span>
          <span>{new Date(link.lastHeardAt).toLocaleString()}</span>
        </div>
      </div>
    </Popup>
  );
}

export function CrossSourceLinksLayer({ enabled, sourceIds, lookbackHours }: CrossSourceLinksLayerProps) {
  const { data } = useCrossSourceLinks({ enabled, sources: sourceIds, lookbackHours });

  const descriptors = useMemo<NeighborLinkDescriptor[]>(() => {
    if (!enabled || !data) return [];
    // Read once per data refresh (at most one refetch interval stale): the age
    // fade does not need a live clock.
    const now = Date.now();
    const windowMs = Math.max(1, now - data.sinceMs);
    return data.links.map((link) => {
      const style = crossSourceLinkStyle(link, now, windowMs);
      return {
        key: `xs-${link.key}`,
        // NeighborLinksLayer arrows point FROM positions[1] TO positions[0]:
        // tail at the transmitter, head at the radio that heard it.
        positions: [link.to, link.from],
        pathOptions: { color: style.color, weight: style.weight, opacity: style.opacity, dashArray: style.dashArray },
        className: 'cross-source-link',
        arrows: { color: style.color, fractions: [0.5] },
        children: <CrossSourceLinkPopup link={link} />,
      };
    });
  }, [enabled, data]);

  if (descriptors.length === 0) return null;
  return <NeighborLinksLayer links={descriptors} />;
}

export default CrossSourceLinksLayer;
