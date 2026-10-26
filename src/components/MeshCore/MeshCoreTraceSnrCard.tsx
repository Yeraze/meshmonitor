/**
 * MeshCoreTraceSnrCard — per-link SNR history from MeshCore traces (#5722).
 *
 * Each row is one DIRECTION of one link: "receiver heard sender". A heard by B
 * and B heard by A are separate rows, because the two SNRs are not the same
 * measurement. Data comes from traces this source's radio heard, whether
 * MeshMonitor sent them or not. Renders nothing without `traceroute:read` on
 * the source or when there is no history. With `canClear` (traceroute:write on
 * the source) a trash button clears this contact's stored history after a
 * confirm (#5970); it touches the database only, never the radio.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { UiIcon } from '../icons';
import { ConfirmDialog } from '../shared/automation/ConfirmDialog';
import { formatRelativeTime } from '../../utils/datetime';
import { SPARK_W, SPARK_H, sparklinePoints, hopSnrEndName, type HopSnrEnd, type HopSnrLink, type HopSnrTranslate } from '../../utils/meshcoreHopSnr';
import styles from './MeshCoreTraceSnrCard.module.css';

interface Envelope { success: boolean; data?: { hours: number; links: HopSnrLink[] } }

export interface MeshCoreTraceSnrCardProps {
  sourceId: string | null;
  publicKey: string;
  /** Known contacts, for turning a public key into a name. */
  contacts?: ReadonlyArray<{ publicKey: string; name?: string | null; advName?: string | null }>;
  /** This source's own node, shown as "This node". */
  localPublicKey?: string | null;
  /** The viewer holds traceroute:write on this source: show the clear button. */
  canClear?: boolean;
  /** Called after this card cleared the history, so siblings can reload. */
  onCleared?: () => void;
}

export const MeshCoreTraceSnrCard: React.FC<MeshCoreTraceSnrCardProps> = ({
  sourceId, publicKey, contacts, localPublicKey, canClear = false, onCleared,
}) => {
  const { t } = useTranslation();
  const key = publicKey.toLowerCase();
  const [data, setData] = useState<HopSnrLink[] | null>(null);
  const [reloads, setReloads] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  // A plain effect, like the rest of this panel (it is also rendered where no
  // query provider is mounted). Reloads when the contact or source changes.
  useEffect(() => {
    setData(null);
    if (!sourceId || !/^[0-9a-f]{64}$/.test(key)) return;
    let cancelled = false;
    void (async () => {
      try {
        const body = await api.get<Envelope>(`/api/sources/${encodeURIComponent(sourceId)}/meshcore/hop-snr?publicKey=${key}`);
        if (!cancelled) setData(body?.data?.links ?? []);
      } catch (e) {
        // No traceroute:read on this source (401/403) or a read error: show
        // nothing. The status is read off the error itself, not via
        // `instanceof`, so a partial mock of the API module cannot break this.
        const status = (e as { status?: unknown } | null)?.status;
        if (status !== 401 && status !== 403) console.debug('MeshCore trace SNR history failed to load', e);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId, key, reloads]);

  // A different contact or source closes any open confirm.
  useEffect(() => { setConfirming(false); setClearError(null); }, [sourceId, key]);

  const clearHistory = async () => {
    setConfirming(false);
    if (!sourceId) return;
    setClearing(true);
    setClearError(null);
    try {
      await api.delete(`/api/sources/${encodeURIComponent(sourceId)}/meshcore/hop-snr?publicKey=${key}`);
      setReloads((n) => n + 1);
      onCleared?.();
    } catch (e) {
      console.debug('MeshCore trace SNR history failed to clear', e);
      setClearError(t('meshcore.trace_snr.clear_failed', 'Could not clear the trace SNR history.'));
    } finally {
      setClearing(false);
    }
  };

  if (!data || data.length === 0) return null;

  const nameOf = (end: HopSnrEnd): string =>
    hopSnrEndName(end, { contactKey: key, localPublicKey, contacts, t: t as unknown as HopSnrTranslate });

  return (
    <div className={styles.card} data-testid="meshcore-trace-snr">
      <div className={styles.header}>
        <h4 className={styles.title}>
          <UiIcon name="radioSignal" size={15} /> {t('meshcore.trace_snr.title', 'Trace SNR history')}
        </h4>
        {canClear && (
          <button type="button" className={styles.clearBtn} disabled={clearing}
            aria-label={t('meshcore.trace_snr.clear', 'Clear trace SNR history')}
            title={t('meshcore.trace_snr.clear', 'Clear trace SNR history')}
            onClick={() => setConfirming(true)}>
            <UiIcon name="delete" size={15} />
          </button>
        )}
      </div>
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
      {clearError && <p className={styles.error} role="alert">{clearError}</p>}
      {confirming && (
        <ConfirmDialog
          title={t('meshcore.trace_snr.clear_confirm_title', 'Clear trace SNR history?')}
          message={t('meshcore.trace_snr.clear_confirm_message', 'This deletes every stored trace SNR sample for this contact on this source, in both directions and at any age. It cannot be undone.')}
          confirmLabel={t('meshcore.trace_snr.clear_confirm', 'Clear history')}
          cancelLabel={t('common.cancel', 'Cancel')}
          onConfirm={() => { void clearHistory(); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
};
