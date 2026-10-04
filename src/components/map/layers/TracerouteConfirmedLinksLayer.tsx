/**
 * TracerouteConfirmedLinksLayer — reciprocal links confirmed by traceroute
 * (#5580). A child of the map (BaseMap / MapContainer), and the sibling of
 * `CrossSourceLinksLayer`.
 *
 * The "heard here" layer shows one-way edges between our own sources. This one
 * shows a link between one of our radios and a REMOTE node that a completed
 * traceroute used in both directions: the first hop out and the last hop back
 * were the same neighbour. So the line is double-headed, and carries the SNR
 * each end measured.
 *
 * Self-contained: it fetches its own data (nothing at all while `enabled` is
 * false). The server has already applied the nodes + traceroute read rule and
 * the position privacy gates. Rendering reuses `NeighborLinksLayer`.
 */
import { useMemo } from 'react';
import { Popup } from 'react-leaflet';
import { useTranslation } from 'react-i18next';
import { NeighborLinksLayer, type NeighborLinkDescriptor } from './NeighborLinksLayer';
import { useTracerouteConfirmedLinks } from '../../../hooks/useTracerouteConfirmedLinks';
import {
  tracerouteConfirmedLinkStyle,
  TRACEROUTE_CONFIRMED_ARROW_FRACTIONS,
} from '../../../utils/crossSourceLinkStyle';
import { crossSourceTransportLabel } from '../../../utils/crossSourceLabels';
import type { TracerouteConfirmedLinkDto } from '../../../types/crossSourceLinks';
import styles from './TracerouteConfirmedLinksLayer.module.css';

export interface TracerouteConfirmedLinksLayerProps {
  /** Both map toggles on. False = no fetch, no render. */
  enabled: boolean;
  /** Limit to these sources; empty = every readable source. */
  sourceIds: string[];
  /** Same age window the map's other layers use. */
  lookbackHours: number;
}

function TracerouteConfirmedLinkPopup({ link, historyLimit }: { link: TracerouteConfirmedLinkDto; historyLimit: number }) {
  const { t } = useTranslation();
  const local = link.localName ?? link.localNodeId;
  const neighbor = link.neighborName ?? link.neighborNodeId;
  const snr = (value: number | null): string =>
    value == null ? t('map.traceroute_confirmed.snr_unknown', 'not reported') : `${value.toFixed(1)} dB`;
  return (
    <Popup>
      <div className={styles.popup} data-testid="traceroute-confirmed-link-popup">
        <div className={styles.title}>
          {t('map.traceroute_confirmed.popup_title', '{{local}} and {{neighbor}} hear each other', { local, neighbor })}
        </div>
        <div className={styles.note}>
          {t(
            'map.traceroute_confirmed.popup_note',
            'Confirmed by traceroute: this link carried the request out and the reply back.',
          )}
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{t('map.traceroute_confirmed.source', 'Source')}</span>
          <span>{link.sourceName}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{t('map.cross_source.via', 'Via')}</span>
          <span>{crossSourceTransportLabel(t, link.transportClass)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>
            {t('map.traceroute_confirmed.snr_out', '{{neighbor}} hears {{local}}', { local, neighbor })}
          </span>
          <span>{snr(link.snrOutAvg)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>
            {t('map.traceroute_confirmed.snr_back', '{{local}} hears {{neighbor}}', { local, neighbor })}
          </span>
          <span>{snr(link.snrBackAvg)}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{t('map.traceroute_confirmed.count', 'Confirming traceroutes')}</span>
          <span>
            {t('map.traceroute_confirmed.count_value', '{{count}} ({{direct}} direct)', {
              count: link.count,
              direct: link.directCount,
            })}
          </span>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>{t('map.traceroute_confirmed.last', 'Last confirmed')}</span>
          <span>{new Date(link.lastConfirmedAt).toLocaleString()}</span>
        </div>
        <div className={styles.note}>
          {t(
            'map.traceroute_confirmed.limit_note',
            'Only the newest {{limit}} traceroutes per node pair are kept.',
            { limit: historyLimit },
          )}
        </div>
      </div>
    </Popup>
  );
}

export function TracerouteConfirmedLinksLayer({ enabled, sourceIds, lookbackHours }: TracerouteConfirmedLinksLayerProps) {
  const { data } = useTracerouteConfirmedLinks({ enabled, sources: sourceIds, lookbackHours });

  const descriptors = useMemo<NeighborLinkDescriptor[]>(() => {
    if (!enabled || !data) return [];
    // Read once per data refresh (at most one refetch interval stale): the age
    // fade does not need a live clock.
    const now = Date.now();
    const windowMs = Math.max(1, now - data.sinceMs);
    return data.links.map((link) => {
      const style = tracerouteConfirmedLinkStyle(link, now, windowMs);
      return {
        key: `trc-${link.key}`,
        // NeighborLinksLayer measures arrow fractions from positions[1] toward
        // positions[0]: our radio is positions[1], the neighbour positions[0].
        positions: [link.to, link.from],
        pathOptions: { color: style.color, weight: style.weight, opacity: style.opacity, dashArray: style.dashArray },
        className: 'traceroute-confirmed-link',
        // One head toward the neighbour, one back toward our radio.
        arrows: {
          color: style.color,
          fractions: [TRACEROUTE_CONFIRMED_ARROW_FRACTIONS.towardNeighbor],
          reverseFractions: [TRACEROUTE_CONFIRMED_ARROW_FRACTIONS.towardLocal],
        },
        children: <TracerouteConfirmedLinkPopup link={link} historyLimit={data.historyLimitPerPair} />,
      };
    });
  }, [enabled, data]);

  if (descriptors.length === 0) return null;
  return <NeighborLinksLayer links={descriptors} />;
}

export default TracerouteConfirmedLinksLayer;
