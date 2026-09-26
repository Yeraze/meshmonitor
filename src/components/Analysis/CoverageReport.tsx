/**
 * CoverageReport — Coverage Report landing view for the RF reception epic
 * (#5277, Phase 1 WP4; gaps/summary/grid/export/deep-link wired in P4a
 * WP4, COVERAGE_P4_SPEC.md §2a.7). Filters (sender, receivers, hops, time
 * range, colour metric, dots/grid view) apply immediately — this is a live
 * view over recently-recorded receptions, not a deferred multi-source scan
 * like MqttViolationsReport, so there is no "Run report" gate. A manual
 * Refresh button re-runs the current window instead of polling (spec
 * §2.11).
 *
 * Data flow: `useCoverageReceivers` (the receiver checkbox list + names),
 * `useCoverageSenders` (the sender picker), `useCoverageReceptions` (the
 * paginated reception rows for the map). Reception rows are grouped into
 * fixes with `groupReceptionsIntoFixes` (`src/utils/coverage.ts`, shared with
 * the server) and handed to `CoverageMap`, plus the P4a pure analysis
 * functions (`coverageGaps`/`coverageSummary`/`coverageGrid`, WP1) that turn
 * those same fixes/items into gap lines, the summary panel and the grid
 * view. `initialLink` seeds the sender + range once at mount from a
 * `/reports?report=coverage&…` deep link (AnalysisTab, WP4 + ShowCoverageLink,
 * WP5) — never re-applied after mount, same rule as the query-stability fix
 * on `timeWindow` below.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import {
  useCoverageReceivers,
  useCoverageSenders,
  useCoverageReceptions,
} from '../../hooks/useCoverageData';
import { useCoverageSurveys } from '../../hooks/useCoverageSurveys';
import {
  groupReceptionsIntoFixes,
  formatCoverageNodeId,
  effectiveSurveyEndAt,
  COVERAGE_GRID_CELL_SIZES_M,
  COVERAGE_GRID_DEFAULT_CELL_M,
  isMeshCorePubKeyId,
} from '../../utils/coverage';
import type { CoverageMetric } from '../../utils/coverage';
import type { CoverageHopsMode, CoverageSurveyDto } from '../../types/coverage';
import {
  buildReceiverQuery,
  deselectedFromReceiverFilter,
  encodeReceiverFilter,
  receiverKey,
} from '../../utils/coverageReceiverFilter';
import {
  resolveCoverageWindow,
  type CoverageRangePreset,
  type CoverageWindow,
} from '../../utils/coverageTimeRange';
import { detectCoverageGaps } from '../../utils/coverageGaps';
import { summarizeCoverage } from '../../utils/coverageSummary';
import { binFixesToGrid } from '../../utils/coverageGrid';
import type {
  CoverageDeepLink,
  CoverageExportContext,
  CoverageGridCellSizeM,
  CoverageMapView,
  GapFixInput,
} from '../../types/coverageAnalysis';
import { useSettings } from '../../contexts/SettingsContext';
import { CoverageMap } from './CoverageMap';
import { CoverageReceiverFilter } from './CoverageReceiverFilter';
import { CoverageSummaryPanel } from './CoverageSummaryPanel';
import { CoverageDistanceChart } from './CoverageDistanceChart';
import { CoverageExportButtons } from './CoverageExportButtons';
import { CoverageSurveyBar } from './CoverageSurveyBar';
import SearchableSelect, { type SearchableSelectOption } from '../common/SearchableSelect';
import styles from './CoverageReport.module.css';

const RANGE_PRESETS: Array<{ id: Exclude<CoverageRangePreset, 'custom'>; key: string; label: string }> = [
  { id: '1h', key: 'range_1h', label: '1 h' },
  { id: '6h', key: 'range_6h', label: '6 h' },
  { id: '24h', key: 'range_24h', label: '24 h' },
  { id: '3d', key: 'range_3d', label: '3 days' },
  { id: '7d', key: 'range_7d', label: '7 days' },
];

// 8 = MeshCore's advert flood limit (`flood_max_advert`, COVERAGE_P3_SPEC.md
// §0.2) — one hop past Meshtastic's own max of 7, so a MeshCore multi-hop
// advert always has a value on this list (#5277 P3 WP3, spec §2.6).
const HOPS_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** The Meshtastic hop_limit / airtime-cost table (spec §0), shown in the
 *  collapsible setup guidance panel. Multipliers are the spec's own rough
 *  per-fix transmission-count estimates. */
