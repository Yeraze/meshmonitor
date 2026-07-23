/**
 * MqttPacketMonitorView — gateway-aware packet monitor for an MQTT source
 * (`mqtt_broker` / `mqtt_bridge`).
 *
 * MQTT's defining trait is N receptions per packet (one per gateway), so the
 * backend serves a query-time deduplicated/grouped list
 * (`GET /api/sources/:id/mqtt/packets`) rather than a raw reception feed.
 * There is no live socket event for the MQTT packet log (unlike MeshCore's
 * `meshcore:ota-packet`), so this view polls on a 5s interval instead of
 * subscribing — see MQTT_PACKET_MONITOR_PHASE2_SPEC.md §3.2 for the
 * justification.
 *
 * IMPORTANT: unlike the MeshCore `/packets` routes (which return bare
 * bodies), the MQTT Phase-1 routes use the `ok(res, {...})` envelope helper,
 * so every response here is wrapped in `{ success: true, data: {...} }` and
 * must be unwrapped via `body.data` (§2 of the spec — "the envelope
 * gotcha").
 *
 * WP1 shipped the toolbar/banner/table/polling/settings shell. WP2 adds the
 * gateway multi-select filter (§4 of the spec). The packet detail modal
 * (WP3) mounts near the end of the JSX.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Filter, Trash2, Pause, Play, RefreshCw, ChevronDown } from 'lucide-react';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useAuth } from '../../contexts/AuthContext';
import { useNodes } from '../../hooks/useServerData';
import type { MqttGroupedPacket, MqttGateway } from './mqttPacketTypes';
import MqttPacketDetailModal from './MqttPacketDetailModal';
import './MqttPacketMonitor.css';

interface MqttPacketMonitorViewProps {
  baseUrl: string;
  sourceId: string;
}

const BROADCAST_NODE_NUM = 0xffffffff;

// Safe JSON parse helper — mirrors PacketMonitorPanel.tsx's localStorage guard.
const safeJsonParse = <T,>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.warn('Failed to parse JSON from localStorage:', error);
    return fallback;
  }
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

const ENCRYPTED_OUTCOME_BADGES = new Set(['encrypted', 'ignored', 'geo-ignored', 'distance', 'unsupported-portnum', 'decode-error']);

function outcomeBadgeClass(outcome: string): string {
  switch (outcome) {
    case 'encrypted':
      return 'mqpm-badge mqpm-badge-encrypted';
    case 'ignored':
      return 'mqpm-badge mqpm-badge-ignored';
    case 'geo-ignored':
      return 'mqpm-badge mqpm-badge-geo-ignored';
    case 'distance':
      return 'mqpm-badge mqpm-badge-distance';
    case 'unsupported-portnum':
    case 'decode-error':
      return 'mqpm-badge mqpm-badge-error';
    default:
      return 'mqpm-badge';
  }
}

export const MqttPacketMonitorView: React.FC<MqttPacketMonitorViewProps> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { hasPermission } = useAuth();
  const { nodes } = useNodes();

  const canWriteSettings = hasPermission('settings', 'write');
  const canClear = hasPermission('packetmonitor', 'write');

  const prefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/mqtt/packets`;

  const nodeName = useCallback((n: number | null): string | null => {
    if (n === null) return null;
    const node = nodes.find(node => node.nodeNum === n);
    if (!node) return null;
    return node.user?.longName || node.user?.shortName || `Node ${n}`;
  }, [nodes]);

  const [packets, setPackets] = useState<MqttGroupedPacket[]>([]);
  const [total, setTotal] = useState(0);
  const [gateways, setGateways] = useState<MqttGateway[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [gatewayDropdownOpen, setGatewayDropdownOpen] = useState(false);

  const [showFilters, setShowFilters] = useState(() =>
    safeJsonParse(localStorage.getItem('mqttPacketMonitor.showFilters'), false)
  );
  const [selectedGateways, setSelectedGateways] = useState<string[]>(() =>
    safeJsonParse<string[]>(localStorage.getItem('mqttPacketMonitor.selectedGateways'), [])
  );
  const [encryptedFilter, setEncryptedFilter] = useState<'' | '1' | '0'>(() =>
    safeJsonParse<'' | '1' | '0'>(localStorage.getItem('mqttPacketMonitor.encryptedFilter'), '')
  );
  const [portnumFilter, setPortnumFilter] = useState<number | ''>(() =>
    safeJsonParse<number | ''>(localStorage.getItem('mqttPacketMonitor.portnumFilter'), '')
  );

  const [enabled, setEnabled] = useState(false);
  const [maxCount, setMaxCount] = useState(5000);
  const [maxAgeHours, setMaxAgeHours] = useState(24);
  const [savingSettings, setSavingSettings] = useState(false);

  const [selectedPacket, setSelectedPacket] = useState<MqttGroupedPacket | null>(null);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const hasLoadedOnceRef = useRef(false);
  const gatewayDropdownRef = useRef<HTMLDivElement>(null);

  // Close the gateway dropdown when clicking outside it.
  useEffect(() => {
    if (!gatewayDropdownOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (gatewayDropdownRef.current && !gatewayDropdownRef.current.contains(event.target as Node)) {
        setGatewayDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [gatewayDropdownOpen]);

  // Persist filter/UI state to localStorage.
  useEffect(() => {
    localStorage.setItem('mqttPacketMonitor.showFilters', JSON.stringify(showFilters));
  }, [showFilters]);
  useEffect(() => {
    localStorage.setItem('mqttPacketMonitor.selectedGateways', JSON.stringify(selectedGateways));
  }, [selectedGateways]);
  useEffect(() => {
    localStorage.setItem('mqttPacketMonitor.encryptedFilter', JSON.stringify(encryptedFilter));
  }, [encryptedFilter]);
  useEffect(() => {
    localStorage.setItem('mqttPacketMonitor.portnumFilter', JSON.stringify(portnumFilter));
  }, [portnumFilter]);

  const load = useCallback(async () => {
    // Only show the full-page spinner on the very first load — subsequent
    // polls/refetches update the table in place.
    if (!hasLoadedOnceRef.current) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedGateways.length) params.set('gateways', selectedGateways.join(','));
      if (encryptedFilter !== '') params.set('encrypted', encryptedFilter);
      if (portnumFilter !== '') params.set('portnum', String(portnumFilter));
      // Don't send an explicit limit: let the server apply the configured
      // mqtt_packet_log_max_count as the effective page size.
      const res = await csrfFetch(`${prefix}?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const payload = body.data ?? body; // MQTT routes always wrap in {success,data}
      setPackets(Array.isArray(payload.packets) ? payload.packets : []);
      if (typeof payload.total === 'number') setTotal(payload.total);
      if (typeof payload.enabled === 'boolean') setEnabled(payload.enabled);
      if (typeof payload.maxCount === 'number') setMaxCount(payload.maxCount);
      if (typeof payload.maxAgeHours === 'number') setMaxAgeHours(payload.maxAgeHours);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load packets');
    } finally {
      hasLoadedOnceRef.current = true;
      setLoading(false);
    }
  }, [csrfFetch, prefix, selectedGateways, encryptedFilter, portnumFilter]);

  const loadGateways = useCallback(async () => {
    try {
      const res = await csrfFetch(`${prefix}/gateways`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const payload = body.data ?? body;
      const list: MqttGateway[] = Array.isArray(payload.gateways) ? payload.gateways : [];
      list.sort((a, b) => b.receptionCount - a.receptionCount);
      setGateways(list);
    } catch {
      // Non-fatal: the gateway filter simply stays empty.
      setGateways([]);
    }
  }, [csrfFetch, prefix]);

  // Initial load + reload whenever a filter changes.
  useEffect(() => {
    void load();
  }, [load]);

  // Gateway list: fetch once on mount (and available to be refreshed
  // alongside manual refresh by WP2's dropdown control).
  useEffect(() => {
    void loadGateways();
  }, [loadGateways]);

  // Poll every 5s; skip the tick while paused. No socket event exists for
  // the MQTT packet log (unlike MeshCore's meshcore:ota-packet).
  useEffect(() => {
    const id = setInterval(() => {
      if (!pausedRef.current) void load();
    }, 5000);
    return () => clearInterval(id);
  }, [load]);

  const saveSettings = useCallback(async (patch: Record<string, string>) => {
    setSavingSettings(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  }, [csrfFetch, baseUrl]);

  const handleToggleEnabled = useCallback(async () => {
    const next = !enabled;
    setEnabled(next);
    await saveSettings({ mqtt_packet_log_enabled: next ? '1' : '0' });
  }, [enabled, saveSettings]);

  const handleClear = useCallback(async () => {
    if (!window.confirm(t('mqtt.packets.clearConfirm', 'Clear the captured MQTT packet log for this source?'))) {
      return;
    }
    try {
      const res = await csrfFetch(prefix, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPackets([]);
      setTotal(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear packets');
    }
  }, [csrfFetch, prefix, t]);

  const toggleGateway = useCallback((gatewayId: string, checked: boolean) => {
    setSelectedGateways(prev => (
      checked ? [...prev, gatewayId] : prev.filter(id => id !== gatewayId)
    ));
  }, []);

  const selectAllGateways = useCallback(() => {
    setSelectedGateways(gateways.map(g => g.gatewayId));
  }, [gateways]);

  const clearGatewaySelection = useCallback(() => {
    setSelectedGateways([]);
  }, []);

  const renderFrom = useCallback((p: MqttGroupedPacket): string => {
    return nodeName(p.fromNode) ?? p.fromNodeId ?? '—';
  }, [nodeName]);

  const renderTo = useCallback((p: MqttGroupedPacket): string => {
    if (p.toNode === BROADCAST_NODE_NUM || p.toNodeId === '!ffffffff') {
      return t('common.broadcast', 'Broadcast');
    }
    return nodeName(p.toNode) ?? p.toNodeId ?? '—';
  }, [nodeName, t]);

  const renderType = useCallback((p: MqttGroupedPacket) => {
    if (p.encrypted && !p.portnumName && ENCRYPTED_OUTCOME_BADGES.has(p.ingestOutcome)) {
      return <span className={outcomeBadgeClass(p.ingestOutcome)}>{p.ingestOutcome}</span>;
    }
    return <span className="mqpm-badge">{p.portnumName ?? '—'}</span>;
  }, []);

  return (
    <div className="mqtt-packet-monitor">
      <div className="mqpm-header">
        <h3>{t('mqtt.packets.title', 'Packet Monitor')}</h3>
        <span className="mqpm-count">
          {total > packets.length ? `${packets.length} / ${total}` : packets.length}
        </span>
        <div className="mqpm-header-controls">
          <button
            className="mqpm-btn"
            onClick={() => setPaused(p => !p)}
            title={paused ? t('common.resume', 'Resume') : t('common.pause', 'Pause')}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            className={`mqpm-btn ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters(s => !s)}
            title={t('common.filters', 'Filters')}
          >
            <Filter size={14} />
          </button>
          <button
            className="mqpm-btn"
            onClick={() => { void load(); void loadGateways(); }}
            title={t('common.refresh', 'Refresh')}
          >
            <RefreshCw size={14} />
          </button>
          {canClear && (
            <button className="mqpm-btn mqpm-btn-danger" onClick={() => void handleClear()} title={t('common.clear', 'Clear')}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {!enabled && (
        <div className="mqpm-disabled-banner">
          <span>
            {t('mqtt.packets.disabled', 'MQTT packet capture is off. No new packets will be recorded until you enable it.')}
          </span>
          {canWriteSettings && (
            <button className="mqpm-btn" disabled={savingSettings} onClick={() => void handleToggleEnabled()}>
              {t('mqtt.packets.enable', 'Enable capture')}
            </button>
          )}
        </div>
      )}

      {showFilters && (
        <div className="mqpm-filters">
          <div className="mqpm-gateway-dropdown" ref={gatewayDropdownRef}>
            <button
              type="button"
              className={`mqpm-btn ${selectedGateways.length > 0 ? 'active' : ''}`}
              onClick={() => {
                // Refresh the gateway list on closed->open so the panel is
                // always fresh at the moment of use — new gateways appear
                // over time and mount-only loading left the list stale.
                if (!gatewayDropdownOpen) void loadGateways();
                setGatewayDropdownOpen(o => !o);
              }}
            >
              {t('mqtt.packets.gateways', 'Gateways')}
              {' '}
              ({selectedGateways.length > 0 ? selectedGateways.length : t('common.all', 'all')})
              <ChevronDown size={12} />
            </button>
            {gatewayDropdownOpen && (
              <div className="mqpm-gateway-dropdown-panel">
                <div className="mqpm-gateway-dropdown-actions">
                  <button type="button" onClick={selectAllGateways}>
                    {t('mqtt.packets.selectAll', 'Select all')}
                  </button>
                  <button type="button" onClick={clearGatewaySelection}>
                    {t('mqtt.packets.clearSelection', 'Clear')}
                  </button>
                </div>
                {gateways.length === 0 ? (
                  <div className="mqpm-gateway-option">{t('common.none', 'None')}</div>
                ) : (
                  gateways.map(gw => (
                    <label key={gw.gatewayId} className="mqpm-gateway-option">
                      <input
                        type="checkbox"
                        checked={selectedGateways.includes(gw.gatewayId)}
                        onChange={e => toggleGateway(gw.gatewayId, e.target.checked)}
                      />
                      <span>{nodeName(gw.gatewayNodeNum) ?? gw.gatewayId}</span>
                      <span className="mqpm-gateway-option-count">{gw.receptionCount}</span>
                    </label>
                  ))
                )}
              </div>
            )}
          </div>
          <label>
            {t('mqtt.packets.encrypted', 'Encrypted')}
            <select
              value={encryptedFilter}
              onChange={e => setEncryptedFilter(e.target.value as '' | '1' | '0')}
            >
              <option value="">{t('common.all', 'All')}</option>
              <option value="1">{t('mqtt.packets.encrypted', 'Encrypted')}</option>
              <option value="0">{t('mqtt.packets.decrypted', 'Decrypted')}</option>
            </select>
          </label>
          <label>
            {t('mqtt.packets.portnum', 'Port')}
            <input
              type="number"
              min={0}
              value={portnumFilter}
              onChange={e => setPortnumFilter(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </label>
          {selectedGateways.length > 0 && (
            <div className="mqpm-filter-note">
              {t('mqtt.packets.gatewayCountFiltered', 'Gateway counts reflect the selected gateways only.')}
            </div>
          )}
          {canWriteSettings && (
            <>
              <label className="mqpm-toggle">
                <input type="checkbox" checked={enabled} disabled={savingSettings} onChange={() => void handleToggleEnabled()} />
                {t('mqtt.packets.captureEnabled', 'Capture enabled')}
              </label>
              <label>
                {t('mqtt.packets.maxCount', 'Max count')}
                <input
                  type="number"
                  min={100}
                  max={50000}
                  step={100}
                  value={maxCount}
                  onChange={e => setMaxCount(Number(e.target.value))}
                  onBlur={() => void saveSettings({ mqtt_packet_log_max_count: String(maxCount) })}
                />
              </label>
              <label>
                {t('mqtt.packets.maxAgeHours', 'Max age (h)')}
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={maxAgeHours}
                  onChange={e => setMaxAgeHours(Number(e.target.value))}
                  onBlur={() => void saveSettings({ mqtt_packet_log_max_age_hours: String(maxAgeHours) })}
                />
              </label>
            </>
          )}
        </div>
      )}

      {error && <div className="mqpm-error">{error}</div>}

      <div className="mqpm-table-container">
        {loading ? (
          <div className="mqpm-empty">{t('common.loading', 'Loading…')}</div>
        ) : packets.length === 0 ? (
          <div className="mqpm-empty">
            {enabled
              ? t('mqtt.packets.empty', 'No packets captured yet. Waiting for MQTT traffic…')
              : t('mqtt.packets.emptyDisabled', 'No packets captured. Enable capture to start recording.')}
          </div>
        ) : (
          <table className="mqpm-table">
            <thead>
              <tr>
                <th>{t('mqtt.packets.time', 'Time')}</th>
                <th>{t('mqtt.packets.from', 'From')}</th>
                <th>{t('mqtt.packets.to', 'To')}</th>
                <th>{t('mqtt.packets.type', 'Type')}</th>
                <th>{t('mqtt.packets.channel', 'Channel')}</th>
                <th
                  title={selectedGateways.length > 0
                    ? t('mqtt.packets.gatewayCountFiltered', 'Gateway counts reflect the selected gateways only.')
                    : undefined}
                >
                  {t('mqtt.packets.gatewayCount', 'Gateways')}
                </th>
                <th>{t('mqtt.packets.size', 'Size')}</th>
                <th>{t('mqtt.packets.preview', 'Preview')}</th>
              </tr>
            </thead>
            <tbody>
              {packets.map(p => {
                const key = `${p.packetId}-${p.fromNode}-${p.lastHeard}`;
                return (
                  <tr
                    key={key}
                    className="mqpm-row"
                    onClick={() => setSelectedPacket(p)}
                    title={t('mqtt.packets.clickToView', 'Click to view receptions')}
                  >
                    <td className="mqpm-mono">{formatTime(p.lastHeard)}</td>
                    <td>{renderFrom(p)}</td>
                    <td>{renderTo(p)}</td>
                    <td>{renderType(p)}</td>
                    <td>{p.channelId ?? (p.channel != null ? `#${p.channel}` : '—')}</td>
                    <td
                      className="mqpm-mono"
                      title={`${p.receptionCount} ${t('mqtt.packets.receptions', 'Receptions')}${
                        selectedGateways.length > 0 ? ` — ${t('mqtt.packets.gatewayCountFiltered', 'Gateway counts reflect the selected gateways only.')}` : ''
                      }`}
                    >
                      {p.gatewayCount}
                    </td>
                    <td className="mqpm-mono">{p.payloadSize ?? '—'}</td>
                    <td className="mqpm-mono mqpm-preview">{p.payloadPreview ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedPacket && createPortal(
        <MqttPacketDetailModal
          packet={selectedPacket}
          prefix={prefix}
          csrfFetch={csrfFetch}
          nodeName={nodeName}
          onClose={() => setSelectedPacket(null)}
        />,
        document.body
      )}
    </div>
  );
};

export default MqttPacketMonitorView;
