/**
 * Unified Packet Monitor Page
 *
 * Cross-source RF packet monitor (issue #3252). Replicates the single-source
 * Packet Monitor but merges packets from every source the user can read, tagged
 * with a colored Source badge. NO dedup — a packet heard by N sources shows as N
 * rows (one per receiving radio). Combines three views in one pane:
 *   - live virtualized packet stream (+ source/type filters)
 *   - distribution charts (by source / by device / by type)
 *   - packets-by-type breakdown
 *
 * Renders inside sharedProviders (Csrf/Auth/WebSocket) + the root
 * QueryClientProvider, but OUTSIDE SettingsProvider — so time/date prefs are read
 * straight from localStorage (same keys SettingsContext persists).
 */
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Filter, BarChart3, Pause, Play } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAuth } from '../contexts/AuthContext';
import { useUnifiedPackets } from '../hooks/useUnifiedPackets';
import { getUnifiedPacketDistribution } from '../services/packetApi';
import { PacketLog, UnifiedPacketFilters, UnifiedPacketDistribution } from '../types/packet';
import PacketStatsChart, { DISTRIBUTION_COLORS, ChartDataEntry } from '../components/PacketStatsChart';
import {
  getTransportMechanismName,
  getPortnumColor,
  formatPacketDateColumn,
  formatPacketTimestamp,
} from '../utils/packetFormat';
import { getSourceColor } from '../utils/sourceColors';
import '../components/PacketMonitorPanel.css';
import './UnifiedPacketMonitorPage.css';

const ROW_HEIGHT = 36;

// Safe JSON parse helper (mirrors PacketMonitorPanel).
function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type RangeHours = 1 | 24 | 0; // 0 = all
const RANGE_OPTIONS: RangeHours[] = [1, 24, 0];

export default function UnifiedPacketMonitorPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { hasPermission } = useAuth();

  // Read time/date prefs directly (page renders outside SettingsProvider).
  const timeFormat = localStorage.getItem('timeFormat') === '12' ? '12' : '24';
  const dateFormat = (() => {
    const saved = localStorage.getItem('dateFormat');
    return saved === 'DD/MM/YYYY' || saved === 'YYYY-MM-DD' ? saved : 'MM/DD/YYYY';
  })();

  const canView = hasPermission('packetmonitor', 'read', { anySource: true });

  const [filters, setFilters] = useState<UnifiedPacketFilters>(() =>
    safeJsonParse<UnifiedPacketFilters>(localStorage.getItem('unifiedPacketMonitor.filters'), {})
  );
  const [showFilters, setShowFilters] = useState(() =>
    safeJsonParse(localStorage.getItem('unifiedPacketMonitor.showFilters'), false)
  );
  const [showCharts, setShowCharts] = useState(() =>
    safeJsonParse(localStorage.getItem('unifiedPacketMonitor.showCharts'), true)
  );
  const [paused, setPaused] = useState(false);
  const [selectedPacket, setSelectedPacket] = useState<PacketLog | null>(null);
  const [rangeHours, setRangeHours] = useState<RangeHours>(24);

  const parentRef = useRef<HTMLDivElement>(null);

  const { packets, sources, loading, loadingMore, hasMore, rateLimitError, loadMore } = useUnifiedPackets({
    canView,
    filters,
    paused,
  });

  // Stable source-id list for color assignment (sorted so colors are stable).
  const sourceIds = useMemo(() => sources.map((s) => s.id).sort(), [sources]);

  // Persist UI prefs.
  useEffect(() => { localStorage.setItem('unifiedPacketMonitor.filters', JSON.stringify(filters)); }, [filters]);
  useEffect(() => { localStorage.setItem('unifiedPacketMonitor.showFilters', JSON.stringify(showFilters)); }, [showFilters]);
  useEffect(() => { localStorage.setItem('unifiedPacketMonitor.showCharts', JSON.stringify(showCharts)); }, [showCharts]);

  // ── Distribution charts ──────────────────────────────────────────────────
  const [distribution, setDistribution] = useState<UnifiedPacketDistribution | null>(null);
  useEffect(() => {
    if (!canView || !showCharts) return;
    let cancelled = false;
    const fetchDist = async () => {
      try {
        const since = rangeHours === 0 ? undefined : Date.now() - rangeHours * 3600 * 1000;
        const data = await getUnifiedPacketDistribution(since);
        if (!cancelled) setDistribution(data);
      } catch (err) {
        console.error('Failed to fetch unified packet distribution:', err);
      }
    };
    fetchDist();
    const iv = paused ? undefined : setInterval(fetchDist, 30000);
    return () => { cancelled = true; if (iv) clearInterval(iv); };
  }, [canView, showCharts, rangeHours, paused]);

  const bySourceData: ChartDataEntry[] = useMemo(
    () => (distribution?.bySource ?? []).map((s) => ({
      name: s.sourceName,
      value: s.count,
      color: getSourceColor(s.sourceId, sourceIds),
    })),
    [distribution, sourceIds]
  );
  const byDeviceData: ChartDataEntry[] = useMemo(
    () => (distribution?.byDevice ?? []).map((d, i) => ({
      name: d.from_node_longName || d.from_node_id || `!${d.from_node.toString(16).padStart(8, '0')}`,
      value: d.count,
      color: DISTRIBUTION_COLORS[i % DISTRIBUTION_COLORS.length],
    })),
    [distribution]
  );
  const byTypeData: ChartDataEntry[] = useMemo(
    () => (distribution?.byType ?? []).map((tt) => ({
      name: tt.portnum_name || String(tt.portnum),
      value: tt.count,
      color: getPortnumColor(tt.portnum),
    })),
    [distribution]
  );
  const distTotal = distribution?.total ?? 0;

  // ── Virtual scrolling + infinite load ────────────────────────────────────
  const rowVirtualizer = useVirtualizer({
    count: hasMore ? packets.length + 1 : packets.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVirtualItemIndex = virtualItems[virtualItems.length - 1]?.index;
  useEffect(() => {
    if (lastVirtualItemIndex === undefined) return;
    if (lastVirtualItemIndex >= packets.length - 10 && hasMore && !loadingMore && packets.length > 0) {
      loadMore();
    }
  }, [lastVirtualItemIndex, packets.length, hasMore, loadingMore, loadMore]);

  const calculateHops = (p: PacketLog): number | null =>
    p.hop_start !== undefined && p.hop_limit !== undefined ? p.hop_start - p.hop_limit : null;

  const updateFilter = useCallback(<K extends keyof UnifiedPacketFilters>(key: K, value: UnifiedPacketFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }, []);

  if (!canView) {
    return (
      <div className="unified-packets-page">
        <div className="unified-packets-header">
          <button className="unified-packets-back" onClick={() => navigate('/', { state: { showList: true } })}>
            {t('unified.back_to_sources')}
          </button>
          <h1>{t('unified.packets.title', 'Unified Packet Monitor')}</h1>
        </div>
        <div className="packet-monitor-no-permission">
          <p>{t('packet_monitor.no_permission')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="unified-packets-page">
      <div className="unified-packets-header">
        <button className="unified-packets-back" onClick={() => navigate('/', { state: { showList: true } })}>
          {t('unified.back_to_sources')}
        </button>
        <div className="unified-packets-title">
          <h1>{t('unified.packets.title', 'Unified Packet Monitor')}</h1>
          <p>{t('unified.packets.subtitle', 'Live packet stream across all sources')}</p>
        </div>
        <div className="unified-packets-count" title={t('unified.packets.count', { shown: packets.length })}>
          {t('unified.packets.count', { shown: packets.length })}
        </div>
        <div className="unified-packets-controls">
          <button
            className={`control-btn${paused ? '' : ' active'}`}
            onClick={() => setPaused((p) => !p)}
            title={paused ? t('packet_monitor.resume_autoscroll') : t('packet_monitor.pause_autoscroll')}
            aria-label={paused ? t('packet_monitor.resume_autoscroll') : t('packet_monitor.pause_autoscroll')}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            className={`control-btn${showCharts ? ' active' : ''}`}
            onClick={() => setShowCharts((s) => !s)}
            title={t('unified.packets.toggle_charts', 'Toggle charts')}
            aria-label={t('unified.packets.toggle_charts', 'Toggle charts')}
          >
            <BarChart3 size={14} />
          </button>
          <button
            className={`control-btn${showFilters ? ' active' : ''}`}
            onClick={() => setShowFilters((s) => !s)}
            title={t('packet_monitor.toggle_filters')}
            aria-label={t('packet_monitor.toggle_filters')}
          >
            <Filter size={14} />
          </button>
        </div>
      </div>

      {showFilters && (
        <div className="packet-filters unified-packets-filters">
          <select
            value={filters.sourceId ?? ''}
            onChange={(e) => updateFilter('sourceId', e.target.value || undefined)}
            aria-label={t('unified.packets.filter_source', 'Filter by source')}
          >
            <option value="">{t('unified.telemetry.all_sources', 'All sources')}</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          <select
            value={filters.portnum ?? ''}
            onChange={(e) => updateFilter('portnum', e.target.value ? parseInt(e.target.value, 10) : undefined)}
          >
            <option value="">{t('packet_monitor.filter.all_types')}</option>
            <option value="1">TEXT_MESSAGE</option>
            <option value="3">POSITION</option>
            <option value="4">NODEINFO</option>
            <option value="5">ROUTING</option>
            <option value="6">ADMIN</option>
            <option value="67">TELEMETRY</option>
            <option value="70">TRACEROUTE</option>
            <option value="71">NEIGHBORINFO</option>
          </select>

          <select
            value={filters.encrypted !== undefined ? (filters.encrypted ? 'true' : 'false') : ''}
            onChange={(e) => updateFilter('encrypted', e.target.value ? e.target.value === 'true' : undefined)}
          >
            <option value="">{t('packet_monitor.filter.all_packets')}</option>
            <option value="true">{t('packet_monitor.filter.encrypted_only')}</option>
            <option value="false">{t('packet_monitor.filter.decoded_only')}</option>
          </select>

          <select
            value={filters.transport_mechanism ?? ''}
            onChange={(e) => updateFilter('transport_mechanism', e.target.value !== '' ? parseInt(e.target.value, 10) : undefined)}
            title={t('packet_monitor.filter.transport_tooltip')}
          >
            <option value="">{t('packet_monitor.filter.all_transports')}</option>
            <option value="1">{t('packet_monitor.filter.transport_lora')}</option>
            <option value="6">{t('packet_monitor.filter.transport_udp')}</option>
            <option value="5">{t('packet_monitor.filter.transport_mqtt')}</option>
            <option value="7">{t('packet_monitor.filter.transport_api')}</option>
            <option value="0">{t('packet_monitor.filter.transport_internal')}</option>
          </select>

          <button onClick={() => setFilters({})} className="clear-filters-btn">
            {t('packet_monitor.filter.clear')}
          </button>
        </div>
      )}

      {showCharts && (
        <div className="unified-packets-charts">
          <div className="unified-packets-charts__range unified-btn-group">
            {RANGE_OPTIONS.map((r) => (
              <button key={r} className={rangeHours === r ? 'active' : ''} onClick={() => setRangeHours(r)}>
                {r === 0 ? t('unified.packets.range_all', 'All') : r === 1 ? '1h' : '24h'}
              </button>
            ))}
          </div>
          <div className="unified-packets-charts__grid">
            <PacketStatsChart bare stacked chartId="unified-by-source" title={t('unified.packets.by_source', 'By Source')} data={bySourceData} total={distTotal} />
            <PacketStatsChart bare stacked chartId="unified-by-device" title={t('unified.packets.by_device', 'By Device')} data={byDeviceData} total={distTotal} />
            <PacketStatsChart bare stacked chartId="unified-by-type" title={t('unified.packets.by_type', 'By Type')} data={byTypeData} total={distTotal} />
          </div>
        </div>
      )}

      <div className="packet-table-container unified-packets-table" ref={parentRef}>
        {rateLimitError && (
          <div className="rate-limit-warning" style={{ padding: '1rem', margin: '1rem' }}>
            ⚠️ {t('packet_monitor.rate_limit_warning')}
          </div>
        )}
        {loading ? (
          <div className="loading">{t('packet_monitor.loading')}</div>
        ) : packets.length === 0 ? (
          <div className="no-packets">{t('packet_monitor.no_packets')}</div>
        ) : (
          <div style={{ width: '100%' }}>
            <table className="packet-table packet-table-fixed">
              <colgroup>
                <col style={{ width: '50px' }} />
                <col style={{ width: '120px' }} />
                <col style={{ width: '35px' }} />
                <col style={{ width: '45px' }} />
                <col style={{ width: '55px' }} />
                <col style={{ width: '110px' }} />
                <col style={{ width: '140px' }} />
                <col style={{ width: '140px' }} />
                <col style={{ width: '120px' }} />
                <col style={{ width: '70px' }} />
                <col style={{ width: '60px' }} />
                <col style={{ width: '60px' }} />
                <col style={{ width: '60px' }} />
                <col style={{ width: '60px' }} />
                <col style={{ minWidth: '200px' }} />
              </colgroup>
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('unified.packets.column_source', 'Source')}</th>
                  <th>{t('packet_monitor.column.dir')}</th>
                  <th>{t('packet_monitor.column.via')}</th>
                  <th>{t('packet_monitor.column.date')}</th>
                  <th>{t('packet_monitor.column.time')}</th>
                  <th>{t('packet_monitor.column.from')}</th>
                  <th>{t('packet_monitor.column.to')}</th>
                  <th>{t('packet_monitor.column.type')}</th>
                  <th>{t('packet_monitor.column.slot')}</th>
                  <th>{t('packet_monitor.column.snr')}</th>
                  <th>{t('packet_monitor.column.rssi')}</th>
                  <th>{t('packet_monitor.column.hops')}</th>
                  <th>{t('packet_monitor.column.size')}</th>
                  <th>{t('packet_monitor.column.content')}</th>
                </tr>
              </thead>
            </table>
            <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
              <table className="packet-table packet-table-fixed">
                <colgroup>
                  <col style={{ width: '50px' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '35px' }} />
                  <col style={{ width: '45px' }} />
                  <col style={{ width: '55px' }} />
                  <col style={{ width: '110px' }} />
                  <col style={{ width: '140px' }} />
                  <col style={{ width: '140px' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ minWidth: '200px' }} />
                </colgroup>
                <tbody>
                  {virtualItems.map((virtualRow) => {
                    const isLoaderRow = virtualRow.index > packets.length - 1;
                    const packet = packets[virtualRow.index];

                    if (isLoaderRow) {
                      return (
                        <tr
                          key="loader"
                          onClick={() => loadMore()}
                          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)`, display: 'table', tableLayout: 'fixed', cursor: 'pointer' }}
                        >
                          <td colSpan={15} style={{ textAlign: 'center', color: 'var(--ctp-blue, var(--text-secondary))' }}>
                            {loadingMore ? t('packet_monitor.loading_more') : t('packet_monitor.load_more_click', 'Click to load more packets...')}
                          </td>
                        </tr>
                      );
                    }

                    const hops = calculateHops(packet);
                    const srcColor = packet.sourceId ? getSourceColor(packet.sourceId, sourceIds) : 'var(--text-secondary)';
                    return (
                      <tr
                        key={`${packet.sourceId}_${packet.id}`}
                        onClick={() => setSelectedPacket(packet)}
                        className={selectedPacket?.id === packet.id && selectedPacket?.sourceId === packet.sourceId ? 'selected' : ''}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)`, display: 'table', tableLayout: 'fixed' }}
                      >
                        <td className="packet-number" style={{ textAlign: 'right' }}>{virtualRow.index + 1}</td>
                        <td className="unified-packets-source-cell" title={packet.sourceName}>
                          <span
                            className="unified-packets-source-badge"
                            style={{ background: `color-mix(in srgb, ${srcColor} 18%, transparent)`, color: srcColor, border: `1px solid color-mix(in srgb, ${srcColor} 38%, transparent)` }}
                          >
                            {packet.sourceName}
                          </span>
                        </td>
                        <td className={`direction ${packet.direction === 'tx' ? 'direction-tx' : 'direction-rx'}`} title={packet.direction === 'tx' ? t('packet_monitor.direction_tx') : t('packet_monitor.direction_rx')}>
                          {packet.direction === 'tx' ? 'TX' : 'RX'}
                        </td>
                        <td className={`transport-mechanism transport-${packet.transport_mechanism ?? 'unknown'}`} title={getTransportMechanismName(packet.transport_mechanism).full}>
                          {getTransportMechanismName(packet.transport_mechanism).short}
                        </td>
                        <td className="date">{formatPacketDateColumn(packet.timestamp, dateFormat, t('packet_monitor.today', 'Today'))}</td>
                        <td className="timestamp">{formatPacketTimestamp(packet.timestamp, timeFormat)}</td>
                        <td className="from-node" title={packet.from_node_longName || packet.from_node_id || ''}>
                          {packet.from_node_longName || packet.from_node_id || packet.from_node}
                        </td>
                        <td className="to-node" title={packet.to_node_longName || packet.to_node_id || ''}>
                          {packet.to_node_id === '!ffffffff'
                            ? t('packet_monitor.broadcast')
                            : packet.to_node_longName || packet.to_node_id || packet.to_node || t('common.na')}
                        </td>
                        <td className="portnum" style={{ color: getPortnumColor(packet.portnum) }} title={packet.portnum_name || ''}>
                          {packet.portnum_name || packet.portnum}
                        </td>
                        <td className="channel">
                          {packet.encrypted && packet.channel !== undefined && packet.channel > 7 ? `?? (${packet.channel})` : (packet.channel ?? t('common.na'))}
                        </td>
                        <td className="snr">{packet.snr !== null && packet.snr !== undefined ? packet.snr.toFixed(1) : t('common.na')}</td>
                        <td className="rssi">{packet.rssi !== null && packet.rssi !== undefined ? packet.rssi.toFixed(0) : t('common.na')}</td>
                        <td className="hops">{hops !== null ? `${hops}/${packet.hop_start}` : t('common.na')}</td>
                        <td className="size">{packet.payload_size ?? t('common.na')}</td>
                        <td className="content">
                          {packet.encrypted ? (
                            <span className="encrypted-indicator">🔒 {t('packet_monitor.encrypted')}</span>
                          ) : (
                            <span className="content-preview">{packet.payload_preview || t('packet_monitor.no_preview')}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {selectedPacket &&
        createPortal(
          <div className="packet-detail-modal" onClick={() => setSelectedPacket(null)}>
            <div className="packet-detail-content" onClick={(e) => e.stopPropagation()}>
              <div className="packet-detail-header">
                <h4>{t('packet_monitor.details_title')}</h4>
                <button className="close-btn" onClick={() => setSelectedPacket(null)} aria-label={t('common.close')}>×</button>
              </div>
              <div className="packet-detail-body">
                <div className="packet-detail-fields">
                  {Object.entries(selectedPacket)
                    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
                    .map(([key, value]) => (
                      <div key={key} className="detail-row">
                        <span className="detail-label">{key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</span>
                        <span className="detail-value">{String(value)}</span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
