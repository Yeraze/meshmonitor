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
 * This is WP1 (types + view shell + App integration): the gateway
 * multi-select dropdown (WP2) and the packet detail modal (WP3) are stubbed
 * here and land in follow-up work packages.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Filter, Trash2, Pause, Play, RefreshCw } from 'lucide-react';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useAuth } from '../../contexts/AuthContext';
import { useNodes } from '../../hooks/useServerData';
import type { MqttGroupedPacket, MqttGateway } from './mqttPacketTypes';
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

const ENCRYPTED_OUTCOME_BADGES = new Set(['encrypted', 'ignored', 'geo-ignored', 'unsupported-portnum', 'decode-error']);

function outcomeBadgeClass(outcome: string): string {
  switch (outcome) {
    case 'encrypted':
      return 'mqpm-badge mqpm-badge-encrypted';
    case 'ignored':
      return 'mqpm-badge mqpm-badge-ignored';
    case 'geo-ignored':
      return 'mqpm-badge mqpm-badge-geo-ignored';
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
  const [, setGateways] = useState<MqttGateway[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

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
      setGateways(Array.isArray(payload.gateways) ? payload.gateways : []);
    } catch {
      // Non-fatal: the gateway filter (WP2) simply stays empty.
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
          <button className="mqpm-btn" onClick={() => void load()} title={t('common.refresh', 'Refresh')}>
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
          {/* TODO(WP2): gateway multi-select dropdown mounts here (mqpm-gateway-dropdown). */}
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
          {/* TODO(WP2): mqpm-gateway-dropdown multi-select mounts here; for now
              expose a minimal clear affordance so selectedGateways (persisted,
              wired into `load()`) can be reset without editing localStorage. */}
          {selectedGateways.length > 0 && (
            <div className="mqpm-filter-note">
              {t('mqtt.packets.gatewayCountFiltered', 'Gateway counts reflect the selected gateways only.')}
              {' '}
              <button className="mqpm-btn" onClick={() => setSelectedGateways([])}>
                {t('mqtt.packets.clearSelection', 'Clear')}
              </button>
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
                <th>{t('mqtt.packets.gateways', 'Gateways')}</th>
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

      {/* WP3: MqttPacketDetailModal mounts here (createPortal on selectedPacket). */}
      {selectedPacket && null}
    </div>
  );
};

export default MqttPacketMonitorView;
