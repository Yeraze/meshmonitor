/**
 * MeshCorePacketMonitorView — OTA packet monitor for a MeshCore source.
 *
 * The MeshCore analogue of the Meshtastic Packet Monitor. Surfaces full OTA
 * packet metadata captured from the companion `LogRxData` (0x88) push:
 * route type, payload type, relay-hash chain, hop count, SNR/RSSI and the
 * raw hex dump. Capture is opt-in via the `meshcore_packet_log_enabled`
 * setting; this view exposes the toggle and retention controls inline.
 *
 * Data flow: pages come from `GET /api/sources/:id/meshcore/packets` (keyset
 * cursor) or `/packets/grouped` via `useMeshCorePackets`, rendered through the
 * shared virtualized list; new packets arrive live over the shared Socket.io
 * connection as `meshcore:ota-packet` events (#6262).
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Filter, Trash2, Pause, Play, RefreshCw, Download, Circle, Square, BarChart3, ExternalLink } from 'lucide-react';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useWebSocketContext } from '../../contexts/WebSocketContext';
import { useAuth } from '../../contexts/AuthContext';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { useMeshCorePackets, meshCoreFilterParams, type MeshCorePacketFilters, type MeshCorePacketRow } from '../../hooks/useMeshCorePackets';
import { useInfiniteVirtualRows } from '../../hooks/useInfiniteVirtualRows';
import { deriveMeshCorePacketFields } from '../../utils/meshcorePacketDerived';
import { hopByteForKey, resolveHop, type RepeaterOption } from '../../utils/meshcorePath';
import { openPacketMonitorPopout } from '../../utils/packetMonitorPopout';
import PacketSearchInput from '../packets/PacketSearchInput';
import TimeWindowSelect from '../packets/TimeWindowSelect';
import { windowToSince, type TimeWindowKey } from '../packets/timeWindow';
import SearchableSelect, { type SearchableSelectOption } from '../common/SearchableSelect';
import { toChartEntries } from '../packetStatsChartData';
import {
  MESHCORE_PAYLOAD_TYPES as PAYLOAD_TYPES,
  MESHCORE_ROUTE_TYPES as ROUTE_TYPES,
} from '../../utils/meshcorePacketDecode';
import MeshCorePacketDetailModal from './MeshCorePacketDetailModal';
import './MeshCorePacketMonitor.css';
import styles from './MeshCorePacketMonitorView.module.css';
import { UiIcon } from '../icons';
import { NumberInput } from '../common/NumberInput';
import { SourceNotConnectedNotice } from '../common/SourceNotConnectedNotice';
import { isSourceNotConnectedError } from '../../utils/sourceNotConnected';

const PacketStatsChart = React.lazy(() => import('../PacketStatsChart'));

interface MeshCorePacketMonitorViewProps {
  baseUrl: string;
  sourceId: string;
  /** True for a MeshCore Repeater (serial CLI) source (#5500). Stock repeater
   *  firmware doesn't stream packets over serial, so an empty log says so. */
  isRepeaterSource?: boolean;
  /** This source's contacts, used to name the Packet Decode relay chain (#6190). */
  contacts?: MeshCoreContact[];
  /** Rendered in a pop-out window: fills the viewport, no pop-out button. */
  standalone?: boolean;
  /** Called with a contact's public key when a From cell resolves to exactly one contact. */
  onNodeClick?: (publicKey: string) => void;
}

type Packet = MeshCorePacketRow;

const HEX_HASH = /^[0-9a-f]{2,6}$/i;
const validHash = (v: string): boolean => HEX_HASH.test(v) && v.length % 2 === 0;

interface Distribution {
  byPayloadType: { payloadType: number; payloadTypeName: string | null; count: number }[];
  byRouteType: { routeType: number | null; routeTypeName: string | null; count: number }[];
  topSenders: { senderPubKey: string; advertName: string | null; count: number }[];
  total: number;
}

