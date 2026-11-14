/**
 * "Direct RF" section for the Meshtastic and MeshCore node detail pages
 * (#6210): when this source's radio last and first heard the node at zero
 * hops over RF, how often, the best SNR, and a per-day bar strip of direct
 * receptions over the last 30 days.
 *
 * Reads `GET /api/sources/:id/direct-rf-contacts/node/:nodeKey`. Renders
 * nothing without a source, while loading, or on an error (for example no
 * `nodes:read`), so it never breaks the detail page. Sends nothing.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../services/api';
import type { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import { formatDateTime } from '../utils/datetime';
import { UiIcon } from './icons';
import { buildDailySlots, DIRECT_RF_SECTION_DAYS, type DirectRfNodeResponse } from './Analysis/directRfContacts';
import styles from './DirectRfSection.module.css';

const DAY_MS = 86_400_000;

export interface DirectRfSectionProps {
  sourceId?: string | null;
  /** `!xxxxxxxx` (Meshtastic) or a 64-hex public key (MeshCore). */
  nodeKey?: string | null;
  timeFormat?: TimeFormat;
  dateFormat?: DateFormat;
}

export const DirectRfSection: React.FC<DirectRfSectionProps> = ({
  sourceId, nodeKey, timeFormat = '24', dateFormat = 'MM/DD/YYYY',
}) => {
  const { t } = useTranslation();
  const [data, setData] = useState<DirectRfNodeResponse | null>(null);

  const key = nodeKey ? nodeKey.toLowerCase() : null;

  useEffect(() => {
    setData(null);
    if (!sourceId || !key) return;
    let cancelled = false;
    const to = Date.now();
    const from = to - DIRECT_RF_SECTION_DAYS * DAY_MS;
    // Promise.resolve().then: a synchronous throw from the client becomes a
    // rejection, so this section can never break the detail page.
    Promise.resolve()
      .then(() => apiService.get<{ success: boolean; data: DirectRfNodeResponse }>(
        `/api/sources/${encodeURIComponent(sourceId)}/direct-rf-contacts/node/${encodeURIComponent(key)}?from=${from}&to=${to}`,
      ))
      .then((res) => {
        if (cancelled) return;
        const body = res?.data;
        setData(body && Array.isArray(body.daily) ? body : null);
      })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [sourceId, key]);

  const slots = useMemo(() => (data ? buildDailySlots(data.daily, Date.now()) : []), [data]);

  if (!data) return null;
  const s = data.summary;
  const when = (ms: number) => formatDateTime(new Date(ms), timeFormat, dateFormat);
  const max = Math.max(1, ...slots);
  const barW = 100 / slots.length;

  return (
    <section className={styles.section} data-testid="direct-rf-section">
      <h4 className={styles.title}>
        <UiIcon name="radio" size={14} />
        {t('node_details.direct_rf.title', 'Direct RF (last {{days}} days)', { days: DIRECT_RF_SECTION_DAYS })}
      </h4>
      {!s ? (
        <p className={styles.empty} data-testid="direct-rf-section-empty">
          {t('node_details.direct_rf.none', 'Not heard directly over RF in this window.')}
        </p>
      ) : (
        <>
          <dl className={styles.stats}>
            <div>
              <dt>{t('node_details.direct_rf.last', 'Last heard direct')}</dt>
              <dd data-testid="direct-rf-last">{when(s.lastHeardAt)}</dd>
            </div>
            <div>
              <dt>{t('node_details.direct_rf.first', 'First heard direct')}</dt>
              <dd data-testid="direct-rf-first">{when(s.firstHeardAt)}</dd>
            </div>
            <div>
              <dt>{t('node_details.direct_rf.count', 'Direct receptions')}</dt>
              <dd data-testid="direct-rf-count">{s.receptionCount}</dd>
            </div>
            <div>
              <dt>{t('node_details.direct_rf.best_snr', 'Best SNR')}</dt>
              <dd data-testid="direct-rf-best-snr">{s.bestSnr == null ? '—' : `${s.bestSnr} dB`}</dd>
            </div>
          </dl>
          <svg
            className={styles.spark}
            viewBox="0 0 100 28"
            preserveAspectRatio="none"
            role="img"
            aria-label={t('node_details.direct_rf.spark_label', 'Direct receptions per day')}
            data-testid="direct-rf-spark"
          >
            {slots.map((n, i) => {
              const h = n > 0 ? Math.max(2, (n / max) * 28) : 1;
              return (
                <rect
                  key={i}
                  x={i * barW + barW * 0.1}
                  y={28 - h}
                  width={barW * 0.8}
                  height={h}
                  className={n > 0 ? styles.bar : styles.barEmpty}
                >
                  <title>{String(n)}</title>
                </rect>
              );
            })}
          </svg>
          <p className={styles.sparkCaption}>
            {t('node_details.direct_rf.spark_caption', 'Direct receptions per UTC day, oldest left.')}
          </p>
        </>
      )}
    </section>
  );
};

export default DirectRfSection;