const AIRTIME_ROWS: Array<{ hopLimit: number; txPerFix: string; perHourPct: string }> = [
  { hopLimit: 0, txPerFix: '1', perHourPct: '~2%' },
  { hopLimit: 1, txPerFix: '2-4', perHourPct: '~4-8%' },
  { hopLimit: 3, txPerFix: '4-8', perHourPct: '~8-16%' },
];

/** MeshCore per-advert airtime table (COVERAGE_P3_SPEC.md §0.3), shown in a
 *  MeshCore-specific block in the setup guidance panel below the Meshtastic
 *  table. Advert size ranges 111-135 bytes (short name to a full 32-char
 *  name); figures are the spec's own Semtech-formula computations. */
const MESHCORE_AIRTIME_ROWS: Array<{ preset: string; b111: string; b123: string; b135: string }> = [
  { preset: 'US/Canada 910.525 MHz, SF7 BW62.5 CR5', b111: '396 ms', b123: '426 ms', b135: '467 ms' },
  { preset: 'EU/UK narrow, SF8 BW62.5 CR8', b111: '1.07 s', b123: '1.16 s', b135: '1.26 s' },
  { preset: 'Legacy EU, SF11 BW250 CR5', b111: '1.09 s', b123: '1.17 s', b135: '1.26 s' },
];

export interface CoverageReportProps {
  /**
   * Seeds the sender filter and time-range preset once at mount from a
   * `/reports?report=coverage&sender=…&range=…` deep link (AnalysisTab's
   * `useSearchParams` + `parseCoverageDeepLink`, WP4; `ShowCoverageLink`,
   * WP5). Read ONLY in the lazy `useState` initializers below — never
   * re-applied on a prop change after mount. Same rule as `timeWindow`
   * (see its comment): re-deriving from a prop on every render is exactly
   * the shape of the #5277 query-stability regression, just one hop
   * removed (a prop that changes identity every render would be just as
   * bad as `Date.now()` computed inline).
   */
  initialLink?: CoverageDeepLink;
}

