/**
 * MeshCoreRemoteStatsPanel
 *
 * Renders the typed status snapshot returned by MeshCore's SendStatusReq
 * (wrapped by GET /admin/status/:publicKey → `getRemoteStatus`). Mounted
 * inside MeshCoreRemoteConsole once the user has an active admin session.
 *
 * Auto-refresh: a low-frequency poll (30s by default) so the panel stays
 * fresh without hammering the radio. Manual refresh button bypasses the
 * timer. Failures render a soft "unavailable" state — typical when the
 * remote firmware is a Companion (which doesn't populate the full counter
 * set) or the path has gone stale since login.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreActions, MeshCoreRemoteStatus } from './hooks/useMeshCore';
import './MeshCoreRemoteStatsPanel.css';

interface Props {
  publicKey: string;
  /** Pulled from the same useMeshCore actions bundle the console uses. */
  fetchStatus: MeshCoreActions['getRemoteStatus'];
  /** Auto-refresh interval in ms. 0 disables auto-refresh. Default 30s. */
  refreshIntervalMs?: number;
}

export const MeshCoreRemoteStatsPanel: React.FC<Props> = ({
  publicKey,
  fetchStatus,
  refreshIntervalMs = 30_000,
}) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MeshCoreRemoteStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Track an in-flight fetch so a slow Refresh + an interval tick can't
  // race. The interval skips its tick if a fetch is already in flight.
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchStatus(publicKey);
      if (result) {
        setStatus(result);
        setLastUpdated(Date.now());
      } else {
        setError(t('meshcore.remoteStats.unavailable', 'Status unavailable'));
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [fetchStatus, publicKey, t]);

  // Initial fetch + interval. Reset whenever the targeted contact changes
  // so a stale interval tick can't hit the previously-selected node.
  useEffect(() => {
    void load();
    if (refreshIntervalMs <= 0) return;
    const id = setInterval(() => { void load(); }, refreshIntervalMs);
    return () => clearInterval(id);
  }, [load, refreshIntervalMs]);

  return (
    <section className="meshcore-remote-stats" aria-label={t('meshcore.remoteStats.title', 'Remote node status')}>
      <header
        className="mrs-header"
        onClick={() => setCollapsed((v) => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed((v) => !v); } }}
      >
        <span className="mrs-chevron" aria-hidden="true">{collapsed ? '▶' : '▼'}</span>
        <h4 className="mrs-title">{t('meshcore.remoteStats.title', 'Remote node status')}</h4>
        {lastUpdated !== null && !collapsed && (
          <span className="mrs-updated">
            {t('meshcore.remoteStats.updated', 'Updated {{ago}}s ago', {
              ago: Math.floor((Date.now() - lastUpdated) / 1000),
            })}
          </span>
        )}
        <button
          type="button"
          className="mrs-refresh-btn"
          onClick={(e) => { e.stopPropagation(); void load(); }}
          disabled={loading}
        >
          {loading ? t('meshcore.remoteStats.refreshing', 'Refreshing…') : t('meshcore.remoteStats.refresh', 'Refresh')}
        </button>
      </header>

      {!collapsed && (
        <div className="mrs-body">
          {error && !status && (
            <p className="mrs-error">{error}</p>
          )}
          {status && (
            <div className="mrs-grid">
              <StatField label={t('meshcore.remoteStats.uptime', 'Uptime')} value={formatUptime(status.uptimeSecs)} />
              <StatField label={t('meshcore.remoteStats.battery', 'Battery')} value={formatBattery(status.batteryMv)} />
              <StatField label={t('meshcore.remoteStats.queue', 'TX queue')} value={formatNumber(status.queueLen)} />
              <StatField label={t('meshcore.remoteStats.last_rssi', 'Last RSSI')} value={formatRssi(status.lastRssi)} />
              <StatField label={t('meshcore.remoteStats.last_snr', 'Last SNR')} value={formatSnr(status.lastSnr)} />
              <StatField label={t('meshcore.remoteStats.noise_floor', 'Noise floor')} value={formatRssi(status.noiseFloor)} />
              <StatField label={t('meshcore.remoteStats.air_time', 'Air time')} value={formatAirTime(status.airTimeSecs)} />
              <StatField label={t('meshcore.remoteStats.errors', 'Errors')} value={formatNumber(status.errors)} />

              <div className="mrs-section">
                <h5>{t('meshcore.remoteStats.rx', 'Received')}</h5>
                <div className="mrs-subgrid">
                  <StatField compact label={t('meshcore.remoteStats.total', 'Total')} value={formatNumber(status.packetsRecv)} />
                  <StatField compact label={t('meshcore.remoteStats.flood', 'Flood')} value={formatNumber(status.recvFlood)} />
                  <StatField compact label={t('meshcore.remoteStats.direct', 'Direct')} value={formatNumber(status.recvDirect)} />
                  <StatField compact label={t('meshcore.remoteStats.flood_dups', 'Flood dups')} value={formatNumber(status.floodDups)} />
                  <StatField compact label={t('meshcore.remoteStats.direct_dups', 'Direct dups')} value={formatNumber(status.directDups)} />
                </div>
              </div>

              <div className="mrs-section">
                <h5>{t('meshcore.remoteStats.tx', 'Sent')}</h5>
                <div className="mrs-subgrid">
                  <StatField compact label={t('meshcore.remoteStats.total', 'Total')} value={formatNumber(status.packetsSent)} />
                  <StatField compact label={t('meshcore.remoteStats.flood', 'Flood')} value={formatNumber(status.sentFlood)} />
                  <StatField compact label={t('meshcore.remoteStats.direct', 'Direct')} value={formatNumber(status.sentDirect)} />
                </div>
              </div>
            </div>
          )}
          {loading && !status && (
            <p className="mrs-loading">{t('meshcore.remoteStats.loading', 'Loading status…')}</p>
          )}
        </div>
      )}
    </section>
  );
};

interface StatFieldProps {
  label: string;
  value: string;
  compact?: boolean;
}

const StatField: React.FC<StatFieldProps> = ({ label, value, compact }) => (
  <div className={`mrs-field${compact ? ' mrs-field-compact' : ''}`}>
    <span className="mrs-field-label">{label}</span>
    <span className="mrs-field-value">{value}</span>
  </div>
);

// ----- formatters -----

function formatNumber(v: number | undefined): string {
  if (v === undefined || v === null) return '—';
  return v.toLocaleString();
}

function formatUptime(secs: number | undefined): string {
  if (secs === undefined || secs === null) return '—';
  if (secs < 60) return `${secs}s`;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBattery(mv: number | undefined): string {
  if (mv === undefined || mv === null) return '—';
  return `${(mv / 1000).toFixed(2)} V`;
}

function formatRssi(rssi: number | undefined): string {
  if (rssi === undefined || rssi === null) return '—';
  return `${rssi} dBm`;
}

function formatSnr(snr: number | undefined): string {
  if (snr === undefined || snr === null) return '—';
  // The wire value is a signed int16 representing dB×10 in some firmware
  // versions and raw dB in others — meshcore.js currently emits raw dB,
  // so render as-is with one decimal.
  return `${snr.toFixed(1)} dB`;
}

function formatAirTime(secs: number | undefined): string {
  if (secs === undefined || secs === null) return '—';
  if (secs < 60) return `${secs}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
