/**
 * MqttViolationsReport — ok_to_mqtt violation gateway summary report (#4114 Phase 3).
 *
 * Scans every MQTT source the current user can read for gateways that
 * relayed another node's packet to MQTT despite the sender opting out
 * (ok_to_mqtt = 0). Confirmed violations come from the durable
 * `mqtt_ok_to_mqtt_violations` table; optionally, unproven "suspected" rows
 * (bit unreadable) can be included from the MQTT packet monitor's log.
 *
 * Backend contract (Phase 1, #4114):
 *  - GET /api/analysis/mqtt-violations/gateways -> { success, data: ViolationGatewaysResponse }
 *  - GET /api/analysis/mqtt-violations/packets  -> { success, data: ViolationPacketsResponse } (WP3)
 * `ApiService.request()` returns the raw envelope and does NOT unwrap `data`
 * (CLAUDE.md gotcha) — every call here reads `body.data` explicitly.
 *
 * This is a multi-source scan, so it is deferred: nothing is queried until
 * the user presses "Run report" (MQTT_OK_TO_MQTT_PHASE3_SPEC.md §2(e)).
 * Editing the window or the "include unproven" toggle only edits a draft;
 * sort/page/page-size changes are cheap refinements of an already-consented
 * scan and apply immediately (same spec, §2(e)).
 *
 * `suspectedAvailable`/`suspectedWindowMs` are only meaningful when the
 * response echoes `includeUnknown === true` — see §2(a.2). Never read them
 * off local toggle state.
 *
 * Drill-down (WP3, §2(b)): clicking a gateway row expands an inline detail
 * row — single-open accordion — that independently sorts/paginates the raw
 * packets for that one gateway, sharing only the window/toggle filters with
 * the summary. It reuses the Phase 2 `okToMqttState()`/`MqttOkToMqttMarker`
 * primitives via the `kind` -> fields adapter (§2(a.3)) and never recomputes
 * `relayed` itself. CSV export (§2(d)) re-fetches the *whole* filtered
 * result set (capped at `API_SCAN_CAP`, the same ceiling the server
 * enforces) rather than exporting only the current page, and always
 * surfaces the cap to the user instead of silently truncating.
 */
