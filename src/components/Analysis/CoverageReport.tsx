/**
 * CoverageReport — Coverage Report landing view for the RF reception epic
 * (#5277, Phase 1 WP4). Filters (sender, receivers, hops, time range, colour
 * metric) apply immediately — this is a live view over recently-recorded
 * receptions, not a deferred multi-source scan like MqttViolationsReport, so
 * there is no "Run report" gate. A manual Refresh button re-runs the current
 * window instead of polling (spec §2.11).
 *
 * Data flow: `useCoverageReceivers` (the receiver checkbox list + names),
 * `useCoverageSenders` (the sender `<select>`), `useCoverageReceptions` (the
 * paginated reception rows for the map). Reception rows are grouped into
 * fixes with `groupReceptionsIntoFixes` (`src/utils/coverage.ts`, shared with
 * the server) and handed to `CoverageMap`.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import {
  useCoverageReceivers,
  useCoverageSenders,
  useCoverageReceptions,
} from '../../hooks/useCoverageData';
import { groupReceptionsIntoFixes } from '../../utils/coverage';
import type { CoverageMetric } from '../../utils/coverage';
import type { CoverageHopsMode } from '../../types/coverage';
import {
  resolveCoverageWindow,
  type CoverageRangePreset,
  type CoverageWindow,
} from '../../utils/coverageTimeRange';
import { CoverageMap } from './CoverageMap';
import styles from './CoverageReport.module.css';

const RANGE_PRESETS: Array<{ id: Exclude<CoverageRangePreset, 'custom'>; key: string; label: string }> = [
  { id: '1h', key: 'range_1h', label: '1 h' },
  { id: '6h', key: 'range_6h', label: '6 h' },
  { id: '24h', key: 'range_24h', label: '24 h' },
  { id: '3d', key: 'range_3d', label: '3 days' },
  { id: '7d', key: 'range_7d', label: '7 days' },
];

const HOPS_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7];

/** The Meshtastic hop_limit / airtime-cost table (spec §0), shown in the
 *  collapsible setup guidance panel. Multipliers are the spec's own rough
 *  per-fix transmission-count estimates. */
const AIRTIME_ROWS: Array<{ hopLimit: number; txPerFix: string; perHourPct: string }> = [
  { hopLimit: 0, txPerFix: '1', perHourPct: '~2%' },
  { hopLimit: 1, txPerFix: '2-4', perHourPct: '~4-8%' },
  { hopLimit: 3, txPerFix: '4-8', perHourPct: '~8-16%' },
];