export const CoverageReport: React.FC<CoverageReportProps> = ({ initialLink }) => {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();

  const [preset, setPreset] = useState<CoverageRangePreset>(() => initialLink?.range ?? '24h');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [senderId, setSenderId] = useState<string>(() => initialLink?.sender ?? '');
  const [deselectedReceiverIds, setDeselectedReceiverIds] = useState<Set<string>>(new Set());
  const [hops, setHops] = useState<number | ''>('');
  const [hopsMode, setHopsMode] = useState<CoverageHopsMode>('exact');
  const [metric, setMetric] = useState<CoverageMetric>('snr');
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [view, setView] = useState<CoverageMapView>('dots');
  const [cellSize, setCellSize] = useState<CoverageGridCellSizeM>(COVERAGE_GRID_DEFAULT_CELL_M);

  // Saved surveys (#5277 P4b WP3, spec §2b.7). `selectedSurvey` holds the
  // FULL DTO, not just an id looked up from `surveysQuery` below, on
  // purpose: `applySurvey` (and the bar's Start/Save/Stop/Edit onSuccess
  // callbacks, which also call back through `onSelectSurvey`) always hand
  // this the freshest row directly, and `surveysQuery`'s own cache can lag
  // one refetch behind a just-created/just-mutated row (its invalidation is
  // async). Deriving `selectedSurvey` by re-looking the id up in
  // `surveysQuery.data` would momentarily lose `intervalSec`/`isLive`/etc.
  // right after Start or Save, before that refetch lands. A manual sender or
  // window change clears it (see the wrapped setters further down), matching
  // "picking a survey applies it; changing anything by hand detaches it"
  // (spec §2b.7).
  //
  // Starts `null`, even with a `survey=` deep link — NOT the deep-linked id
  // itself. The survey list has to load first to know whether that id is
  // real; the effect below is what sets this once it's confirmed to exist,
  // same "seed once, from confirmed data" rule as the sender synthetic-
  // option handling above, just one tick later than a lazy `useState` can
  // reach (the list is a network fetch, not a prop already in hand).
  const [selectedSurvey, setSelectedSurvey] = useState<CoverageSurveyDto | null>(null);
  const selectedSurveyId = selectedSurvey?.id ?? null;
  const appliedInitialSurveyRef = useRef(false);

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
    resolveCoverageWindow(initialLink?.range ?? '24h', Date.now()),
  );
  const { sinceMs, untilMs, rangeInvalid } = timeWindow;

  // A manual range or sender change is "changing the window/sender by hand"
  // (spec §2b.7) — it detaches whatever survey is currently applied. This
  // does NOT run when `applySurvey` itself sets these (it sets
  // `selectedSurveyId` directly, never through these wrapped setters).
  const selectPreset = (id: Exclude<CoverageRangePreset, 'custom'>) => {
    setPreset(id);
    setTimeWindow(resolveCoverageWindow(id, Date.now()));
    setSelectedSurvey(null);
  };

  /** Switches the UI to the custom from/to inputs WITHOUT resolving a new
   *  window — the window only changes once the user presses Apply, so
   *  merely opening the custom picker can't itself trigger a fetch (and
   *  doesn't detach a selected survey either). */
  const selectCustomPreset = () => {
    setPreset('custom');
  };

  const applyCustomRange = () => {
    setTimeWindow(resolveCoverageWindow('custom', Date.now(), customFrom, customTo));
    setSelectedSurvey(null);
  };

  const handleSenderChange = useCallback((id: string) => {
    setSenderId(id);
    setSelectedSurvey(null);
  }, []);

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

  // Options for the sender SearchableSelect (spec §2a.7). A deep-linked (or
  // otherwise already-selected) sender absent from `/senders` — no fixes in
  // the current window — still gets a synthetic option with its formatted
  // id so the current value never silently vanishes from the picker.
  const senderOptions = useMemo<SearchableSelectOption[]>(() => {
    const senders = sendersQuery.data?.senders ?? [];
    const options: SearchableSelectOption[] = senders.map((s) => {
      const displaySenderId = formatCoverageNodeId(s.senderId);
      const label = s.longName || s.shortName || displaySenderId;
      return {
        value: s.senderId,
        label: `${label} (${displaySenderId}) — ${s.fixCount}`,
        keywords: [s.longName, s.shortName, s.senderId].filter(Boolean).join(' '),
      };
    });
    if (senderId && !senders.some((s) => s.senderId === senderId)) {
      options.push({
        value: senderId,
        label: formatCoverageNodeId(senderId),
        keywords: senderId,
      });
    }
    return options;
  }, [sendersQuery.data, senderId]);

  const receivers = useMemo(() => receiversQuery.data?.receivers ?? [], [receiversQuery.data]);
  const mqttSources = useMemo(() => receiversQuery.data?.mqttSources ?? [], [receiversQuery.data]);

  // receiverKey(sourceId, receiverId) -> best display name / sourceId ->
  // sourceName, for the summary table, distance chart and CSV/GeoJSON export
  // (spec §2a.4/§2a.6). Same composite-key convention as
  // `CoverageReceiverFilter`/`CoverageMap`.
  const receiverNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of receivers) {
      const name = r.longName || r.shortName;
      if (name) map.set(receiverKey(r.sourceId, r.receiverId), name);
    }
    return map;
  }, [receivers]);
  const sourceNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of receivers) {
      if (r.sourceName) map.set(r.sourceId, r.sourceName);
    }
    return map;
  }, [receivers]);

  // Source-scoped receiver filter (#5277 P2 §2.5/§2.9), built from the
  // composite-keyed `deselectedReceiverIds` set — carry-over (a): the same
  // receiverId on two different sources toggles independently.
  const receiverQuery = useMemo(
    () =>
      buildReceiverQuery(
        receivers.map((r) => ({ sourceId: r.sourceId, receiverId: r.receiverId })),
        deselectedReceiverIds,
      ),
    [receivers, deselectedReceiverIds],
  );
  const selectedReceiverKeys = useMemo(() => {
    const set = new Set<string>();
    for (const r of receivers) {
      const key = receiverKey(r.sourceId, r.receiverId);
      if (!deselectedReceiverIds.has(key)) set.add(key);
    }
    return set;
  }, [receivers, deselectedReceiverIds]);
  const allReceiversSelected = receivers.length > 0 && selectedReceiverKeys.size === receivers.length;
  const noReceiversSelected = receivers.length > 0 && receiverQuery.noneSelected;

  // Encoded wire form of the CURRENT receiver selection — what "Save as
  // survey" stores on the new row (spec §2b.7: "sender + current window +
  // current receiver filter"). `null` = every receiver, same convention as
  // `CoverageSurveyDto.receivers`. When the picker fell back to
  // `clientSideFilter` (well past the 1000-id / 6000-char cap, spec §2.5),
  // there is no encodable filter to save — the survey is saved with every
  // receiver instead of failing outright; it is a view preference, not a
  // privacy boundary (spec §2b.1).
  const currentReceiversEncoded = useMemo(
    () =>
      receiverQuery.clientSideFilter || !receiverQuery.receiverFilter
        ? null
        : encodeReceiverFilter(receiverQuery.receiverFilter),
    [receiverQuery],
  );

  // Saved surveys (#5277 P4b WP3, spec §2b.7). `surveysQuery` itself is only
  // read here for the deep-link lookup below (and to hand `.refetch` to
  // Refresh) — everyday selection reads/writes go through `selectedSurvey`
  // state above, not this query's cache (see that state's doc comment).
  const surveysQuery = useCoverageSurveys();

  /** Applies a picked/started/saved/stopped survey to the report's own
   *  sender/window/receiver state — the one place all four ever change
   *  together. Sets `selectedSurvey` directly (never through the wrapped
   *  `handleSenderChange`/`selectPreset`/`applyCustomRange` setters above,
   *  which would immediately clear it again). */
  const applySurvey = useCallback(
    (survey: CoverageSurveyDto) => {
      setSelectedSurvey(survey);
      setSenderId(survey.senderId);
      setTimeWindow({
        sinceMs: survey.startAt,
        untilMs: effectiveSurveyEndAt(survey, Date.now()),
        rangeInvalid: false,
      });
      setDeselectedReceiverIds(
        deselectedFromReceiverFilter(
          survey.receivers,
          receivers.map((r) => ({ sourceId: r.sourceId, receiverId: r.receiverId })),
        ),
      );
    },
    [receivers],
  );

  const handleSelectSurvey = useCallback(
    (survey: CoverageSurveyDto | null) => {
      if (!survey) {
        setSelectedSurvey(null);
        return;
      }
      applySurvey(survey);
    },
    [applySurvey],
  );

  // Deep link `survey=<uuid>` (spec §2a.5/§2b.7): applied once, as soon as
  // the survey list has loaded and contains it. Runs at most once per mount
  // (the ref guard) — a survey that no longer exists, or hasn't loaded yet
  // on the first pass, is simply left unapplied rather than retried forever.
  useEffect(() => {
    if (appliedInitialSurveyRef.current) return;
    if (!initialLink?.survey) return;
    if (!surveysQuery.data) return; // still loading
    appliedInitialSurveyRef.current = true;
    const found = surveysQuery.data.find((s) => s.id === initialLink.survey);
    if (found) applySurvey(found);
  }, [initialLink?.survey, surveysQuery.data, applySurvey]);

  const receptionsEnabled = !rangeInvalid && !noReceiversSelected;
  const receptionsQuery = useCoverageReceptions(
    {
      sources: receiverQuery.sources ?? [],
      sinceMs,
      untilMs,
      receiverFilter: receiverQuery.receiverFilter,
      clientSideFilter: receiverQuery.clientSideFilter ? selectedReceiverKeys : undefined,
      senderId: senderId || undefined,
      hops: hops === '' ? undefined : hops,
      hopsMode,
    },
    receptionsEnabled,
  );

  const items = useMemo(() => receptionsQuery.data?.items ?? [], [receptionsQuery.data]);
  const fixes = useMemo(() => groupReceptionsIntoFixes(items, metric), [items, metric]);

  // P4a pure analysis (spec §2a.7) — all derived from `items`/`fixes`
  // that are already privacy-filtered and already-loaded; no new fetch.
  const singleSender = senderId !== '';
  const fixesAsGapInputs = useMemo<GapFixInput[]>(
    () =>
      fixes.map((f) => ({
        packetKey: f.packetKey,
        firstReceivedAt: f.firstReceivedAt,
        latitude: f.latitude,
        longitude: f.longitude,
      })),
    [fixes],
  );
  // Gaps only run for a single sender, so its protocol follows from its id
  // (MeshCore senders are 64-hex public keys), never a source type (spec
  // §2a.2). The gap rule's default interval (30 s vs 60 s) depends on it.
  const protocol = isMeshCorePubKeyId(senderId) ? 'meshcore' : 'meshtastic';
  // A selected survey's configured interval overrides the observed/default
  // estimate (spec §2b.7/§2a.2's `configured` source).
  const configuredIntervalSec = selectedSurvey?.intervalSec ?? undefined;
  const gapResult = useMemo(
    () => (singleSender ? detectCoverageGaps(fixesAsGapInputs, { protocol, configuredIntervalSec }) : null),
    [singleSender, fixesAsGapInputs, protocol, configuredIntervalSec],
  );
  const summary = useMemo(() => summarizeCoverage(items), [items]);
  const gridCells = useMemo(
    () => (view === 'grid' ? binFixesToGrid(fixes, cellSize, metric) : []),
    [view, fixes, cellSize, metric],
  );
  // Tied to when `items` actually changed (a real fetch), not every render —
  // an export timestamp has no query-key implications, but there is no
  // reason to churn it on every keystroke either. `items` isn't read inside
  // the factory; it's the recompute trigger, which exhaustive-deps can't see.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- #5277 P4a WP4: intentional recompute-on-items-change, Date.now() itself has no deps
  const generatedAt = useMemo(() => Date.now(), [items]);
  const exportCtx = useMemo<CoverageExportContext>(
    () => ({
      senderNames,
      receiverNames,
      sourceNames,
      truncated: receptionsQuery.data?.truncated ?? false,
      generatedAt,
      filters: {
        senderId: senderId || null,
        hops: hops === '' ? null : hops,
        hopsMode,
        metric,
      },
    }),
    [
      senderNames,
      receiverNames,
      sourceNames,
      receptionsQuery.data?.truncated,
      generatedAt,
      senderId,
      hops,
      hopsMode,
      metric,
    ],
  );

  // Identifies the current filter set for CoverageMap's fit-once-per-filter
  // behaviour. Deliberately excludes sinceMs/untilMs (the resolved window) —
  // those shift on every Refresh even when the filters themselves didn't
  // change (a preset re-anchors to "now"), and Refresh must never yank the
  // map out from under a user who has since panned/zoomed. `preset` plus the
  // custom from/to inputs capture "which range the user picked" without the
  // refresh-anchor noise.
  const fitKey = useMemo(() => {
    const receiversPart = allReceiversSelected ? 'all' : [...selectedReceiverKeys].sort().join(',');
    const rangePart = preset === 'custom' ? `custom:${customFrom}:${customTo}` : preset;
    return `${senderId}|${receiversPart}|${hops}|${hopsMode}|${rangePart}`;
  }, [senderId, selectedReceiverKeys, allReceiversSelected, hops, hopsMode, preset, customFrom, customTo]);

  const isLoading = receiversQuery.isLoading || sendersQuery.isLoading || receptionsQuery.isLoading;
  const isEmpty = receptionsEnabled && !isLoading && items.length === 0;
  const retentionDays = receiversQuery.data?.retentionDays;
  const hasMqttReceivers = useMemo(
    () => receivers.some((r) => r.receiverKind === 'mqtt_gateway') || mqttSources.length > 0,
    [receivers, mqttSources],
  );

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
    // its own explicit refetch to actually do anything on Refresh — same
    // reasoning applies to `surveysQuery` (#5277 P4b WP3).
    //
    // A selected LIVE survey re-anchors to its own effective end (spec
    // §2b.7: "live -> now at resolve time; Refresh re-anchors") instead of
    // the preset — its `startAt` never moves, only how far `effectiveEndAt`
    // has crept since it was last resolved.
    if (selectedSurvey) {
      setTimeWindow({
        sinceMs: selectedSurvey.startAt,
        untilMs: effectiveSurveyEndAt(selectedSurvey, Date.now()),
        rangeInvalid: false,
      });
    } else {
      setTimeWindow(resolveCoverageWindow(preset, Date.now(), customFrom, customTo));
    }
    void receiversQuery.refetch();
    void surveysQuery.refetch();
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
            <SearchableSelect
              value={senderId}
              onChange={handleSenderChange}
              options={senderOptions}
              emptyLabel={t('analysis.coverage.sender_all', 'All')}
              placeholder={t('analysis.coverage.sender_search_placeholder', 'Search senders')}
              noMatchesText={t('analysis.coverage.sender_no_matches', 'No matching senders')}
              ariaLabel={t('analysis.coverage.sender', 'Sender')}
            />
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

          <div className="reports-controls__field">
            <span>{t('analysis.coverage.view', 'View')}</span>
            <div className={styles.viewToggle}>
              <button
                type="button"
                className={`reports-btn reports-btn--ghost${view === 'dots' ? ` ${styles.activePreset}` : ''}`}
                aria-pressed={view === 'dots'}
                onClick={() => setView('dots')}
              >
                {t('analysis.coverage.view_dots', 'Dots')}
              </button>
              <button
                type="button"
                className={`reports-btn reports-btn--ghost${view === 'grid' ? ` ${styles.activePreset}` : ''}`}
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                {t('analysis.coverage.view_grid', 'Grid')}
              </button>
            </div>
          </div>

          {view === 'grid' && (
            <label className="reports-controls__field">
              <span>{t('analysis.coverage.cell_size', 'Cell size')}</span>
              <select
                value={cellSize}
                onChange={(e) => setCellSize(Number(e.target.value) as CoverageGridCellSizeM)}
              >
                {COVERAGE_GRID_CELL_SIZES_M.map((size) => (
                  <option key={size} value={size}>
                    {size} m
                  </option>
                ))}
              </select>
            </label>
          )}

          <button type="button" className="reports-btn" onClick={handleRefresh} disabled={isLoading}>
            <UiIcon name="refresh" size={14} />
            {t('analysis.coverage.refresh', 'Refresh')}
          </button>

          <CoverageExportButtons
            items={items}
            gaps={gapResult?.gaps ?? []}
            ctx={exportCtx}
            senderId={senderId || null}
            sinceMs={sinceMs}
            untilMs={untilMs}
            disabled={items.length === 0}
          />
        </div>

        <CoverageSurveyBar
          senderId={senderId}
          senderLabel={senderId ? (senderNames.get(senderId) ?? formatCoverageNodeId(senderId)) : ''}
          currentSinceMs={sinceMs}
          currentUntilMs={untilMs}
          currentReceiversEncoded={currentReceiversEncoded}
          selectedSurveyId={selectedSurveyId}
          onSelectSurvey={handleSelectSurvey}
        />

        <CoverageReceiverFilter
          receivers={receivers}
          deselected={deselectedReceiverIds}
          onChange={setDeselectedReceiverIds}
          mqttSources={mqttSources}
        />

        {hasMqttReceivers && (
          <div className={styles.mqttNote}>
            {t(
              'analysis.coverage.mqtt_note',
              "Gateway receptions come from what each gateway itself reports over MQTT — nodes with \"OK to MQTT\" turned off won't appear.",
            )}
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
            'Showing the first {{count}} receptions in this window — narrow the time range or pick a sender to see the rest.',
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
              'Only live RF receptions recorded since this feature shipped appear here — there is no backfill from before the upgrade. Drive a route with a survey node broadcasting position while your mesh node is running to populate this report. MQTT gateway sources only start recording once their per-source Coverage recording toggle is turned on.',
            )}
          </div>
          <div className="reports-banner__hint">
            {t(
              'analysis.coverage.empty_hint_meshcore',
              'MeshCore companions record signed adverts that carry a position.',
            )}
          </div>
        </div>
      )}

      {receptionsEnabled && !isLoading && !isEmpty && items.length > 0 && (
        <>
          <CoverageMap
            fixes={fixes}
            receivers={receivers}
            metric={metric}
            senderNames={senderNames}
            fitKey={fitKey}
            gaps={gapResult?.gaps}
            view={view}
            gridCells={gridCells}
          />
          <CoverageSummaryPanel
            summary={summary}
            gapResult={gapResult}
            receivers={receivers}
            distanceUnit={distanceUnit}
            truncated={receptionsQuery.data?.truncated ?? false}
          />
          <CoverageDistanceChart
            points={summary.distancePoints}
            receiverNames={receiverNames}
            distanceUnit={distanceUnit}
          />
        </>
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

            {/* MeshCore block (#5277 P3 WP3, spec §2.6 / user decision U2):
               a survey advert is a manual, one-shot broadcast, not a timed
               background send like Meshtastic's position packets — so the
               guidance here is about HOW to send one safely, not a setting
               to change on the node. */}
            <h4 className={styles.guidanceSubheading}>
              {t('analysis.coverage.meshcore_guidance_title', 'MeshCore')}
            </h4>
            <p>
              {t(
                'analysis.coverage.meshcore_guidance_zero_hop',
                'Send zero-hop adverts only, one every 60 seconds or slower. Never flood adverts for a survey: every repeater within 8 hops repeats each flood advert.',
              )}
            </p>
            <p>
              {t(
                'analysis.coverage.meshcore_guidance_how_to_send',
                'To send a zero-hop advert: in the companion app, use its advert action and pick the zero-hop option, not flood. On a repeater used as a survey node, use the CLI command advert.zerohop, not advert (which floods).',
              )}
            </p>
            <p>
              {t(
                'analysis.coverage.meshcore_guidance_button_floods',
                "MeshMonitor's own Send advert button floods. Don't use it for surveys.",
              )}
            </p>
            <p>
              {t(
                'analysis.coverage.meshcore_guidance_stored_position',
                "An advert carries the node's stored advert position, not a live GPS fix. Update the node's location before each advert.",
              )}
            </p>
            <table className={styles.airtimeTable}>
              <thead>
                <tr>
                  <th>{t('analysis.coverage.meshcore_guidance_col_preset', 'Preset')}</th>
                  <th>{t('analysis.coverage.meshcore_guidance_col_111', '111 B')}</th>
                  <th>{t('analysis.coverage.meshcore_guidance_col_123', '123 B')}</th>
                  <th>{t('analysis.coverage.meshcore_guidance_col_135', '135 B')}</th>
                </tr>
              </thead>
              <tbody>
                {MESHCORE_AIRTIME_ROWS.map((row) => (
                  <tr key={row.preset}>
                    <td>{row.preset}</td>
                    <td>{row.b111}</td>
                    <td>{row.b123}</td>
                    <td>{row.b135}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              {t(
                'analysis.coverage.meshcore_guidance_survey_pct',
                'A survey sending one zero-hop advert every 60 seconds uses about 0.7% of the local channel on the US preset, up to 1.9% on EU narrow.',
              )}
            </p>
            <p className={styles.guidanceFooter}>
              {t(
                'analysis.coverage.meshcore_guidance_repeaters_auto',
                "Repeaters' own adverts are recorded automatically. MeshMonitor never sends adverts for you.",
              )}
            </p>

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
