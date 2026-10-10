/**
 * MeshCoreTraceSnrCard — per-link SNR history from MeshCore traces (#5722).
 *
 * Each row is one DIRECTION of one link: "receiver heard sender". A heard by B
 * and B heard by A are separate rows, because the two SNRs are not the same
 * measurement. Data comes from traces this source's radio heard, whether
 * MeshMonitor sent them or not. Read-only; renders nothing without
 * `traceroute:read` on the source or when there is no history.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api, { ApiError } from '../../services/api';
import { UiIcon } from '../icons';
import { formatRelativeTime } from '../../utils/datetime';
import { SPARK_W, SPARK_H, sparklinePoints, type HopSnrEnd, type HopSnrLink } from '../../utils/meshcoreHopSnr';
import styles from './MeshCoreTraceSnrCard.module.css';

interface Envelope { success: boolean; data?: { hours: number; links: HopSnrLink[] } }

export interface MeshCoreTraceSnrCardProps {
  sourceId: string | null;
  publicKey: string;
  /** Known contacts, for turning a public key into a name. */
  contacts?: ReadonlyArray<{ publicKey: string; name?: string | null; advName?: string | null }>;
  /** This source's own node, shown as "This node". */
  localPublicKey?: string | null;
}

export const MeshCoreTraceSnrCard: React.FC<MeshCoreTraceSnrCardProps> = ({ sourceId, publicKey, contacts, localPublicKey }) => {
  const { t } = useTranslation();
  const key = publicKey.toLowerCase();
  const [data, setData] = useState<HopSnrLink[] | null>(null);
  // A plain effect, like the rest of this panel (it is also rendered where no
  // query provider is mounted). Reloads when the contact or source changes.
  useEffect(() => {
    setData(null);
    if (!sourceId || !/^[0-9a-f]{64}$/.test(key)) return;
    let cancelled = false;
    api.get<Envelope>(`/api/sources/${encodeURIComponent(sourceId)}/meshcore/hop-snr?publicKey=${key}`)
      .then((body) => { if (!cancelled) setData(body?.data?.links ?? []); })
      .catch((e: unknown) => {
        // No traceroute:read on this source, or a read error: show nothing.
        if (!(e instanceof ApiError && (e.status === 403 || e.status === 401))) {
          console.debug('MeshCore trace SNR history failed to load', e);
        }
      });
    return () => { cancelled = true; };
  }, [sourceId, key]);

  if (!data || data.length === 0) return null;

  const nameOf = (end: HopSnrEnd): string => {
    if (end.publicKey) {
      if (end.publicKey === key) return t('meshcore.trace_snr.this_contact', 'this contact');
      if (localPublicKey && end.publicKey === localPublicKey.toLowerCase()) return t('meshcore.trace_snr.this_node', 'This node');
      const c = contacts?.find((x) => x.publicKey?.toLowerCase() === end.publicKey);
      return c?.name || c?.advName || `${end.publicKey.slice(0, 8)}…`;
    }
    if (end.hash) {
      return end.candidates > 1
        ? t('meshcore.trace_snr.ambiguous', '{{hash}} ({{count}} contacts share it)', { hash: end.hash, count: end.candidates })
        : t('meshcore.trace_snr.unknown_hash', '{{hash}} (unknown)', { hash: end.hash });
    }
    return t('meshcore.trace_snr.unknown_origin', 'unknown sender');
  };

  return (
    <div className={styles.card} data-testid="meshcore-trace-snr">
      <h4 className={styles.title}>
        <UiIcon name="radioSignal" size={15} /> {t('meshcore.trace_snr.title', 'Trace SNR history')}
      </h4>
      <p className={styles.help}>
        {t('meshcore.trace_snr.help', 'From MeshCore traces this source heard. Each row is one direction: how well the receiver heard the sender.')}
      </p>
      <ul className={styles.list}>
        {data.map((link, i) => {
          const thisIsReceiver = link.receiver.publicKey === key;
          return (
            <li key={i} className={styles.row} data-direction={thisIsReceiver ? 'in' : 'out'}>
              <span className={styles.direction}>
                <strong>{nameOf(link.receiver)}</strong>{' '}
                {t('meshcore.trace_snr.heard', 'heard')}{' '}
                <strong>{nameOf(link.sender)}</strong>
              </span>
              <span className={styles.stats}>
                <span className={styles.last}>{link.lastSnr.toFixed(2)} dB</span>
                <span className={styles.meta}>
                  {t('meshcore.trace_snr.stats', 'avg {{avg}} · {{min}} to {{max}} · {{count}} samples', {
                    avg: link.avgSnr.toFixed(1), min: link.minSnr.toFixed(1), max: link.maxSnr.toFixed(1), count: link.count,
                  })}
                  {' · '}{formatRelativeTime(link.lastTimestamp)}
                </span>
              </span>
              {link.points.length > 1 && (
                <svg className={styles.spark} width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                  role="img" aria-label={t('meshcore.trace_snr.spark_label', 'SNR over time, {{count}} samples', { count: link.points.length })}>
                  <polyline points={sparklinePoints(link.points)} fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