import { Fragment, useMemo, useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api, { ApiError } from '../../services/api';
import { UiIcon } from '../icons';
import { useToast } from '../ToastContainer';
import { okToMqttState } from '../MQTT/okToMqttState';
import MqttOkToMqttMarker from '../MQTT/MqttOkToMqttMarker';
// The reused MqttOkToMqttMarker renders .mqpm-* classes from this sheet, which is
// otherwise imported only by MqttPacketMonitorView. Importing it here is cheaper and
// safer than duplicating the badge styles into a module (#4114 Phase 3 §2(a.3)).
import '../MQTT/MqttPacketMonitor.css';
import {
  API_SCAN_CAP,
  DEFAULT_VIOLATION_FILTERS,
  buildViolationParams,
  formatNodeRef,
  formatSuspectedWindow,
  type SortDir,
  type ViolationFilters,
  type ViolationGatewayRow,
  type ViolationGatewaySortField,
  type ViolationGatewaysResponse,
  type ViolationPacketSortField,
  type ViolationPacketsResponse,
} from './mqttViolationTypes';
import {
  buildGatewaysCsv,
  buildPacketsCsv,
  gatewaysCsvFilename,
  packetsCsvFilename,
} from './mqttViolationsCsv';
import { downloadTextFile } from '../../utils/nodeExport';
import styles from './MqttViolationsReport.module.css';

type TFn = ReturnType<typeof useTranslation>['t'];

const PAGE_SIZES = [25, 50, 100, 250];

const LOOKBACK_PRESETS: Array<{ days: number; key: string; label: string }> = [
  { days: 1, key: 'lookback_1d', label: '24 h' },
  { days: 7, key: 'lookback_7d', label: '7 days' },
  { days: 30, key: 'lookback_30d', label: '30 days' },
  { days: 90, key: 'lookback_90d', label: '90 days' },
];

/** Independent sort/page state for the drill-down table (PHASE3 §2(b)/§2(c)). */
interface DrillState {
  sort: ViolationPacketSortField;
  dir: SortDir;
  limit: number;
  offset: number;
}

const DEFAULT_DRILL: DrillState = { sort: 'timestamp', dir: 'desc', limit: 100, offset: 0 };

/** End-of-day normalization matching AuditLogTab (`:91-95`) / buildViolationParams. */
function endOfDayMs(dateStr: string): number {
  const d = new Date(dateStr);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * Shallow field comparison for the flat `ViolationFilters` shape. Used by
 * `onRun` to decide whether pressing Run changes the TanStack queryKey (in
 * which case its own automatic refetch does the work) or leaves it
 * unchanged (in which case an explicit `refetch()` is required, or nothing
 * would happen). Calling `refetch()` unconditionally double-fires: it uses
 * the pre-update closure and races the queryKey-driven refetch once React
 * commits the `setApplied` state change.
 */
function filtersEqual(a: ViolationFilters, b: ViolationFilters): boolean {
  return (
    a.lookbackDays === b.lookbackDays &&
    a.from === b.from &&
    a.to === b.to &&
    a.includeUnknown === b.includeUnknown &&
    a.sort === b.sort &&
    a.dir === b.dir &&
    a.limit === b.limit &&
    a.offset === b.offset
  );
}

function mapErrorMessage(t: TFn, error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'INVALID_RANGE') {
    return t('analysis.mqtt_violations.error_invalid_range', 'The selected date range is invalid.');
  }
  if (code === 'INVALID_SORT_FIELD' || code === 'INVALID_SORT_DIRECTION') {
    return t('analysis.mqtt_violations.error_invalid_sort', 'That column cannot be sorted.');
  }
  if (code === 'MQTT_VIOLATIONS_FETCH_FAILED') {
    return t(
      'analysis.mqtt_violations.error_fetch_failed',
      'Failed to read ok_to_mqtt violation history.',
    );
  }
  return (error as Error)?.message ?? String(error);
}

/** `row.gatewayId`, or a synthetic fallback key when a gateway has no id (PHASE3 §2(h)). */
function rowKeyOf(row: ViolationGatewayRow): string {
  return row.gatewayId ?? `nodenum-${row.gatewayNodeNum ?? 'unknown'}`;
}

/**
 * The CSV-export cap-honesty message, shared by both export handlers
 * (PHASE3 §2(d)). Never a silent truncation: `capped` is true whenever the
 * export hit the API's hard ceiling OR the server reports more rows exist
 * than were actually exported.
 */
function buildExportMessage(
  t: TFn,
  exported: number,
  total: number,
): { message: string; capped: boolean } {
  const capped = exported >= API_SCAN_CAP || total > exported;
  const cap = API_SCAN_CAP.toLocaleString();
  const message = capped
    ? t(
        'analysis.mqtt_violations.export_capped',
        'Exported {{exported}} of {{total}} matching rows — the API caps a single scan at {{cap}} rows. Narrow the window to export the rest.',
        { exported: exported.toLocaleString(), total: total.toLocaleString(), cap },
      )
    : t('analysis.mqtt_violations.export_done', 'Exported {{count}} rows', {
        // `count` is i18next's reserved pluralization key and is typed
        // `number` — unlike `exported`/`total`/`cap` above, it cannot be a
        // pre-formatted string.
        count: exported,
      });
  return { message, capped };
}

const MqttViolationsReport: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ViolationFilters>(DEFAULT_VIOLATION_FILTERS);
  const [applied, setApplied] = useState<ViolationFilters>(DEFAULT_VIOLATION_FILTERS);
  const [run, setRun] = useState(false);
  const [expandedGateway, setExpandedGateway] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillState>(DEFAULT_DRILL);
  const [gatewayExportWarning, setGatewayExportWarning] = useState<string | null>(null);
  const [gatewayExportPending, setGatewayExportPending] = useState(false);
  const [drillExportWarning, setDrillExportWarning] = useState<string | null>(null);
  const [drillExportPending, setDrillExportPending] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<ViolationGatewaysResponse>({
    queryKey: ['mqtt-violations-gateways', applied],
    queryFn: async () => {
      const body = await api.get<{ success: boolean; data: ViolationGatewaysResponse }>(
        `/api/analysis/mqtt-violations/gateways?${buildViolationParams(applied)}`,
      );
      return body.data; // envelope not unwrapped by ApiService
    },
    enabled: run,
    // Sort/page/page-size refinements build a new queryKey (`applied` changes
    // identity); keep the previous page's rows on screen while the new one
    // loads instead of flashing back to the loading banner (PHASE3 §2(e)
    // "cheap, already-run refinements").
    placeholderData: keepPreviousData,
  });

  // `data?.gateways ?? []` would otherwise create a fresh array identity on
  // every render (whenever `data` is undefined), which react-hooks/exhaustive-deps
  // correctly flags as unstable when used as a dependency below.
  const gateways = useMemo(() => data?.gateways ?? [], [data]);

  // The one gateway currently expanded, if any — looked up by the same key
  // the row map uses, so the drill-down query always scopes to the actual
  // `gatewayId` rather than the synthetic fallback key.
  const expandedGatewayRow = useMemo(
    () => gateways.find((g) => rowKeyOf(g) === expandedGateway) ?? null,
    [gateways, expandedGateway],
  );
  const expandedGatewayId = expandedGatewayRow?.gatewayId ?? null;

  const packetsQuery = useQuery<ViolationPacketsResponse>({
    queryKey: ['mqtt-violations-packets', expandedGatewayId, applied, drill],
    queryFn: async () => {
      const body = await api.get<{ success: boolean; data: ViolationPacketsResponse }>(
        `/api/analysis/mqtt-violations/packets?${buildViolationParams(applied, {
          gateway: expandedGatewayId ?? undefined,
          sort: drill.sort,
          dir: drill.dir,
          limit: drill.limit,
          offset: drill.offset,
        })}`,
      );
      return body.data;
    },
    enabled: run && expandedGatewayId !== null,
    placeholderData: keepPreviousData,
  });

  const draftRangeInvalid =
    draft.from !== '' && draft.to !== '' && new Date(draft.from).getTime() > endOfDayMs(draft.to);

  const onRun = () => {
    if (draftRangeInvalid) return;
    const sameAsApplied = filtersEqual(applied, draft);
    setApplied(draft);
    if (!run) {
      setRun(true);
    } else if (sameAsApplied) {
      // Filters didn't actually change, so the queryKey won't either — an
      // explicit refetch is the only way to re-run the same window.
      void refetch();
    }
    // Otherwise: the queryKey changed, and TanStack's own effect refetches —
    // calling refetch() here too would double-fire (see filtersEqual doc).
  };

  const handleSort = (field: ViolationGatewaySortField) => {
    const dir: SortDir = applied.sort === field ? (applied.dir === 'asc' ? 'desc' : 'asc') : 'desc';
    const patch = { sort: field, dir, offset: 0 };
    setDraft((d) => ({ ...d, ...patch }));
    setApplied((a) => ({ ...a, ...patch }));
  };

  const handlePageChange = (page: number) => {
    const limit = data?.limit ?? applied.limit;
    const patch = { offset: (page - 1) * limit };
    setDraft((d) => ({ ...d, ...patch }));
    setApplied((a) => ({ ...a, ...patch }));
  };

  const handlePageSizeChange = (limit: number) => {
    const patch = { limit, offset: 0 };
    setDraft((d) => ({ ...d, ...patch }));
    setApplied((a) => ({ ...a, ...patch }));
  };

  /** Toggle expand/collapse. Always resets the drill-down's own pagination
   * (§2(b)) so re-opening — this gateway or a different one — never lands
   * on a stale page from whatever was open before. */
  const handleRowToggle = (rowKey: string) => {
    setExpandedGateway((prev) => (prev === rowKey ? null : rowKey));
    setDrill((d) => ({ ...d, offset: 0 }));
    setDrillExportWarning(null);
  };

  const handleDrillSort = (field: ViolationPacketSortField) => {
    setDrill((d) => ({
      ...d,
      sort: field,
      dir: d.sort === field ? (d.dir === 'asc' ? 'desc' : 'asc') : 'desc',
      offset: 0,
    }));
  };

  const handleDrillPageChange = (page: number) => {
    const limit = packetsQuery.data?.limit ?? drill.limit;
    setDrill((d) => ({ ...d, offset: (page - 1) * limit }));
  };

  /**
   * CSV export re-fetches the *whole* filtered result set at the API's hard
   * ceiling (`limit=API_SCAN_CAP, offset=0`), not just the current page
   * (§2(d)). A one-shot `fetchQuery` rather than a second live `useQuery` —
   * this is an imperative action, not a render-driven data need.
   */
  const handleExportGateways = async () => {
    setGatewayExportPending(true);
    try {
      const body = await queryClient.fetchQuery({
        queryKey: ['mqtt-violations-gateways-export', applied],
        queryFn: async () => {
          const b = await api.get<{ success: boolean; data: ViolationGatewaysResponse }>(
            `/api/analysis/mqtt-violations/gateways?${buildViolationParams(applied, {
              limit: API_SCAN_CAP,
              offset: 0,
            })}`,
          );
          return b.data;
        },
      });
      const csv = buildGatewaysCsv(body.gateways);
      downloadTextFile(gatewaysCsvFilename(), csv, 'text/csv');
      const { message, capped } = buildExportMessage(t, body.gateways.length, body.total);
      setGatewayExportWarning(capped ? message : null);
      showToast(message, capped ? 'error' : 'success');
    } catch {
      setGatewayExportWarning(null);
      showToast(t('analysis.mqtt_violations.export_failed', 'Export failed'), 'error');
    } finally {
      setGatewayExportPending(false);
    }
  };

  const handleExportPackets = async (gatewayId: string) => {
    setDrillExportPending(true);
    try {
      const body = await queryClient.fetchQuery({
        queryKey: ['mqtt-violations-packets-export', gatewayId, applied, drill.sort, drill.dir],
        queryFn: async () => {
          const b = await api.get<{ success: boolean; data: ViolationPacketsResponse }>(
            `/api/analysis/mqtt-violations/packets?${buildViolationParams(applied, {
              gateway: gatewayId,
              sort: drill.sort,
              dir: drill.dir,
              limit: API_SCAN_CAP,
              offset: 0,
            })}`,
          );
          return b.data;
        },
      });
      const csv = buildPacketsCsv(body.violations);
      downloadTextFile(packetsCsvFilename(gatewayId), csv, 'text/csv');
      const { message, capped } = buildExportMessage(t, body.violations.length, body.total);
      setDrillExportWarning(capped ? message : null);
      showToast(message, capped ? 'error' : 'success');
    } catch {
      setDrillExportWarning(null);
      showToast(t('analysis.mqtt_violations.export_failed', 'Export failed'), 'error');
    } finally {
      setDrillExportPending(false);
    }
  };

  // MEANINGLESS unless includeUnknown was actually requested — read from the
  // response echo, never from local toggle state (PHASE3 §2(a.2)).
  const unknownRequested = data?.includeUnknown === true;
  const suspectedUnavailable = unknownRequested && data?.suspectedAvailable === false;
  const suspectedShown = unknownRequested && data?.suspectedAvailable === true;

  const hasSources = (data?.sources.length ?? 0) > 0;
  const isEmpty = hasSources && gateways.length === 0;
  const hasData = hasSources && gateways.length > 0;
  const infoBannersEligible = hasSources && (isEmpty || hasData);

  const capReached = !!data && data.total >= API_SCAN_CAP;
  const reachable = data ? Math.min(data.total, API_SCAN_CAP) : 0;
  const totalPages = data ? Math.max(1, Math.ceil(reachable / data.limit)) : 1;
  const currentPage = data ? Math.floor(data.offset / data.limit) + 1 : 1;
  const capLabel = API_SCAN_CAP.toLocaleString();

  const windowFmt = data ? formatSuspectedWindow(data.suspectedWindowMs) : null;
  const windowText =
    windowFmt?.hours != null
      ? t('analysis.mqtt_violations.window_hours', '{{hours}} h', { hours: windowFmt.hours })
      : windowFmt?.days != null
        ? t('analysis.mqtt_violations.window_days', '{{days}} days', { days: windowFmt.days })
        : '';

  const columnCount = 7 + (suspectedShown ? 1 : 0);

  const stats = {
    gatewayCount: data?.total ?? 0,
    confirmed: gateways.reduce((sum, g) => sum + g.violationCount, 0),
    suspected: gateways.reduce((sum, g) => sum + g.suspectedCount, 0),
    originators: gateways.reduce((sum, g) => sum + g.distinctOriginators, 0),
  };

  const confirmedColTitle = t(
    'analysis.mqtt_violations.col_confirmed_title',
    "Receptions where the sender's ok_to_mqtt bit was explicitly 0 and a different node published the packet to MQTT. Proven.",
  );
  const suspectedColTitle = t(
    'analysis.mqtt_violations.col_suspected_title',
    'Receptions where the ok_to_mqtt bit could not be read — usually because MeshMonitor has no key for the channel. Not proven, and not sortable.',
  );

  // Drill-down cap honesty (§2(c) rule 5 — same treatment as the summary table).
  const drillTotal = packetsQuery.data?.total ?? 0;
  const drillCapReached = !!packetsQuery.data && drillTotal >= API_SCAN_CAP;
  const drillLimit = packetsQuery.data?.limit ?? drill.limit;
  const drillReachable = packetsQuery.data ? Math.min(drillTotal, API_SCAN_CAP) : 0;
  const drillTotalPages = packetsQuery.data ? Math.max(1, Math.ceil(drillReachable / drillLimit)) : 1;
  const drillCurrentPage = packetsQuery.data
    ? Math.floor(packetsQuery.data.offset / drillLimit) + 1
    : 1;
  const drillViolations = packetsQuery.data?.violations ?? [];
  const drillHasData = drillViolations.length > 0;

  return (
    <>
      <div>
        <h2 className="reports-section__title">
          <UiIcon name="securityAlert" size={22} />
          {t('analysis.mqtt_violations.title', 'ok_to_mqtt Violations')}
        </h2>
        <p className="reports-section__subtitle">
          {t(
            'analysis.mqtt_violations.description',
            "Find MQTT gateways that uplinked other nodes' packets even though the sender did not opt in to MQTT (ok_to_mqtt = 0).",
          )}
        </p>
      </div>

      <div className="reports-panel">
        <div className="reports-controls">
          <div className="reports-controls__field">
            <span>{t('analysis.mqtt_violations.window', 'Window')}</span>
            <div>
              {LOOKBACK_PRESETS.map((preset) => (
                <button
                  key={preset.days}
                  type="button"
                  className="reports-btn reports-btn--ghost"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      lookbackDays: preset.days,
                      from: '',
                      to: '',
                      offset: 0,
                    }))
                  }
                  disabled={isLoading}
                >
                  {t(`analysis.mqtt_violations.${preset.key}`, preset.label)}
                </button>
              ))}
            </div>
          </div>

          <label className="reports-controls__field">
            <span>{t('analysis.mqtt_violations.from', 'From')}</span>
            <input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value, offset: 0 }))}
              disabled={isLoading}
            />
          </label>
          <label className="reports-controls__field">
            <span>{t('analysis.mqtt_violations.to', 'To')}</span>
            <input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value, offset: 0 }))}
              disabled={isLoading}
            />
          </label>
          {(draft.from !== '' || draft.to !== '') && (
            <button
              type="button"
              className="reports-btn reports-btn--ghost"
              onClick={() => setDraft((d) => ({ ...d, from: '', to: '', offset: 0 }))}
            >
              {t('analysis.mqtt_violations.clear_range', 'Clear dates')}
            </button>
          )}

          <label className="reports-controls__field">
            <input
              type="checkbox"
              checked={draft.includeUnknown}
              onChange={(e) =>
                setDraft((d) => ({ ...d, includeUnknown: e.target.checked, offset: 0 }))
              }
              disabled={isLoading}
            />
            {t('analysis.mqtt_violations.include_unknown', 'Include unproven (unreadable bit)')}
          </label>
          <span className={styles.hint}>
            {t(
              'analysis.mqtt_violations.include_unknown_help',
              'Also count receptions where the ok_to_mqtt bit could not be read. These are not proven violations and come from a much shorter retention window.',
            )}
          </span>

          <button type="button" className="reports-btn" onClick={onRun} disabled={draftRangeInvalid}>
            {isLoading
              ? t('analysis.mqtt_violations.running', 'Scanning…')
              : run
                ? t('analysis.mqtt_violations.rerun', 'Re-run report')
                : t('analysis.mqtt_violations.run', 'Run report')}
          </button>

          <button
            type="button"
            className="reports-btn reports-btn--ghost"
            disabled={!hasData || gatewayExportPending}
            title={t('analysis.mqtt_violations.export_csv', 'Export CSV')}
            onClick={() => {
              void handleExportGateways();
            }}
          >
            <UiIcon name="download" size={16} />
            {t('analysis.mqtt_violations.export_csv', 'Export CSV')}
          </button>
        </div>

        {suspectedShown && (
          <span className={styles.hint}>
            {t(
              'analysis.mqtt_violations.horizon_hint',
              'Confirmed violations are kept for about 90 days. Suspected rows come from the MQTT packet monitor and only reach back {{window}}.',
              { window: windowText },
            )}
          </span>
        )}

        {gatewayExportWarning && (
          <div className="reports-banner reports-banner--warning">
            <span>{gatewayExportWarning}</span>
            <button
              type="button"
              className="reports-btn reports-btn--ghost"
              onClick={() => setGatewayExportWarning(null)}
              aria-label={t('common.dismiss', 'Dismiss')}
            >
              <UiIcon name="close" size={14} />
            </button>
          </div>
        )}
      </div>

      {draftRangeInvalid && (
        <div className="reports-banner reports-banner--error">
          {t(
            'analysis.mqtt_violations.range_error',
            'The start date must be on or before the end date.',
          )}
        </div>
      )}

      {!run && (
        <div className="reports-banner">
          {t(
            'analysis.mqtt_violations.prerun',
            "This report scans every MQTT source you can read for gateways that relayed another node's packet despite ok_to_mqtt = 0. Choose a window and press Run report — nothing is queried until you do.",
          )}
        </div>
      )}

      {run && isLoading && (
        <div className="reports-banner">
          {t('analysis.mqtt_violations.loading', 'Scanning MQTT violation history…')}
        </div>
      )}

      {run && !isLoading && error && (
        <div className="reports-banner reports-banner--error">{mapErrorMessage(t, error)}</div>
      )}

      {run && !isLoading && !error && data && !hasSources && (
        <div className="reports-banner reports-banner--empty">
          <div>{t('analysis.mqtt_violations.no_sources', 'No sources available to you.')}</div>
          <div className="reports-banner__hint">
            {t(
              'analysis.mqtt_violations.no_sources_hint',
              'This report reads the MQTT sources you have packet-monitor read access to. If you are signed out or have no source permissions, sign in or ask an administrator. If this install has no sources configured yet, there is nothing to scan.',
            )}
          </div>
        </div>
      )}

      {run && !isLoading && !error && data && isEmpty && (
        <div className="reports-banner reports-banner--empty">
          <div>
            {t(
              'analysis.mqtt_violations.empty',
              'No ok_to_mqtt violations in the selected window.',
            )}
          </div>
          <div className="reports-banner__hint">
            {t(
              'analysis.mqtt_violations.empty_good_news',
              "On a healthy network that is the expected result — it means every MQTT gateway that relayed another node's packet respected the sender's opt-out.",
            )}
          </div>
          <div className="reports-banner__hint">
            {t(
              'analysis.mqtt_violations.empty_forward_only',
              'Detection is forward-only: packets captured before this feature shipped cannot be classified, so a freshly upgraded install starts empty and fills as new MQTT traffic arrives.',
            )}
          </div>
        </div>
      )}

      {run && !isLoading && !error && data && infoBannersEligible && suspectedUnavailable && (
        <div className="reports-banner reports-banner--warning">
          {t(
            'analysis.mqtt_violations.suspected_unavailable',
            "Suspected rows need the MQTT packet monitor's capture enabled. The confirmed violations shown here are unaffected.",
          )}
        </div>
      )}

      {run && !isLoading && !error && data && infoBannersEligible && suspectedShown && (
        <div className="reports-banner reports-banner--warning">
          {t(
            'analysis.mqtt_violations.suspected_caveat',
            "Suspected rows are not proven violations — the ok_to_mqtt bit could not be read. They come from the MQTT packet monitor's log and only reach back {{window}}, while confirmed violations reach back about 90 days.",
            { window: windowText },
          )}
        </div>
      )}

      {run && !isLoading && !error && data && hasData && (
        <>
          {capReached && (
            <div className="reports-banner reports-banner--warning">
              {t(
                'analysis.mqtt_violations.cap_warning',
                'Showing the first {{cap}} rows. The API caps a single scan at {{cap}} rows, so the total and any later pages are incomplete — narrow the window or select fewer sources.',
                { cap: capLabel },
              )}
            </div>
          )}
          {capReached && applied.dir === 'asc' && (
            <div className="reports-banner reports-banner--warning">
              {t(
                'analysis.mqtt_violations.cap_warning_asc',
                'Sorting ascending inside a capped scan orders only those {{cap}} rows, not the whole window.',
                { cap: capLabel },
              )}
            </div>
          )}

          <div className="reports-stats">
            <Stat
              label={t('analysis.mqtt_violations.stat_gateways', 'Gateways')}
              value={capReached ? `${capLabel}+` : stats.gatewayCount.toLocaleString()}
            />
            <Stat
              label={t('analysis.mqtt_violations.stat_confirmed', 'Confirmed violations')}
              value={stats.confirmed.toLocaleString()}
            />
            {suspectedShown && (
              <Stat
                label={t('analysis.mqtt_violations.stat_suspected', 'Suspected')}
                value={stats.suspected.toLocaleString()}
              />
            )}
            <Stat
              label={t('analysis.mqtt_violations.stat_originators', 'Originators affected')}
              value={stats.originators.toLocaleString()}
            />
          </div>

          <div className="reports-table-wrap">
            <table className="reports-table">
              <thead>
                <tr>
                  <th aria-hidden="true" />
                  <SortableTh
                    label={t('analysis.mqtt_violations.col_gateway', 'Gateway')}
                    active={applied.sort === 'gatewayId'}
                    dir={applied.dir}
                    onClick={() => handleSort('gatewayId')}
                    t={t}
                  />
                  <SortableTh
                    label={t('analysis.mqtt_violations.col_confirmed', 'Confirmed')}
                    titleText={confirmedColTitle}
                    active={applied.sort === 'violationCount'}
                    dir={applied.dir}
                    onClick={() => handleSort('violationCount')}
                    t={t}
                  />
                  {suspectedShown && (
                    <th title={suspectedColTitle}>
                      {t('analysis.mqtt_violations.col_suspected', 'Suspected')}
                    </th>
                  )}
                  <SortableTh
                    label={t('analysis.mqtt_violations.col_originators', 'Originators')}
                    active={applied.sort === 'distinctOriginators'}
                    dir={applied.dir}
                    onClick={() => handleSort('distinctOriginators')}
                    t={t}
                  />
                  <th>{t('analysis.mqtt_violations.col_sources', 'Sources')}</th>
                  <th>{t('analysis.mqtt_violations.col_first_seen', 'First seen')}</th>
                  <SortableTh
                    label={t('analysis.mqtt_violations.col_last_seen', 'Last seen')}
                    active={applied.sort === 'lastSeen'}
                    dir={applied.dir}
                    onClick={() => handleSort('lastSeen')}
                    t={t}
                  />
                </tr>
              </thead>
              <tbody>
                {gateways.map((row) => {
                  const rowKey = rowKeyOf(row);
                  const isExpanded = expandedGateway === rowKey;
                  const isSuspectedOnly = row.violationCount === 0 && row.suspectedCount > 0;
                  const nodeRef = formatNodeRef(row.gatewayId, row.gatewayNodeNum);
                  const rowGatewayId = row.gatewayId;
                  const rowTitle = isSuspectedOnly
                    ? t(
                        'analysis.mqtt_violations.suspected_only_title',
                        'No confirmed violations from this gateway in this window — only unproven ones.',
                      )
                    : isExpanded
                      ? t('analysis.mqtt_violations.collapse', 'Hide violating packets')
                      : t('analysis.mqtt_violations.expand', 'Show violating packets');

                  return (
                    <Fragment key={rowKey}>
                      <tr
                        className={`reports-row--clickable${isSuspectedOnly ? ` ${styles.suspectedOnlyRow}` : ''}`}
                        data-suspected-only={isSuspectedOnly ? 'true' : undefined}
                        onClick={() => handleRowToggle(rowKey)}
                        title={rowTitle}
                        aria-expanded={isExpanded}
                      >
                        <td className={styles.expandButton}>
                          <UiIcon name={isExpanded ? 'chevronUp' : 'chevronDown'} size={14} />
                        </td>
                        <td title={`${nodeRef} (${row.gatewayNodeNum ?? '—'})`}>
                          <div className="reports-node__name">{nodeRef || '—'}</div>
                          {row.gatewayNodeNum != null && (
                            <div className="reports-node__meta">{row.gatewayNodeNum}</div>
                          )}
                        </td>
                        <td>
                          {isSuspectedOnly ? (
                            <span className={styles.mutedZero} title={confirmedColTitle}>
                              0
                            </span>
                          ) : (
                            <span
                              className="reports-pill reports-pill--warn"
                              title={confirmedColTitle}
                            >
                              {row.violationCount}
                            </span>
                          )}
                        </td>
                        {suspectedShown && (
                          <td className={styles.suspectedCell} title={suspectedColTitle}>
                            {row.suspectedCount}
                          </td>
                        )}
                        <td>{row.distinctOriginators}</td>
                        <td className={styles.sourcesCell}>{row.sourceIds.join(', ')}</td>
                        <td>{new Date(row.firstSeen).toLocaleString()}</td>
                        <td>{new Date(row.lastSeen).toLocaleString()}</td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={columnCount} className={styles.detailCell}>
                            <div className={styles.detailInner}>
                              <div className={styles.detailHeader}>
                                <strong>
                                  {t(
                                    'analysis.mqtt_violations.drill_title',
                                    'Violating packets published by {{gateway}}',
                                    { gateway: nodeRef || rowKey },
                                  )}
                                </strong>
                                {rowGatewayId && (
                                  <button
                                    type="button"
                                    className="reports-btn reports-btn--ghost"
                                    disabled={!drillHasData || drillExportPending}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleExportPackets(rowGatewayId);
                                    }}
                                  >
                                    <UiIcon name="download" size={16} />
                                    {t('analysis.mqtt_violations.export_csv', 'Export CSV')}
                                  </button>
                                )}
                              </div>

                              {drillExportWarning && (
                                <div className="reports-banner reports-banner--warning">
                                  <span>{drillExportWarning}</span>
                                  <button
                                    type="button"
                                    className="reports-btn reports-btn--ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDrillExportWarning(null);
                                    }}
                                    aria-label={t('common.dismiss', 'Dismiss')}
                                  >
                                    <UiIcon name="close" size={14} />
                                  </button>
                                </div>
                              )}

                              {packetsQuery.isLoading && (
                                <div className="reports-banner">
                                  {t('analysis.mqtt_violations.drill_loading', 'Loading packets…')}
                                </div>
                              )}

                              {!packetsQuery.isLoading && packetsQuery.error && (
                                <div className="reports-banner reports-banner--error">
                                  {mapErrorMessage(t, packetsQuery.error)}
                                </div>
                              )}

                              {!packetsQuery.isLoading &&
                                !packetsQuery.error &&
                                packetsQuery.data &&
                                !drillHasData && (
                                  <div className="reports-banner reports-banner--empty">
                                    <div>
                                      {t(
                                        'analysis.mqtt_violations.drill_empty',
                                        'No individual rows for this gateway in this window.',
                                      )}
                                    </div>
                                    {!applied.includeUnknown && (
                                      <div className="reports-banner__hint">
                                        {t(
                                          'analysis.mqtt_violations.drill_empty_hint',
                                          'Unproven receptions are hidden — turn on "Include unproven" to see them.',
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}

                              {!packetsQuery.isLoading &&
                                !packetsQuery.error &&
                                packetsQuery.data &&
                                drillHasData && (
                                  <>
                                    {drillCapReached && (
                                      <div className="reports-banner reports-banner--warning">
                                        {t(
                                          'analysis.mqtt_violations.cap_warning',
                                          'Showing the first {{cap}} rows. The API caps a single scan at {{cap}} rows, so the total and any later pages are incomplete — narrow the window or select fewer sources.',
                                          { cap: capLabel },
                                        )}
                                      </div>
                                    )}
                                    {drillCapReached && drill.dir === 'asc' && (
                                      <div className="reports-banner reports-banner--warning">
                                        {t(
                                          'analysis.mqtt_violations.cap_warning_asc',
                                          'Sorting ascending inside a capped scan orders only those {{cap}} rows, not the whole window.',
                                          { cap: capLabel },
                                        )}
                                      </div>
                                    )}

                                    <div className="reports-table-wrap">
                                      <table className="reports-table">
                                        <thead>
                                          <tr>
                                            <th>
                                              {t('analysis.mqtt_violations.dcol_state', 'ok_to_mqtt')}
                                            </th>
                                            <SortableTh
                                              label={t('analysis.mqtt_violations.dcol_time', 'Time')}
                                              active={drill.sort === 'timestamp'}
                                              dir={drill.dir}
                                              onClick={() => handleDrillSort('timestamp')}
                                              t={t}
                                            />
                                            <th>
                                              {t('analysis.mqtt_violations.dcol_source', 'Source')}
                                            </th>
                                            <SortableTh
                                              label={t('analysis.mqtt_violations.dcol_from', 'From')}
                                              active={drill.sort === 'fromNode'}
                                              dir={drill.dir}
                                              onClick={() => handleDrillSort('fromNode')}
                                              t={t}
                                            />
                                            <th>
                                              {t('analysis.mqtt_violations.dcol_channel', 'Channel')}
                                            </th>
                                            <th>{t('analysis.mqtt_violations.dcol_port', 'Port')}</th>
                                            <th>
                                              {t(
                                                'analysis.mqtt_violations.dcol_packet_id',
                                                'Packet ID',
                                              )}
                                            </th>
                                            <th>
                                              {t('analysis.mqtt_violations.dcol_bitfield', 'Bitfield')}
                                            </th>
                                            <th>{t('analysis.mqtt_violations.dcol_topic', 'Topic')}</th>
                                            <th>
                                              {t('analysis.mqtt_violations.dcol_rx_time', 'RX time')}
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {drillViolations.map((v) => {
                                            const vState = okToMqttState({
                                              okToMqttViolation: v.kind === 'confirmed' ? 1 : 0,
                                              bitfield: v.bitfield,
                                            });
                                            const fromRef = formatNodeRef(v.fromNodeId, v.fromNode);
                                            const vKey = `${v.sourceId}-${v.packetId ?? v.id ?? ''}-${v.timestamp}`;
                                            return (
                                              <tr key={vKey}>
                                                <td>
                                                  <MqttOkToMqttMarker state={vState} scope="gateway" />
                                                </td>
                                                <td>{new Date(v.timestamp).toLocaleString()}</td>
                                                <td>{v.sourceId}</td>
                                                <td title={fromRef || undefined}>{fromRef || '—'}</td>
                                                <td>{v.channelId ?? '—'}</td>
                                                <td title={v.portnumName ?? undefined}>
                                                  {v.portnum ?? '—'}
                                                  {v.portnumName ? ` (${v.portnumName})` : ''}
                                                </td>
                                                <td>{v.packetId ?? '—'}</td>
                                                <td>{v.bitfield ?? '—'}</td>
                                                <td className={styles.topicCell} title={v.topic ?? undefined}>
                                                  {v.topic ?? '—'}
                                                </td>
                                                <td>
                                                  {v.rxTime ? new Date(v.rxTime).toLocaleString() : '—'}
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>

                                    <div className={styles.pager}>
                                      <span className={styles.pagerInfo}>
                                        {t('analysis.mqtt_violations.page', 'Page {{page}} of {{pages}}', {
                                          page: drillCurrentPage,
                                          pages: drillTotalPages,
                                        })}
                                      </span>
                                      <div>
                                        <button
                                          type="button"
                                          className="reports-btn reports-btn--ghost"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleDrillPageChange(drillCurrentPage - 1);
                                          }}
                                          disabled={drillCurrentPage <= 1}
                                        >
                                          {t('analysis.mqtt_violations.prev', 'Previous')}
                                        </button>
                                        <button
                                          type="button"
                                          className="reports-btn reports-btn--ghost"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleDrillPageChange(drillCurrentPage + 1);
                                          }}
                                          disabled={drillCurrentPage >= drillTotalPages}
                                        >
                                          {t('analysis.mqtt_violations.next', 'Next')}
                                        </button>
                                      </div>
                                    </div>
                                  </>
                                )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className={styles.pager}>
            <span className={styles.pagerInfo}>
              <span>
                {capReached
                  ? t('analysis.mqtt_violations.total_rows_capped', '{{cap}}+ gateways', {
                      cap: capLabel,
                    })
                  : t('analysis.mqtt_violations.total_rows', '{{total}} gateways', {
                      total: data.total.toLocaleString(),
                    })}
              </span>
              {' · '}
              <span>
                {t('analysis.mqtt_violations.page', 'Page {{page}} of {{pages}}', {
                  page: currentPage,
                  pages: totalPages,
                })}
              </span>
            </span>
            <div>
              <button
                type="button"
                className="reports-btn reports-btn--ghost"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage <= 1}
              >
                {t('analysis.mqtt_violations.prev', 'Previous')}
              </button>
              <button
                type="button"
                className="reports-btn reports-btn--ghost"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage >= totalPages}
              >
                {t('analysis.mqtt_violations.next', 'Next')}
              </button>
              <label>
                {t('analysis.mqtt_violations.page_size', 'Rows per page')}
                <select
                  value={applied.limit}
                  onChange={(e) => handlePageSizeChange(Number(e.target.value))}
                >
                  {PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </>
      )}
    </>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="reports-stat">
    <div className="reports-stat__label">{label}</div>
    <div className="reports-stat__value">{value}</div>
  </div>
);

/**
 * A sortable `<th>` button, shared by the gateway summary header and the
 * drill-down header. Callers resolve `active`/`dir` from their own applied
 * sort state (`applied` for the summary, `drill` for the drill-down) since
 * the two tables sort independently (PHASE3 §2(b)/§2(c)).
 */
const SortableTh: React.FC<{
  label: string;
  titleText?: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  t: TFn;
}> = ({ label, titleText, active, dir, onClick, t }) => {
  return (
    <th title={titleText}>
      <button
        type="button"
        className={`${styles.sortHeader}${active ? ` ${styles.sortHeaderActive}` : ''}`}
        onClick={onClick}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
        title={t('analysis.mqtt_violations.sort_by', 'Sort by {{column}}', { column: label })}
      >
        {label}
        {active && (
          <UiIcon
            name={dir === 'asc' ? 'sortAscending' : 'sortDescending'}
            size={12}
            className={styles.sortIcon}
          />
        )}
      </button>
    </th>
  );
};

export default MqttViolationsReport;
