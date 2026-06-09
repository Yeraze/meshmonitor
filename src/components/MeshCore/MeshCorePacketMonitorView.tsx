/**
 * MeshCorePacketMonitorView — OTA packet monitor for a MeshCore source.
 *
 * The MeshCore analogue of the Meshtastic Packet Monitor. Surfaces full OTA
 * packet metadata captured from the companion `LogRxData` (0x88) push:
 * route type, payload type, relay-hash chain, hop count, SNR/RSSI and the
 * raw hex dump. Capture is opt-in via the `meshcore_packet_log_enabled`
 * setting; this view exposes the toggle and retention controls inline.
 *
 * Data flow: initial page is fetched from
 * `GET /api/sources/:id/meshcore/packets`; new packets arrive live over the
 * shared Socket.io connection as `meshcore:ota-packet` events (the room is
 * already joined by the parent MeshCorePage's useMeshCore hook).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Filter, Trash2, Pause, Play, RefreshCw, Download } from 'lucide-react';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useWebSocketContext } from '../../contexts/WebSocketContext';
import { useAuth } from '../../contexts/AuthContext';
import type { MeshCoreOtaPacketEvent } from '../../hooks/useWebSocket';
import {
  MESHCORE_PAYLOAD_TYPES as PAYLOAD_TYPES,
  MESHCORE_ROUTE_TYPES as ROUTE_TYPES,
} from '../../utils/meshcorePacketDecode';
import MeshCorePacketDetailModal from './MeshCorePacketDetailModal';
import './MeshCorePacketMonitor.css';

interface MeshCorePacketMonitorViewProps {
  baseUrl: string;
  sourceId: string;
}

type Packet = MeshCoreOtaPacketEvent;

const MAX_BUFFER = 2000;
const PAGE_LIMIT = 200;

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

export const MeshCorePacketMonitorView: React.FC<MeshCorePacketMonitorViewProps> = ({ baseUrl, sourceId }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { state: wsState } = useWebSocketContext();
  const socket = wsState.socket;
  const { hasPermission } = useAuth();

  const canWriteSettings = hasPermission('settings', 'write');
  const canClear = hasPermission('packetmonitor', 'write');

  const [packets, setPackets] = useState<Packet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [maxCount, setMaxCount] = useState(1000);
  const [maxAgeHours, setMaxAgeHours] = useState(24);
  const [savingSettings, setSavingSettings] = useState(false);

  const [payloadFilter, setPayloadFilter] = useState<number | ''>('');
  const [routeFilter, setRouteFilter] = useState<number | ''>('');
  const [selectedPacket, setSelectedPacket] = useState<Packet | null>(null);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const mcPrefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (payloadFilter !== '') params.set('payload_type', String(payloadFilter));
      if (routeFilter !== '') params.set('route_type', String(routeFilter));
      const res = await csrfFetch(`${mcPrefix}/packets?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPackets(Array.isArray(data.packets) ? data.packets : []);
      if (typeof data.enabled === 'boolean') setEnabled(data.enabled);
      if (typeof data.maxCount === 'number') setMaxCount(data.maxCount);
      if (typeof data.maxAgeHours === 'number') setMaxAgeHours(data.maxAgeHours);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load packets');
    } finally {
      setLoading(false);
    }
  }, [csrfFetch, mcPrefix, payloadFilter, routeFilter]);

  // Initial load + reload on filter change.
  useEffect(() => {
    void load();
  }, [load]);

  // Live updates: prepend incoming OTA packets matching the active filters.
  useEffect(() => {
    if (!socket) return;
    const onOtaPacket = (evt: MeshCoreOtaPacketEvent) => {
      if (evt.sourceId && evt.sourceId !== sourceId) return;
      if (pausedRef.current) return;
      setPackets(prev => {
        const next = [evt, ...prev];
        return next.length > MAX_BUFFER ? next.slice(0, MAX_BUFFER) : next;
      });
    };
    socket.on('meshcore:ota-packet', onOtaPacket);
    return () => {
      socket.off('meshcore:ota-packet', onOtaPacket);
    };
  }, [socket, sourceId]);

  const visiblePackets = useMemo(() => {
    return packets.filter(p => {
      if (payloadFilter !== '' && p.payloadType !== payloadFilter) return false;
      if (routeFilter !== '' && p.routeType !== routeFilter) return false;
      return true;
    });
  }, [packets, payloadFilter, routeFilter]);

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
    await saveSettings({ meshcore_packet_log_enabled: next ? '1' : '0' });
  }, [enabled, saveSettings]);

  const handleClear = useCallback(async () => {
    if (!window.confirm(t('meshcore.packets.clearConfirm', 'Clear the captured MeshCore packet log for this source?'))) {
      return;
    }
    try {
      const res = await csrfFetch(`${mcPrefix}/packets`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPackets([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear packets');
    }
  }, [csrfFetch, mcPrefix, t]);

  // Download the captured packet log as JSONL (honors the active filters),
  // mirroring the Meshtastic packet-monitor export.
  const handleExport = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (payloadFilter !== '') params.set('payload_type', String(payloadFilter));
      if (routeFilter !== '') params.set('route_type', String(routeFilter));
      const res = await csrfFetch(`${mcPrefix}/packets/export?${params.toString()}`);
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
  }, [csrfFetch, mcPrefix, payloadFilter, routeFilter]);

  return (
    <div className="meshcore-packet-monitor">
      <div className="mcpm-header">
        <h3>{t('meshcore.packets.title', 'Packet Monitor')}</h3>
        <span className="mcpm-count">{visiblePackets.length}</span>
        <div className="mcpm-header-controls">
          <button
            className="mcpm-btn"
            onClick={() => setPaused(p => !p)}
            title={paused ? t('common.resume', 'Resume') : t('common.pause', 'Pause')}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            className={`mcpm-btn ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters(s => !s)}
            title={t('common.filters', 'Filters')}
          >
            <Filter size={14} />
          </button>
          <button className="mcpm-btn" onClick={() => void load()} title={t('common.refresh', 'Refresh')}>
            <RefreshCw size={14} />
          </button>
          <button className="mcpm-btn" onClick={() => void handleExport()} title={t('common.export', 'Export')}>
            <Download size={14} />
          </button>
          {canClear && (
            <button className="mcpm-btn mcpm-btn-danger" onClick={() => void handleClear()} title={t('common.clear', 'Clear')}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {!enabled && (
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
        <div className="mcpm-filters">
          <label>
            {t('meshcore.packets.payloadType', 'Payload')}
            <select value={payloadFilter} onChange={e => setPayloadFilter(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">{t('common.all', 'All')}</option>
              {PAYLOAD_TYPES.map(pt => (
                <option key={pt.value} value={pt.value}>{pt.label}</option>
              ))}
            </select>
          </label>
          <label>
            {t('meshcore.packets.routeType', 'Route')}
            <select value={routeFilter} onChange={e => setRouteFilter(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">{t('common.all', 'All')}</option>
              {ROUTE_TYPES.map(rt => (
                <option key={rt.value} value={rt.value}>{rt.label}</option>
              ))}
            </select>
          </label>
          {canWriteSettings && (
            <>
              <label className="mcpm-toggle">
                <input type="checkbox" checked={enabled} disabled={savingSettings} onChange={() => void handleToggleEnabled()} />
                {t('meshcore.packets.captureEnabled', 'Capture enabled')}
              </label>
              <label>
                {t('meshcore.packets.maxCount', 'Max count')}
                <input
                  type="number"
                  min={100}
                  max={50000}
                  step={100}
                  value={maxCount}
                  onChange={e => setMaxCount(Number(e.target.value))}
                  onBlur={() => void saveSettings({ meshcore_packet_log_max_count: String(maxCount) })}
                />
              </label>
              <label>
                {t('meshcore.packets.maxAgeHours', 'Max age (h)')}
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={maxAgeHours}
                  onChange={e => setMaxAgeHours(Number(e.target.value))}
                  onBlur={() => void saveSettings({ meshcore_packet_log_max_age_hours: String(maxAgeHours) })}
                />
              </label>
            </>
          )}
        </div>
      )}

      {error && <div className="mcpm-error">{error}</div>}

      <div className="mcpm-table-container">
        {loading ? (
          <div className="mcpm-empty">{t('common.loading', 'Loading…')}</div>
        ) : visiblePackets.length === 0 ? (
          <div className="mcpm-empty">
            {enabled
              ? t('meshcore.packets.empty', 'No packets captured yet. Waiting for OTA traffic…')
              : t('meshcore.packets.emptyDisabled', 'No packets captured. Enable capture to start recording.')}
          </div>
        ) : (
          <table className="mcpm-table">
            <thead>
              <tr>
                <th>{t('meshcore.packets.time', 'Time')}</th>
                <th>{t('meshcore.packets.payloadType', 'Payload')}</th>
                <th>{t('meshcore.packets.routeType', 'Route')}</th>
                <th>{t('meshcore.packets.hops', 'Hops')}</th>
                <th>{t('meshcore.packets.snr', 'SNR')}</th>
                <th>{t('meshcore.packets.rssi', 'RSSI')}</th>
                <th>{t('meshcore.packets.size', 'Size')}</th>
                <th>{t('meshcore.packets.path', 'Path')}</th>
              </tr>
            </thead>
            <tbody>
              {visiblePackets.map((p, idx) => {
                const key = p.id ?? `${p.timestamp}-${idx}`;
                return (
                  <tr
                    key={key}
                    className="mcpm-row"
                    onClick={() => setSelectedPacket(p)}
                    title={t('meshcore.packets.clickToDecode', 'Click to decode this packet')}
                  >
                    <td className="mcpm-mono">{formatTime(p.timestamp)}</td>
                    <td><span className="mcpm-badge">{payloadLabel(p)}</span></td>
                    <td className="mcpm-route">{routeLabel(p)}</td>
                    <td className="mcpm-mono">{typeof p.hopCount === 'number' ? p.hopCount : '—'}</td>
                    <td className="mcpm-mono">{typeof p.snr === 'number' ? p.snr.toFixed(2) : '—'}</td>
                    <td className="mcpm-mono">{typeof p.rssi === 'number' ? p.rssi : '—'}</td>
                    <td className="mcpm-mono">{typeof p.payloadSize === 'number' ? p.payloadSize : '—'}</td>
                    <td className="mcpm-mono mcpm-path">{p.pathHops || (p.pathLenRaw === 255 ? 'direct' : '—')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedPacket &&
        createPortal(
          <MeshCorePacketDetailModal packet={selectedPacket} onClose={() => setSelectedPacket(null)} />,
          document.body
        )}
    </div>
  );
};

export default MeshCorePacketMonitorView;