export const CoverageReport: React.FC = () => {
  const { t } = useTranslation();

  const [preset, setPreset] = useState<CoverageRangePreset>('24h');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [senderId, setSenderId] = useState<string>('');
  const [deselectedReceiverIds, setDeselectedReceiverIds] = useState<Set<string>>(new Set());
  const [hops, setHops] = useState<number | ''>('');
  const [hopsMode, setHopsMode] = useState<CoverageHopsMode>('exact');
  const [metric, setMetric] = useState<CoverageMetric>('snr');
  const [guidanceOpen, setGuidanceOpen] = useState(false);

  // Resolved ONCE per discrete user action (mount / preset click / custom
  // "Apply" / Refresh) via `resolveCoverageWindow`, and cached in state —
  // NEVER recomputed from `Date.now()` during a plain render. See
  // `coverageTimeRange.ts`'s doc comment: an earlier version computed
  // sinceMs/untilMs inline on every render, which fed a numerically
  // different value into the TanStack Query key on every render and caused
  // an endless refetch loop (#5277 browser-validation regression) that kept
  // Refresh permanently disabled and the map never rendering. The lazy
  // `useState` initializer runs exactly once, at mount.
  const [timeWindow, setTimeWindow] = useState<CoverageWindow>(() =>
    resolveCoverageWindow('24h', Date.now()),
  );
  const { sinceMs, untilMs, rangeInvalid } = timeWindow;

  const selectPreset = (id: Exclude<CoverageRangePreset, 'custom'>) => {
    setPreset(id);
    setTimeWindow(resolveCoverageWindow(id, Date.now()));
  };

  /** Switches the UI to the custom from/to inputs WITHOUT resolving a new
   *  window — the window only changes once the user presses Apply, so
   *  merely opening the custom picker can't itself trigger a fetch. */
  const selectCustomPreset = () => {
    setPreset('custom');
  };

  const applyCustomRange = () => {
    setTimeWindow(resolveCoverageWindow('custom', Date.now(), customFrom, customTo));
  };

  const receiversQuery = useCoverageReceivers([]);
  const sendersQuery = useCoverageSenders({ sources: [], sinceMs, untilMs });

  // senderId -> best display name, for CoverageMap's fix popup header.
  // Receptions/receivers carry no name; `/senders` is the only endpoint
  // that does.
  const senderNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sendersQuery.data?.senders ?? []) {
      const name = s.longName || s.shortName;
      if (name) map.set(s.senderId, name);
    }
    return map;
  }, [sendersQuery.data]);

  const receivers = useMemo(() => receiversQuery.data?.receivers ?? [], [receiversQuery.data]);
  const allReceiverIds = useMemo(() => receivers.map((r) => r.receiverId), [receivers]);
  const selectedReceiverIds = useMemo(
    () => allReceiverIds.filter((id) => !deselectedReceiverIds.has(id)),
    [allReceiverIds, deselectedReceiverIds],
  );
  const noReceiversSelected = allReceiverIds.length > 0 && selectedReceiverIds.length === 0;
  const allReceiversSelected = selectedReceiverIds.length === allReceiverIds.length;

  const receptionsEnabled = !rangeInvalid && !noReceiversSelected;
  const receptionsQuery = useCoverageReceptions(
    {
      sources: [],
      sinceMs,
      untilMs,
      receiverIds: allReceiversSelected ? undefined : selectedReceiverIds,
      senderId: senderId || undefined,
      hops: hops === '' ? undefined : hops,
      hopsMode,
    },
    receptionsEnabled,
  );

  const items = useMemo(() => receptionsQuery.data?.items ?? [], [receptionsQuery.data]);
  const fixes = useMemo(() => groupReceptionsIntoFixes(items, metric), [items, metric]);

  // Identifies the current filter set for CoverageMap's fit-once-per-filter
  // behaviour. Deliberately excludes sinceMs/untilMs (the resolved window) —
  // those shift on every Refresh even when the filters themselves didn't
  // change (a preset re-anchors to "now"), and Refresh must never yank the
  // map out from under a user who has since panned/zoomed. `preset` plus the
  // custom from/to inputs capture "which range the user picked" without the
  // refresh-anchor noise.
  const fitKey = useMemo(() => {
    const receiversPart = allReceiversSelected ? 'all' : [...selectedReceiverIds].sort().join(',');
    const rangePart = preset === 'custom' ? `custom:${customFrom}:${customTo}` : preset;
    return `${senderId}|${receiversPart}|${hops}|${hopsMode}|${rangePart}`;
  }, [senderId, selectedReceiverIds, allReceiversSelected, hops, hopsMode, preset, customFrom, customTo]);

  const isLoading = receiversQuery.isLoading || sendersQuery.isLoading || receptionsQuery.isLoading;
  const isEmpty = receptionsEnabled && !isLoading && items.length === 0;
  const retentionDays = receiversQuery.data?.retentionDays;

  const toggleReceiver = (id: string) => {
    setDeselectedReceiverIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRefresh = () => {
    // Re-anchors the window to "now" (a preset window slides forward; a
    // custom range is re-validated against its current from/to inputs).
    // That alone changes sinceMs/untilMs, which changes the senders' and
    // receptions' query keys, which TanStack Query fetches automatically —
    // do NOT also call .refetch() on those two here: combined with the key
    // change, an explicit refetch double-fires them (one fetch for the old
    // key via .refetch(), one for the new key from the key change), which
    // is exactly the bug this file's regression test guards against.
    // `receiversQuery`'s key never depends on the time window, so it needs
    // its own explicit refetch to actually do anything on Refresh.
    setTimeWindow(resolveCoverageWindow(preset, Date.now(), customFrom, customTo));
    void receiversQuery.refetch();
  };

  return (
    <>
      <div>
        <h2 className="reports-section__title">
          <UiIcon name="radioSignal" size={22} />
          {t('analysis.coverage.title', 'Coverage Report')}
        </h2>
        <p className="reports-section__subtitle">
          {t(
            'analysis.coverage.description',
            'Map RF receptions of position packets — how far your mesh actually reaches, and how well each receiver hears it. Built from a survey node driving your coverage area, not sent by MeshMonitor.',
          )}
        </p>
      </div>

      <div className="reports-panel">
        <div className="reports-controls">
          <div className="reports-controls__field">
            <span>{t('analysis.coverage.time_range', 'Time range')}</span>
            <div>
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`reports-btn reports-btn--ghost${preset === p.id ? ` ${styles.activePreset}` : ''}`}
                  onClick={() => selectPreset(p.id)}
                >
                  {t(`analysis.coverage.${p.key}`, p.label)}
                </button>
              ))}
              <button
                type="button"
                className={`reports-btn reports-btn--ghost${preset === 'custom' ? ` ${styles.activePreset}` : ''}`}
                onClick={selectCustomPreset}
              >
                {t('analysis.coverage.range_custom', 'Custom')}
              </button>
            </div>
          </div>

          {preset === 'custom' && (
            <>
              <label className="reports-controls__field">
                <span>{t('analysis.coverage.from', 'From')}</span>
                <input
                  type="datetime-local"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </label>
              <label className="reports-controls__field">
                <span>{t('analysis.coverage.to', 'To')}</span>
                <input
                  type="datetime-local"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </label>
              <button type="button" className="reports-btn reports-btn--ghost" onClick={applyCustomRange}>
                {t('analysis.coverage.range_apply', 'Apply')}
              </button>
            </>
          )}

          <label className={`reports-controls__field ${styles.senderField}`}>
            <span>{t('analysis.coverage.sender', 'Sender')}</span>
            <select value={senderId} onChange={(e) => setSenderId(e.target.value)}>
              <option value="">{t('analysis.coverage.sender_all', 'All')}</option>
              {(sendersQuery.data?.senders ?? []).map((s) => {
                const label = s.longName || s.shortName || s.senderId;
                return (
                  <option key={s.senderId} value={s.senderId}>
                    {label} ({s.senderId}) — {s.fixCount}
                  </option>
                );
              })}
            </select>
          </label>

          <label className="reports-controls__field">
            <span>{t('analysis.coverage.hops', 'Hops')}</span>
            <select
              value={hops}
              onChange={(e) => setHops(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <option value="">{t('analysis.coverage.hops_any', 'Any')}</option>
              {HOPS_OPTIONS.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>

          {hops !== '' && (
            <label className="reports-controls__field">
              <input
                type="checkbox"
                checked={hopsMode === 'max'}
                onChange={(e) => setHopsMode(e.target.checked ? 'max' : 'exact')}
              />
              {t('analysis.coverage.hops_up_to', 'Up to this many hops')}
            </label>
          )}

          <label className="reports-controls__field">
            <span>{t('analysis.coverage.metric', 'Colour by')}</span>
            <select value={metric} onChange={(e) => setMetric(e.target.value as CoverageMetric)}>
              <option value="snr">{t('analysis.coverage.metric_snr', 'SNR')}</option>
              <option value="rssi">{t('analysis.coverage.metric_rssi', 'RSSI')}</option>
            </select>
          </label>

          <button type="button" className="reports-btn" onClick={handleRefresh} disabled={isLoading}>
            <UiIcon name="refresh" size={14} />
            {t('analysis.coverage.refresh', 'Refresh')}
          </button>
        </div>

        {receivers.length > 0 && (
          <div className={styles.receiverList}>
            <div className={styles.receiverListTitle}>
              {t('analysis.coverage.receivers', 'Receivers')}
            </div>
            {receivers.map((r) => (
              <label key={`${r.sourceId}-${r.receiverId}`} className={styles.receiverItem}>
                <input
                  type="checkbox"
                  checked={!deselectedReceiverIds.has(r.receiverId)}
                  onChange={() => toggleReceiver(r.receiverId)}
                />
                {r.longName || r.shortName || r.receiverId}
              </label>
            ))}
          </div>
        )}

        {retentionDays != null && (
          <div className={styles.retentionNote}>
            {t('analysis.coverage.retention_note', 'Data kept {{days}} days.', { days: retentionDays })}
          </div>
        )}
      </div>

      {rangeInvalid && (
        <div className="reports-banner reports-banner--error">
          {t('analysis.coverage.range_error', 'The start time must be on or before the end time.')}
        </div>
      )}

      {noReceiversSelected && (
        <div className="reports-banner reports-banner--error">
          {t('analysis.coverage.no_receivers_selected', 'Select at least one receiver.')}
        </div>
      )}

      {receptionsQuery.data?.truncated && (
        <div className="reports-banner reports-banner--warning">
          {t(
            'analysis.coverage.truncated',
            'Showing the first {{count}} receptions in this window — narrow the time range or filters to see the rest.',
            { count: items.length },
          )}
        </div>
      )}

      {isEmpty && (
        <div className="reports-banner reports-banner--empty">
          <div>
            {t(
              'analysis.coverage.empty',
              'No RF receptions in this window.',
            )}
          </div>
          <div className="reports-banner__hint">
            {t(
              'analysis.coverage.empty_hint',
              'Only live RF receptions recorded since this feature shipped appear here — there is no backfill from before the upgrade. Drive a route with a survey node broadcasting position while your mesh node is running to populate this report.',
            )}
          </div>
        </div>
      )}

      {receptionsEnabled && !isLoading && !isEmpty && items.length > 0 && (
        <CoverageMap
          fixes={fixes}
          receivers={receivers}
          metric={metric}
          senderNames={senderNames}
          fitKey={fitKey}
        />
      )}

      <div className="reports-panel">
        <button
          type="button"
          className="reports-btn reports-btn--ghost"
          onClick={() => setGuidanceOpen((o) => !o)}
          aria-expanded={guidanceOpen}
        >
          <UiIcon name={guidanceOpen ? 'chevronUp' : 'chevronDown'} size={14} />
          {t('analysis.coverage.guidance_toggle', 'Setup guidance')}
        </button>
        {guidanceOpen && (
          <div className={styles.guidance}>
            <p>
              {t(
                'analysis.coverage.guidance_recommend',
                'Recommended survey-node settings: hop_limit 0, smart position enabled (it honours hop_limit 0), and a position interval of 30 seconds or more.',
              )}
            </p>
            <p>
              {t(
                'analysis.coverage.guidance_firmware_caveat',
                'Receiver firmware caveat: a receiving node only keeps a zero-hop (hop_limit 0) packet on firmware 2.7.20 or later — older firmware drops packets with hop_start == 0 before decrypting them. If any receiver in your mesh runs older firmware, use hop_limit 1 instead. Direct copies still show as 0 hops, but each neighbour rebroadcasts once, which costs more airtime.',
              )}
            </p>
            <table className={styles.airtimeTable}>
              <thead>
                <tr>
                  <th>{t('analysis.coverage.guidance_col_hop_limit', 'hop_limit')}</th>
                  <th>{t('analysis.coverage.guidance_col_tx_per_fix', 'Tx per fix')}</th>
                  <th>{t('analysis.coverage.guidance_col_pct_per_hour', '% of channel/hour (30s interval)')}</th>
                </tr>
              </thead>
              <tbody>
                {AIRTIME_ROWS.map((row) => (
                  <tr key={row.hopLimit}>
                    <td>{row.hopLimit}</td>
                    <td>{row.txPerFix}</td>
                    <td>{row.perHourPct}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.guidanceFooter}>
              {t(
                'analysis.coverage.guidance_no_send',
                'MeshMonitor sends nothing for this report and never changes the survey node — it only records position packets the node already received.',
              )}
            </p>
          </div>
        )}
      </div>
    </>
  );
};

export default CoverageReport;