/**
 * One collapsed row: a distinct frame with its per-observer receptions folded
 * in (#5040 Phase 2b). Shares the display fields of `Packet` so the table body
 * can render either shape.
 */
interface GroupedPacket extends Packet {
  observerCount: number;
  receptionCount: number;
  bestSnr: number | null;
  bestRssi: number | null;
  firstHeard: number;
  lastHeard: number;
}

/**
 * Render an observer count for display.
 *
 * `0` does NOT mean "nobody heard this" — it means OUR radio heard it, because
 * a local reception carries a NULL observerId and COUNT(DISTINCT) skips NULLs
 * (#5040 Phase 2). Showing the digit would invert the meaning for every
 * locally-heard packet, so the local case gets a word instead.
 */
function observerLabel(count: number, localText: string): string {
  return count > 0 ? String(count) : localText;
}

function payloadLabel(p: Packet): string {
  if (p.payloadTypeName) return p.payloadTypeName;
  const match = PAYLOAD_TYPES.find(t => t.value === p.payloadType);
  return match ? match.label : `0x${p.payloadType.toString(16).padStart(2, '0')}`;
}

function routeLabel(p: Packet): string {
  if (p.routeTypeName) return p.routeTypeName;
  if (typeof p.routeType !== 'number') return '—';
  const match = ROUTE_TYPES.find(t => t.value === p.routeType);
  return match ? match.label : `0x${p.routeType.toString(16).padStart(2, '0')}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export const MeshCorePacketMonitorView: React.FC<MeshCorePacketMonitorViewProps> = ({ baseUrl, sourceId, isRepeaterSource = false, contacts, standalone = false, onNodeClick }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { state: wsState } = useWebSocketContext();
  const socket = wsState.socket;
  const { hasPermission } = useAuth();

  // 'settings' is sourcey (Phase 6 #4416). Deviates from the PHASE6 spec §5.3
  // table's suggested `{ sourceId }` default: verified that saveSettings()
  // below POSTs `meshcore_packet_log_enabled` to /api/settings with no
  // sourceId query param, and the backend reads it via a plain
  // getSettingAsync() (meshcorePacketLogService.ts) — it is a genuinely
  // global, not per-source, setting, and this component never calls
  // useSource() (sourceId arrives as a prop). anySource mirrors the
  // unscoped write it actually gates.
  const canWriteSettings = hasPermission('settings', 'write', { anySource: true });
  const canClear = hasPermission('packetmonitor', 'write');

  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showStats, setShowStats] = useState(false);

  const [savingSettings, setSavingSettings] = useState(false);

  // Collapsed view (#5040 Phase 2b). Meaningful for any MeshCore source: a
  // device-backed one records a single reception per frame, so grouping is a
  // no-op there rather than something to hide behind a source-type check.
  const [grouped, setGrouped] = useState(false);

  const [payloadFilter, setPayloadFilter] = useState<number | ''>('');
  const [routeFilter, setRouteFilter] = useState<number | ''>('');
  const [search, setSearch] = useState<string | undefined>(undefined);
  const [timeWindow, setTimeWindow] = useState<TimeWindowKey>('all');
  const [senderFilter, setSenderFilter] = useState('');
  const [srcHashInput, setSrcHashInput] = useState('');
  const [pathHashInput, setPathHashInput] = useState('');
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null);

  // `since` is fixed when the window changes. Re-deriving it each render would
  // change the query key every millisecond.
  const since = useMemo(() => windowToSince(timeWindow), [timeWindow]);
  const srcHash = validHash(srcHashInput) ? srcHashInput.toLowerCase() : undefined;
  const pathHash = validHash(pathHashInput) ? pathHashInput.toLowerCase() : undefined;
  const filters = useMemo<MeshCorePacketFilters>(() => ({
    payloadType: payloadFilter === '' ? undefined : payloadFilter,
    routeType: routeFilter === '' ? undefined : routeFilter,
    since,
    search,
    srcHash,
    sender: senderFilter || undefined,
    pathHash,
  }), [payloadFilter, routeFilter, since, search, srcHash, senderFilter, pathHash]);
  const hasActiveFilters = Object.values(filters).some(v => v !== undefined);

  const mcPrefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore`;

  const {
    packets: visiblePackets,
    total,
    loading,
    loadingMore,
    hasMore,
    error: loadError,
    loadMore,
    refresh,
    meta,
    setMeta,
  } = useMeshCorePackets({ baseUrl, sourceId, filters, grouped, paused, socket });
  const { enabled, maxAgeHours, isIngestSource } = meta;
  const maxCount = meta.maxCount;
  const setEnabled = useCallback((v: boolean) => setMeta(m => ({ ...m, enabled: v })), [setMeta]);
  const setMaxCount = (v: number) => setMeta(m => ({ ...m, maxCount: v }));
  const setMaxAgeHours = (v: number) => setMeta(m => ({ ...m, maxAgeHours: v }));

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useInfiniteVirtualRows({
    count: visiblePackets.length,
    hasMore,
    loadingMore,
    loadMore,
    estimateSize: 36,
    getScrollElement: () => parentRef.current,
  });

  // Hash -> contact. Any contact can be a sender, so this is not limited to repeaters.
  const contactOptions = useMemo<RepeaterOption[]>(
    () => (contacts ?? []).map(c => ({
      publicKey: c.publicKey,
      name: c.advName || c.name || `${c.publicKey.slice(0, 8)}…`,
      hopByte: hopByteForKey(c.publicKey, 1),
    })),
    [contacts],
  );
  const contactByKey = useMemo(() => {
    const m = new Map<string, RepeaterOption>();
    for (const o of contactOptions) m.set(o.publicKey.toLowerCase(), o);
    return m;
  }, [contactOptions]);

  const senderOptions = useMemo<SearchableSelectOption[]>(
    () => contactOptions
      .map(o => ({ value: o.publicKey, label: o.name, keywords: o.publicKey }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [contactOptions],
  );

  const distParams = meshCoreFilterParams(filters).toString();
  const { data: distribution } = useQuery<Distribution>({
    queryKey: ['meshcore-packet-distribution', sourceId, distParams],
    enabled: showStats,
    queryFn: async () => {
      const res = await csrfFetch(`${mcPrefix}/packets/stats/distribution?${distParams}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 10_000,
  });

  // A source with no running manager gets the shared empty state, not
  // "HTTP 404" (#4173 N5).
  const notConnected = isSourceNotConnectedError(loadError);
  const errorText = error ?? (notConnected ? null : loadError?.message) ?? null;

  const clearFilters = useCallback(() => {
    setPayloadFilter('');
    setRouteFilter('');
    setSearch(undefined);
    setTimeWindow('all');
    setSenderFilter('');
    setSrcHashInput('');
    setPathHashInput('');
  }, []);

  /** Names come from the node list, so they follow the same `nodes:read` rule as that list. */
  const canSeeNames = hasPermission('nodes', 'read', { sourceId });
  /**
   * The From cell. A full sender key (ADVERT / ANON_REQ) names the node; a bare
   * 1-byte hash names it only when exactly one known contact owns that hash.
   * An ambiguous hash shows `0x2f?` and an unknown one `0x2f`: never a guess.
   */
  const resolveFrom = useCallback((p: Packet): { label: string | null; publicKey: string | null; title?: string } => {
    const derived = p.srcHash !== undefined || p.senderPubKey !== undefined || p.advertName !== undefined
      ? { srcHash: p.srcHash ?? null, senderPubKey: p.senderPubKey ?? null, advertName: p.advertName ?? null }
      : deriveMeshCorePacketFields(p.rawHex);
    if (derived.senderPubKey) {
      const key = derived.senderPubKey.toLowerCase();
      const short = `${key.slice(0, 8)}…`;
      if (!canSeeNames) return { label: short, publicKey: null, title: key };
      const exact = contactByKey.get(key);
      if (exact) return { label: derived.advertName || exact.name, publicKey: exact.publicKey, title: key };
      return { label: derived.advertName || short, publicKey: null, title: key };
    }
    if (!derived.srcHash) return { label: null, publicKey: null };
    const hash = derived.srcHash.toLowerCase();
    if (!canSeeNames) return { label: `0x${hash}`, publicKey: null };
    const r = resolveHop(hash as RepeaterOption['hopByte'], contactOptions);
    if (r.matches.length === 1) {
      return { label: r.matches[0].name, publicKey: r.matches[0].publicKey, title: r.matches[0].publicKey };
    }
    return { label: r.matches.length > 1 ? `0x${hash}?` : `0x${hash}`, publicKey: null };
  }, [canSeeNames, contactByKey, contactOptions]);
  /**
   * TX/RX marker, only where the row's data decides it. An observer that is the
   * packet's own sender published it (TX); a local radio or another observer
   * heard it (RX). Collapsed rows hold many observers, so they get no marker.
   */
  const directionOf = (p: Packet): 'tx' | 'rx' | null => {
    if (grouped) return null;
    const obs = p.observerId ? p.observerId.toLowerCase() : null;
    const sender = (p.senderPubKey ?? deriveMeshCorePacketFields(p.rawHex).senderPubKey)?.toLowerCase() ?? null;
    if (obs && sender && obs === sender) return 'tx';
    return 'rx';
  };
  const saveSettings = useCallback(async (patch: Record<string, string>): Promise<boolean> => {
    setSavingSettings(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
      return false;
    } finally {
      setSavingSettings(false);
    }
  }, [csrfFetch, baseUrl]);

  const handleToggleEnabled = useCallback(async () => {
    // Commit the toggle only after the save succeeds, so a failed POST leaves
    // the control showing the real capture state instead of an optimistic lie.
    const next = !enabled;
    if (await saveSettings({ meshcore_packet_log_enabled: next ? '1' : '0' })) {
      setEnabled(next);
    }
  }, [enabled, saveSettings, setEnabled]);

  const handleClear = useCallback(async () => {
    if (!window.confirm(t('meshcore.packets.clearConfirm', 'Clear the captured MeshCore packet log for this source?'))) {
      return;
    }
    try {
      const res = await csrfFetch(`${mcPrefix}/packets`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear packets');
    }
  }, [csrfFetch, mcPrefix, t, refresh]);

  // Download the captured packet log as JSONL (honors the active filters),
  // mirroring the Meshtastic packet-monitor export.
  const handleExport = useCallback(async () => {
    try {
      const res = await csrfFetch(`${mcPrefix}/packets/export?${meshCoreFilterParams(filters).toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Prefer the server-provided filename (timestamped, filter-aware).
      const contentDisposition = res.headers.get('Content-Disposition');
      let filename = 'meshcore-packet-monitor.jsonl';
      const matches = contentDisposition && /filename="(.+)"/.exec(contentDisposition);
      if (matches && matches[1]) filename = matches[1];

      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export packets');
    }
  }, [csrfFetch, mcPrefix, filters]);

  return (
    <div className="meshcore-packet-monitor" data-standalone={standalone ? 'true' : undefined}>
      <div className="mcpm-header">
        <h3>{t('meshcore.packets.title', 'Packet Monitor')}</h3>
        <span className="mcpm-count" title={t('meshcore.packets.countTitle', 'Packets matching the filters')}>{total}</span>
        <div className="mcpm-header-controls">
          {canWriteSettings && (
            <button
              className={`mcpm-btn ${enabled ? 'mcpm-btn-danger' : ''}`}
              onClick={() => void handleToggleEnabled()}
              disabled={savingSettings}
              title={enabled
                ? t('meshcore.packets.stopCapture', 'Stop capturing')
                : t('meshcore.packets.startCapture', 'Start capturing')}
            >
              {enabled ? <Square size={14} /> : <Circle size={14} />}
            </button>
          )}
          <button
            className="mcpm-btn"
            onClick={() => setPaused(p => !p)}
            title={paused ? t('common.resume', 'Resume') : t('common.pause', 'Pause')}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            className={`mcpm-btn ${grouped ? 'active' : ''}`}
            onClick={() => setGrouped(g => !g)}
            title={grouped
              ? t('meshcore.packets.ungroupHelp', 'Show every reception separately')
              : t('meshcore.packets.groupHelp', 'Collapse receptions of the same frame into one row')}
          >
            {grouped
              ? t('meshcore.packets.grouped', 'Grouped')
              : t('meshcore.packets.flat', 'All')}
          </button>
          <button
            className={`mcpm-btn ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters(s => !s)}
            title={t('common.filters', 'Filters')}
          >
            <Filter size={14} />
          </button>
          <button
            className={`mcpm-btn ${showStats ? 'active' : ''}`}
            onClick={() => setShowStats(v => !v)}
            title={t('meshcore.packets.stats', 'Distribution charts')}
            aria-label={t('meshcore.packets.stats', 'Distribution charts')}
          >
            <BarChart3 size={14} />
          </button>
          <button className="mcpm-btn" onClick={() => void refresh()} title={t('common.refresh', 'Refresh')}>
            <RefreshCw size={14} />
          </button>
          <button className="mcpm-btn" onClick={() => void handleExport()} title={t('common.export', 'Export')}>
            <Download size={14} />
          </button>
          {!standalone && (
            <button
              className="mcpm-btn"
              onClick={() => openPacketMonitorPopout(sourceId)}
              title={t('packet_monitor.popout', 'Pop out')}
              aria-label={t('packet_monitor.popout', 'Pop out')}
            >
              <ExternalLink size={14} />
            </button>
          )}
          {canClear && (
            <button className="mcpm-btn mcpm-btn-danger" onClick={() => void handleClear()} title={t('common.clear', 'Clear')}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {!enabled && !notConnected && (
        <div className="mcpm-disabled-banner">
          <span>
            {t('meshcore.packets.disabled', 'MeshCore packet capture is off. No new packets will be recorded until you enable it.')}
          </span>
          {canWriteSettings && (
            <button className="mcpm-btn" disabled={savingSettings} onClick={() => void handleToggleEnabled()}>
              {t('meshcore.packets.enable', 'Enable capture')}
            </button>
          )}
        </div>
      )}

      {showFilters && (
        <div className={styles.filterBar}>
          <PacketSearchInput
            className={styles.searchInput}
            value={search}
            onCommit={setSearch}
            maxLength={100}
            placeholder={t('meshcore.packets.searchPlaceholder', 'Search name, type, hex, key…')}
            title={t('meshcore.packets.searchTitle', 'Matches advert name, payload type, raw hex and sender key. Channel text is encrypted and is not searched.')}
          />
          <TimeWindowSelect value={timeWindow} onChange={setTimeWindow} />
          <select
            value={payloadFilter}
            aria-label={t('meshcore.packets.payloadType', 'Payload')}
            onChange={e => setPayloadFilter(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">{t('meshcore.packets.payloadType', 'Payload')}: {t('common.all', 'All')}</option>
            {PAYLOAD_TYPES.map(pt => (
              <option key={pt.value} value={pt.value}>{pt.label}</option>
            ))}
          </select>
          <select
            value={routeFilter}
            aria-label={t('meshcore.packets.routeType', 'Route')}
            onChange={e => setRouteFilter(e.target.value === '' ? '' : Number(e.target.value))}
          >
            <option value="">{t('meshcore.packets.routeType', 'Route')}: {t('common.all', 'All')}</option>
            {ROUTE_TYPES.map(rt => (
              <option key={rt.value} value={rt.value}>{rt.label}</option>
            ))}
          </select>
          <div className={styles.senderSelect}>
            <SearchableSelect
              value={senderFilter}
              onChange={setSenderFilter}
              options={senderOptions}
              emptyLabel={t('meshcore.packets.anySender', 'Any sender')}
              placeholder={t('meshcore.packets.sender', 'Sender')}
            />
          </div>
          <input
            className={styles.hashInput}
            value={srcHashInput}
            maxLength={6}
            onChange={e => setSrcHashInput(e.target.value.trim())}
            placeholder={t('meshcore.packets.srcHash', 'Src hash')}
            aria-label={t('meshcore.packets.srcHash', 'Src hash')}
            title={t('meshcore.packets.srcHashHelp', 'Sender hash, 2 to 6 hex digits')}
          />
          <input
            className={styles.hashInput}
            value={pathHashInput}
            maxLength={6}
            onChange={e => setPathHashInput(e.target.value.trim())}
            placeholder={t('meshcore.packets.pathHash', 'Path hash')}
            aria-label={t('meshcore.packets.pathHash', 'Path hash')}
            title={t('meshcore.packets.pathHashHelp', 'Relay hash anywhere in the path, 2 to 6 hex digits')}
          />
          <button className="mcpm-btn" onClick={clearFilters} disabled={!hasActiveFilters && srcHashInput === '' && pathHashInput === ''}>
            {t('meshcore.packets.clearFilters', 'Clear filters')}
          </button>
        </div>
      )}

      {showFilters && canWriteSettings && (
        <div className="mcpm-filters">
          {canWriteSettings && (
            <>
              <label className="mcpm-toggle">
                <input type="checkbox" checked={enabled} disabled={savingSettings} onChange={() => void handleToggleEnabled()} />
                {t('meshcore.packets.captureEnabled', 'Capture enabled')}
              </label>
              <label>
                {t('meshcore.packets.maxCount', 'Max count')}
                <NumberInput
                  min={100}
                  max={isIngestSource ? 500000 : 50000}
                  step={100}
                  integer
                  value={maxCount}
                  onChange={setMaxCount}
                  onBlur={e => {
                    // Saves on blur. Invalid text was never emitted, so there
                    // is nothing new to send: skip the write (#5649).
                    if (e.currentTarget.dataset.numberInvalid === 'true') return;
                    void saveSettings(
                      // Retention is per-source-kind (#5040): an MQTT region feed
                      // writes one row per observer and has its own key, so
                      // writing the device key here would silently cap the wrong
                      // sources.
                      isIngestSource
                        ? { meshcore_mqtt_packet_log_max_count: String(maxCount) }
                        : { meshcore_packet_log_max_count: String(maxCount) },
                    );
                  }}
                />
              </label>
              {isIngestSource && (
                <span className="mcpm-setting-warning">
                  {t(
                    'meshcore.packets.ingestCapWarning',
                    'A region feed stores one row per observer that heard each frame. At 50,000 rows expect roughly 50–100MB of database per source — noticeable on a Pi or a small container volume.',
                  )}
                </span>
              )}
              <label>
                {t('meshcore.packets.maxAgeHours', 'Max age (h)')}
                <NumberInput
                  min={1}
                  max={720}
                  integer
                  value={maxAgeHours}
                  onChange={setMaxAgeHours}
                  onBlur={e => {
                    if (e.currentTarget.dataset.numberInvalid === 'true') return;
                    void saveSettings({ meshcore_packet_log_max_age_hours: String(maxAgeHours) });
                  }}
                />
              </label>
            </>
          )}
        </div>
      )}

      {notConnected && <SourceNotConnectedNotice />}
      {errorText && <div className="mcpm-error">{errorText}</div>}

      {showStats && (
        <div className={styles.statsStrip}>
          {distribution && distribution.total > 0 ? (
            <React.Suspense fallback={<span className={styles.statsEmpty}>{t('common.loading', 'Loading…')}</span>}>
              <PacketStatsChart
                bare
                stacked
                chartId="mc-by-payload"
                title={t('meshcore.packets.byPayload', 'By payload')}
                data={toChartEntries(distribution.byPayloadType, r => r.payloadTypeName ?? `0x${r.payloadType.toString(16)}`, r => r.count)}
                total={distribution.total}
              />
              <PacketStatsChart
                bare
                stacked
                chartId="mc-by-route"
                title={t('meshcore.packets.byRoute', 'By route')}
                data={toChartEntries(distribution.byRouteType, r => r.routeTypeName ?? '—', r => r.count)}
                total={distribution.total}
              />
              <PacketStatsChart
                bare
                stacked
                chartId="mc-by-sender"
                title={t('meshcore.packets.bySender', 'Top senders')}
                data={toChartEntries(
                  distribution.topSenders,
                  r => r.advertName || contactByKey.get(r.senderPubKey.toLowerCase())?.name || r.senderPubKey.slice(0, 8),
                  r => r.count,
                )}
                total={distribution.total}
              />
            </React.Suspense>
          ) : (
            <span className={styles.statsEmpty}>{t('meshcore.packets.statsEmpty', 'No packets in this window.')}</span>
          )}
        </div>
      )}

      {/* Not connected: the notice above replaces the empty table, whose
          "Waiting for OTA traffic" text would mislead (#4173 N5). */}
      {!notConnected && (
      <div className="mcpm-table-container">
        {loading ? (
          <div className="mcpm-empty">{t('common.loading', 'Loading…')}</div>
        ) : visiblePackets.length === 0 ? (
          <div className={isRepeaterSource ? `mcpm-empty ${styles.emptyStack}` : 'mcpm-empty'}>
            <span>
              {enabled
                ? t('meshcore.packets.empty', 'No packets captured yet. Waiting for OTA traffic…')
                : t('meshcore.packets.emptyDisabled', 'No packets captured. Enable capture to start recording.')}
            </span>
            {isRepeaterSource && (
              <p className={styles.repeaterNote} data-testid="mcpm-repeater-note">
                {t(
                  'meshcore.packets.repeaterNoStream',
                  'Stock MeshCore repeater firmware does not stream packets over serial. A repeater build with -D MESH_PACKET_LOGGING=1 prints each received frame, and MeshMonitor logs those here.',
                )}
              </p>
            )}
          </div>
        ) : (
          <div ref={parentRef} className={styles.list} role="table" data-testid="mcpm-list">
            <div className={`${styles.cols} ${styles.headRow} ${grouped ? styles.colsGrouped : ''}`} role="row">
              <div role="columnheader">{t('meshcore.packets.time', 'Time')}</div>
              <div role="columnheader">{t('meshcore.packets.payloadType', 'Payload')}</div>
              <div role="columnheader">{t('meshcore.packets.from', 'From')}</div>
              <div role="columnheader">{t('meshcore.packets.routeType', 'Route')}</div>
              <div role="columnheader">{t('meshcore.packets.hops', 'Hops')}</div>
              <div role="columnheader">{t('meshcore.packets.snr', 'SNR')}</div>
              <div role="columnheader">{t('meshcore.packets.rssi', 'RSSI')}</div>
              <div role="columnheader">{t('meshcore.packets.size', 'Size')}</div>
              {grouped && (
                <div role="columnheader" title={t('meshcore.packets.observersHelp', 'Distinct observers that heard this frame. "Local" means your own radio heard it.')}>
                  {t('meshcore.packets.observers', 'Observers')}
                </div>
              )}
              <div role="columnheader">{t('meshcore.packets.path', 'Path')}</div>
            </div>
            <div className={styles.listInner} style={{ height: rowVirtualizer.getTotalSize() }}>
              {rowVirtualizer.getVirtualItems().map(vr => {
                const rowStyle = { transform: `translateY(${vr.start}px)` };
                const p = visiblePackets[vr.index];
                if (!p) {
                  return (
                    <div key={`loader-${vr.index}`} className={`${styles.row} ${styles.cols} ${styles.loaderRow}`} style={rowStyle}>
                      {t('common.loading', 'Loading…')}
                    </div>
                  );
                }
                const from = resolveFrom(p);
                const dir = directionOf(p);
                return (
                  <div
                    key={p.id ?? `${p.timestamp}-${vr.index}`}
                    className={`${styles.row} ${styles.cols} ${grouped ? styles.colsGrouped : ''}`}
                    style={rowStyle}
                    role="row"
                    data-testid="mcpm-row"
                    onClick={() => setSelectedPacket(p)}
                    title={t('meshcore.packets.clickToDecode', 'Click to decode this packet')}
                  >
                    <div className={`${styles.cell} mcpm-mono`}>{formatTime(p.timestamp)}</div>
                    <div className={styles.cell}><span className="mcpm-badge">{payloadLabel(p)}</span></div>
                    <div className={styles.cell}>
                      {dir && (
                        <span
                          className={styles.dir}
                          data-testid={`mcpm-dir-${dir}`}
                          role="img"
                          aria-label={dir === 'tx'
                            ? t('meshcore.packets.dirTx', 'Sent by this node (own TX)')
                            : t('meshcore.packets.dirRx', 'Heard over the air (RX)')}
                          title={dir === 'tx'
                            ? t('meshcore.packets.dirTx', 'Sent by this node (own TX)')
                            : t('meshcore.packets.dirRx', 'Heard over the air (RX)')}
                        >
                          <UiIcon name={dir === 'tx' ? 'uploadData' : 'downloadData'} size={12} />
                        </span>
                      )}
                      {from.label === null ? (
                        <span className={styles.fromMuted}>—</span>
                      ) : from.publicKey && onNodeClick ? (
                        <button
                          type="button"
                          className={styles.fromButton}
                          onClick={e => { e.stopPropagation(); onNodeClick(from.publicKey!); }}
                          title={from.title ?? t('meshcore.packets.openContact', 'Open this contact')}
                        >
                          {from.label}
                        </button>
                      ) : (
                        <span title={from.title}>{from.label}</span>
                      )}
                    </div>
                    <div className={`${styles.cell} mcpm-route`}>{routeLabel(p)}</div>
                    <div className={`${styles.cell} mcpm-mono`}>{typeof p.hopCount === 'number' ? p.hopCount : '—'}</div>
                    <div className={`${styles.cell} mcpm-mono`}>{typeof p.snr === 'number' ? p.snr.toFixed(2) : '—'}</div>
                    <div className={`${styles.cell} mcpm-mono`}>{typeof p.rssi === 'number' ? p.rssi : '—'}</div>
                    <div className={`${styles.cell} mcpm-mono`}>{typeof p.payloadSize === 'number' ? p.payloadSize : '—'}</div>
                    {grouped && (
                      <div className={`${styles.cell} mcpm-mono`}>
                        {observerLabel(
                          Number((p as GroupedPacket).observerCount ?? 0),
                          t('meshcore.packets.observersLocal', 'Local'),
                        )}
                      </div>
                    )}
                    <div className={`${styles.cell} mcpm-mono mcpm-path`}>{p.pathHops || (p.pathLenRaw === 255 ? 'direct' : '—')}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      )}

      {selectedPacket &&
        createPortal(
          <MeshCorePacketDetailModal packet={selectedPacket} sourceId={sourceId} contacts={contacts} onClose={() => setSelectedPacket(null)} />,
          document.body
        )}
    </div>
  );
};

export default MeshCorePacketMonitorView;
