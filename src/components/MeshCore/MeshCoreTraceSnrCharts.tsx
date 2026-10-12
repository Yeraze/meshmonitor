/**
 * MeshCoreTraceSnrCharts — full-size SNR-over-time charts, one per direction
 * of each link the open contact is part of (#5765).
 *
 * The drill-in for `MeshCoreTraceSnrCard`: same data (traces this source's
 * radio heard), same `traceroute:read` gate, but with a time axis, a tooltip
 * and a range control. Read-only: it sends nothing and arms no timer.
 *
 * The range is local to this section. The telemetry graphs below the panel own
 * their range inside `TelemetryGraphs`, stop at the telemetry retention window
 * and are absent for a contact with no telemetry; trace SNR is kept 90 days.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import api from '../../services/api';
import { UiIcon } from '../icons';
import { formatChartAxisTimestamp } from '../../utils/datetime';
import {
  HOP_SNR_CHART_POINTS,
  hopSnrChartData,
  hopSnrEndName,
  type HopSnrEnd,
  type HopSnrLink,
  type HopSnrTranslate,
} from '../../utils/meshcoreHopSnr';
import styles from './MeshCoreTraceSnrCharts.module.css';

interface Envelope { success: boolean; data?: { hours: number; links: HopSnrLink[] } }

const RANGES: ReadonlyArray<{ label: string; hours: number }> = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '30d', hours: 24 * 30 },
  { label: '90d', hours: 24 * 90 },
];
/** Matches the summary card's window, so both show the same links at first. */
const DEFAULT_HOURS = 24 * 7;
/** Above this many samples the per-sample dots are dropped. */
const DOT_LIMIT = 150;

export interface MeshCoreTraceSnrChartsProps {
  sourceId: string | null;
  publicKey: string;
  /** Known contacts, for turning a public key into a name. */
  contacts?: ReadonlyArray<{ publicKey: string; name?: string | null; advName?: string | null }>;
  /** This source's own node, shown as "This node". */
  localPublicKey?: string | null;
}

interface Loaded {
  /** `sourceId|publicKey` the links belong to. */
  owner: string;
  links: HopSnrLink[];
  /** True once any range returned a link for this contact. */
  seen: boolean;
}

const endId = (end: HopSnrEnd): string => end.publicKey ?? (end.hash ? `h:${end.hash}` : '?');

export const MeshCoreTraceSnrCharts: React.FC<MeshCoreTraceSnrChartsProps> = ({ sourceId, publicKey, contacts, localPublicKey }) => {
  const { t } = useTranslation();
  const key = publicKey.toLowerCase();
  const owner = `${sourceId ?? ''}|${key}`;
  const [hours, setHours] = useState<number>(DEFAULT_HOURS);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!sourceId || !/^[0-9a-f]{64}$/.test(key)) return;
    let cancelled = false;
    void (async () => {
      try {
        const body = await api.get<Envelope>(
          `/api/sources/${encodeURIComponent(sourceId)}/meshcore/hop-snr?publicKey=${key}&hours=${hours}&points=${HOP_SNR_CHART_POINTS}`,
        );
        if (cancelled) return;
        const links = body?.data?.links ?? [];
        setLoaded((prev) => ({ owner, links, seen: links.length > 0 || (prev?.owner === owner && prev.seen) }));
      } catch (e) {
        // No traceroute:read on this source (401/403) or a read error: show
        // nothing new. Read the status off the error, not via `instanceof`.
        const status = (e as { status?: unknown } | null)?.status;
        if (status !== 401 && status !== 403) console.debug('MeshCore trace SNR charts failed to load', e);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId, key, hours, owner]);

  // Put the two directions of a link side by side: group by the far end, in
  // the order the server sent them (newest first), "heard this contact" first.
  const ordered = useMemo(() => {
    const links = loaded?.owner === owner ? loaded.links : [];
    const farEnd = (l: HopSnrLink): string => (l.receiver.publicKey === key ? endId(l.sender) : endId(l.receiver));
    const rank = new Map<string, number>();
    for (const l of links) if (!rank.has(farEnd(l))) rank.set(farEnd(l), rank.size);
    return links
      .map((link, i) => ({ link, i }))
      .sort((a, b) => (rank.get(farEnd(a.link))! - rank.get(farEnd(b.link))!)
        || (Number(a.link.receiver.publicKey === key) - Number(b.link.receiver.publicKey === key))
        || (a.i - b.i))
      .map((x) => x.link);
  }, [loaded, owner, key]);

  // Hidden for another contact's stale data, and until this contact has shown
  // at least one link. After that an empty range keeps the range control.
  if (!loaded || loaded.owner !== owner || !loaded.seen) return null;

  const nameOf = (end: HopSnrEnd): string =>
    hopSnrEndName(end, { contactKey: key, localPublicKey, contacts, t: t as unknown as HopSnrTranslate });

  return (
    <section className={styles.section} data-testid="meshcore-trace-snr-charts">
      <div className={styles.header}>
        <h4 className={styles.title}>
          <UiIcon name="radioSignal" size={15} /> {t('meshcore.trace_snr.charts.title', 'Trace SNR over time')}
        </h4>
        <div className={styles.ranges} role="group" aria-label={t('meshcore.trace_snr.charts.range_label', 'Time range')}>
          {RANGES.map((r) => (
            <button key={r.hours} type="button" aria-pressed={hours === r.hours}
              className={`${styles.rangeBtn} ${hours === r.hours ? styles.rangeBtnActive : ''}`}
              onClick={() => setHours(r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {ordered.length === 0 ? (
        <p className={styles.empty}>{t('meshcore.trace_snr.charts.empty_range', 'No samples in this range.')}</p>
      ) : (
        <div className={styles.grid}>
          {ordered.map((link) => {
            const direction = link.receiver.publicKey === key ? 'in' : 'out';
            const label = t('meshcore.trace_snr.charts.direction', '{{receiver}} heard {{sender}}', {
              receiver: nameOf(link.receiver), sender: nameOf(link.sender),
            });
            const data = hopSnrChartData(link.points);
            const span: [number, number] | null = link.points.length > 0
              ? [link.points[0][0], link.points[link.points.length - 1][0]]
              : null;
            const stroke = direction === 'in' ? 'var(--chart-1)' : 'var(--chart-3)';
            return (
              <div key={`${endId(link.sender)}>${endId(link.receiver)}`} className={styles.chart}
                data-testid="meshcore-trace-snr-chart" data-direction={direction}>
                <div className={styles.chartTitle}>
                  <span className={styles.swatch} aria-hidden="true" />
                  <span className={styles.chartLabel}>{label} (dB)</span>
                </div>
                <div className={styles.meta}>
                  {t('meshcore.trace_snr.charts.stats', 'avg {{avg}} dB · {{min}} to {{max}} · {{count}} samples', {
                    avg: link.avgSnr.toFixed(1), min: link.minSnr.toFixed(1), max: link.maxSnr.toFixed(1), count: link.count,
                  })}
                  {link.count > link.points.length && (
                    <>{' · '}{t('meshcore.trace_snr.charts.capped', 'newest {{shown}} drawn', { shown: link.points.length })}</>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={data} margin={{ top: 5, right: 36, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-surface-hover)" />
                    <XAxis
                      dataKey="timestamp"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tick={{ fontSize: 11 }}
                      minTickGap={24}
                      tickFormatter={(v: number) => formatChartAxisTimestamp(v, span)}
                    />
                    <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} width={40} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--color-surface)',
                        border: '1px solid var(--color-surface-hover)',
                        borderRadius: '4px',
                        fontSize: '0.8em',
                      }}
                      itemStyle={{ color: 'var(--color-text)' }}
                      labelStyle={{ color: 'var(--color-text)' }}
                      labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                      formatter={(v) => {
                        const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
                        return [Number.isFinite(n) ? `${n.toFixed(2)} dB` : '-', label];
                      }}
                    />
                    <Line
                      type="linear"
                      dataKey="snr"
                      stroke={stroke}
                      strokeWidth={2}
                      dot={link.points.length <= DOT_LIMIT ? { fill: stroke, r: 2, strokeWidth: 0 } : false}
                      activeDot={{ r: 4 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
