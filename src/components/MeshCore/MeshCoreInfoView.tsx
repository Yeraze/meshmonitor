/**
 * MeshCoreInfoView — per-source MeshCore "Node Info" page.
 *
 * Mirrors the Meshtastic node-info experience: identity card + current
 * health stats + time-series graphs of everything the local-node poller
 * collects. Data source:
 *
 *   - `GET /api/sources/:id/meshcore/info` → identity + most recent
 *     poll snapshot (latest battery, queue, drift, packet counters, etc).
 *   - `GET /api/telemetry/<pubkey>?sourceId=<id>&hours=<n>` → time-series
 *     for graphing (already source-aware in the server).
 *
 * Graphs are intentionally hand-rolled rather than passed through
 * `TelemetryGraphs` because that component is tightly coupled to
 * Meshtastic-flavoured features (solar overlays, favorites mutation,
 * purge-by-type permission gates). For MeshCore we want a simple
 * read-only grid keyed on telemetryType strings prefixed `mc_`.
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ConnectionStatus } from './hooks/useMeshCore';
import { useTelemetry } from '../../hooks/useTelemetry';

const HOURS_OPTIONS = [1, 6, 24, 72, 168] as const;
type HoursOption = typeof HOURS_OPTIONS[number];

/** Display order + label/unit/color for each `mc_*` telemetry type. */
const MC_TELEMETRY_DISPLAY: Array<{ type: string; label: string; unit?: string; color: string; integer?: boolean }> = [
  { type: 'mc_battery_volts', label: 'Battery', unit: 'V', color: '#a6e3a1' },
  { type: 'mc_queue_len', label: 'Queue Length', color: '#f9e2af', integer: true },
  { type: 'mc_noise_floor', label: 'Noise Floor', unit: 'dBm', color: '#fab387' },
  { type: 'mc_last_rssi', label: 'Last RSSI', unit: 'dBm', color: '#f5c2e7' },
  { type: 'mc_last_snr', label: 'Last SNR', unit: 'dB', color: '#94e2d5' },
  { type: 'mc_tx_duty_pct', label: 'TX Duty Cycle', unit: '%', color: '#f38ba8' },
  { type: 'mc_rx_duty_pct', label: 'RX Duty Cycle', unit: '%', color: '#89dceb' },
  { type: 'mc_pkt_sent_rate', label: 'Packets Sent', unit: '/min', color: '#cba6f7' },
  { type: 'mc_pkt_recv_rate', label: 'Packets Received', unit: '/min', color: '#74c7ec' },
  { type: 'mc_rtc_drift_secs', label: 'RTC Drift', unit: 's', color: '#f2cdcd' },
  { type: 'mc_uptime_secs', label: 'Uptime', unit: 's', color: '#b4befe' },
];

/** Cumulative-counter telemetry types — shown as a small table, not graphed. */
const MC_COUNTERS: Array<{ type: string; label: string }> = [
  { type: 'mc_pkt_recv', label: 'Packets recv (total)' },
  { type: 'mc_pkt_sent', label: 'Packets sent (total)' },
  { type: 'mc_pkt_flood_tx', label: 'Flood TX' },
  { type: 'mc_pkt_direct_tx', label: 'Direct TX' },
  { type: 'mc_pkt_flood_rx', label: 'Flood RX' },
  { type: 'mc_pkt_direct_rx', label: 'Direct RX' },
  { type: 'mc_pkt_recv_errors', label: 'Receive errors' },
  { type: 'mc_tx_air_secs', label: 'TX air-time total (s)' },
  { type: 'mc_rx_air_secs', label: 'RX air-time total (s)' },
];

interface MeshCoreInfoApiResponse {
  success: boolean;
  data: {
    sourceId: string;
    connected: boolean;
    deviceType: number;
    deviceTypeName: string;
    identity: {
      publicKey: string;
      name: string;
      advType: number;
      txPower?: number;
      maxTxPower?: number;
      radioFreq?: number;
      radioBw?: number;
      radioSf?: number;
      radioCr?: number;
      latitude?: number;
      longitude?: number;
      advLocPolicy?: number;
      firmwareVer?: number;
      firmwareBuild?: string;
      model?: string;
      ver?: string;
      telemetryModeBase?: string;
      telemetryModeLoc?: string;
      telemetryModeEnv?: string;
    } | null;
    latest: {
      timestamp: number;
      batteryMv?: number;
      uptimeSecs?: number;
      errors?: number;
      queueLen?: number;
      noiseFloor?: number;
      lastRssi?: number;
      lastSnr?: number;
      txDutyPct?: number;
      rxDutyPct?: number;
      packetsRecv?: number;
      packetsSent?: number;
      floodTx?: number;
      directTx?: number;
      floodRx?: number;
      directRx?: number;
      recvErrors?: number | null;
      packetsRecvRatePerMin?: number;
      packetsSentRatePerMin?: number;
      rtcDriftSecs?: number;
      deviceInfo?: {
        firmwareVer?: number;
        firmwareBuild?: string;
        model?: string;
      };
    } | null;
    telemetryRef: { nodeId: string; nodeNum: number; sourceId: string } | null;
  };
}

interface MeshCoreInfoViewProps {
  baseUrl: string;
  sourceId: string;
  status: ConnectionStatus | null;
}

function fmtUptime(secs?: number): string {
  if (secs === undefined || secs === null || !Number.isFinite(secs)) return '—';
  const s = Math.floor(secs);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

function fmtVolts(mv?: number): string {
  if (mv === undefined || mv === null || !Number.isFinite(mv)) return '—';
  return `${(mv / 1000).toFixed(2)} V`;
}

function fmtNumber(v?: number | null, suffix = ''): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 100) / 100}${suffix}`;
}

function fmtDrift(s?: number): string {
  if (s === undefined || s === null || !Number.isFinite(s)) return '—';
  const sign = s > 0 ? '+' : '';
  return `${sign}${s} s`;
}

function fmtPubkeyShort(pk?: string): string {
  if (!pk) return '—';
  return `${pk.substring(0, 12)}…${pk.substring(pk.length - 4)}`;
}

function fmtFreq(mhz?: number): string {
  if (mhz === undefined || mhz === null || !Number.isFinite(mhz)) return '—';
  return `${mhz.toFixed(3)} MHz`;
}

export const MeshCoreInfoView: React.FC<MeshCoreInfoViewProps> = ({ baseUrl, sourceId, status }) => {
  const { t } = useTranslation();
  const [hours, setHours] = useState<HoursOption>(24);

  // Fetch identity + latest snapshot from the server. Refetch every 30s so the
  // dashboard reflects each new poll cycle without being chatty.
  const { data: infoResp, isLoading: infoLoading, error: infoError } = useQuery({
    queryKey: ['meshcore-info', sourceId],
    queryFn: async (): Promise<MeshCoreInfoApiResponse> => {
      const resp = await fetch(`${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/info`);
      if (!resp.ok) throw new Error(`Failed to fetch info: ${resp.status}`);
      return resp.json();
    },
    refetchInterval: 30_000,
    staleTime: 25_000,
    refetchOnWindowFocus: false,
  });

  const info = infoResp?.data;
  const identity = info?.identity ?? status?.localNode ?? null;
  const latest = info?.latest ?? null;
  const telemetryRef = info?.telemetryRef ?? null;

  // Time-series for the graphs.
  const { data: telemetryRows = [], isLoading: telLoading } = useTelemetry({
    nodeId: telemetryRef?.nodeId ?? '',
    sourceId: telemetryRef?.sourceId,
    hours,
    baseUrl,
    enabled: !!telemetryRef?.nodeId,
  });

  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ timestamp: number; value: number }>>();
    for (const row of telemetryRows) {
      if (!row.telemetryType.startsWith('mc_')) continue;
      let arr = map.get(row.telemetryType);
      if (!arr) {
        arr = [];
        map.set(row.telemetryType, arr);
      }
      arr.push({ timestamp: row.timestamp, value: row.value });
    }
    for (const arr of map.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
    return map;
  }, [telemetryRows]);

  const counterValues = useMemo(() => {
    const out = new Map<string, number>();
    for (const { type } of MC_COUNTERS) {
      const arr = grouped.get(type);
      if (arr && arr.length > 0) {
        out.set(type, arr[arr.length - 1].value);
      }
    }
    return out;
  }, [grouped]);

  if (infoLoading && !info) {
    return <div className="meshcore-info-loading">{t('meshcore.info.loading', 'Loading…')}</div>;
  }

  if (infoError) {
    return (
      <div className="meshcore-info-error">
        {t('meshcore.info.load_failed', 'Failed to load node info')}: {String(infoError)}
      </div>
    );
  }

  if (!identity) {
    return (
      <div className="meshcore-info-empty">
        {t('meshcore.info.not_connected', 'No local node info — source disconnected.')}
      </div>
    );
  }

  const isCompanion = (info?.deviceType ?? identity.advType) === 1;

  return (
    <div className="meshcore-info-view" data-testid="meshcore-info-view">
      <div className="meshcore-info-grid">
        <section className="meshcore-info-card" data-testid="meshcore-info-identity">
          <h3>{t('meshcore.info.identity', 'Identity')}</h3>
          <dl>
            <dt>{t('meshcore.info.name', 'Name')}</dt>
            <dd>{identity.name || '—'}</dd>
            <dt>{t('meshcore.info.pubkey', 'Public key')}</dt>
            <dd title={identity.publicKey}>{fmtPubkeyShort(identity.publicKey)}</dd>
            <dt>{t('meshcore.info.device_type', 'Device type')}</dt>
            <dd>{info?.deviceTypeName ?? (identity.advType === 1 ? 'Companion' : 'Other')}</dd>
            <dt>{t('meshcore.info.model', 'Model')}</dt>
            <dd>{identity.model || '—'}</dd>
            <dt>{t('meshcore.info.firmware', 'Firmware')}</dt>
            <dd>
              {identity.ver || identity.firmwareVer !== undefined
                ? `${identity.ver ?? `v${identity.firmwareVer}`}${identity.firmwareBuild ? ` (${identity.firmwareBuild})` : ''}`
                : '—'}
            </dd>
            <dt>{t('meshcore.info.position', 'Advertised position')}</dt>
            <dd>
              {typeof identity.latitude === 'number' && typeof identity.longitude === 'number'
                ? `${identity.latitude.toFixed(5)}, ${identity.longitude.toFixed(5)}`
                : '—'}
            </dd>
          </dl>
        </section>

        <section className="meshcore-info-card" data-testid="meshcore-info-radio">
          <h3>{t('meshcore.info.radio', 'Radio')}</h3>
          <dl>
            <dt>{t('meshcore.info.frequency', 'Frequency')}</dt>
            <dd>{fmtFreq(identity.radioFreq)}</dd>
            <dt>{t('meshcore.info.bandwidth', 'Bandwidth')}</dt>
            <dd>{identity.radioBw !== undefined ? `${identity.radioBw} kHz` : '—'}</dd>
            <dt>{t('meshcore.info.sf', 'Spreading factor')}</dt>
            <dd>{identity.radioSf ?? '—'}</dd>
            <dt>{t('meshcore.info.cr', 'Coding rate')}</dt>
            <dd>{identity.radioCr ? `4/${identity.radioCr}` : '—'}</dd>
            <dt>{t('meshcore.info.tx_power', 'TX power')}</dt>
            <dd>
              {identity.txPower !== undefined
                ? `${identity.txPower}${identity.maxTxPower !== undefined ? ` / ${identity.maxTxPower}` : ''} dBm`
                : '—'}
            </dd>
          </dl>
        </section>

        <section className="meshcore-info-card" data-testid="meshcore-info-health">
          <h3>{t('meshcore.info.health', 'Current health')}</h3>
          {!isCompanion ? (
            <p className="meshcore-info-note">
              {t('meshcore.info.repeater_no_stats', 'Local stats are only available for Companion devices.')}
            </p>
          ) : latest ? (
            <dl>
              <dt>{t('meshcore.info.battery', 'Battery')}</dt>
              <dd>{fmtVolts(latest.batteryMv)}</dd>
              <dt>{t('meshcore.info.uptime', 'Uptime')}</dt>
              <dd>{fmtUptime(latest.uptimeSecs)}</dd>
              <dt>{t('meshcore.info.queue', 'TX queue')}</dt>
              <dd>{fmtNumber(latest.queueLen)}</dd>
              <dt>{t('meshcore.info.noise_floor', 'Noise floor')}</dt>
              <dd>{fmtNumber(latest.noiseFloor, ' dBm')}</dd>
              <dt>{t('meshcore.info.last_rssi', 'Last RSSI')}</dt>
              <dd>{fmtNumber(latest.lastRssi, ' dBm')}</dd>
              <dt>{t('meshcore.info.last_snr', 'Last SNR')}</dt>
              <dd>{fmtNumber(latest.lastSnr, ' dB')}</dd>
              <dt>{t('meshcore.info.rtc_drift', 'RTC drift vs server')}</dt>
              <dd>{fmtDrift(latest.rtcDriftSecs)}</dd>
              <dt>{t('meshcore.info.last_poll', 'Last poll')}</dt>
              <dd>{new Date(latest.timestamp).toLocaleString()}</dd>
            </dl>
          ) : (
            <p className="meshcore-info-note">
              {t('meshcore.info.awaiting_poll', 'Waiting for first telemetry poll…')}
            </p>
          )}
        </section>

        <section className="meshcore-info-card" data-testid="meshcore-info-counters">
          <h3>{t('meshcore.info.counters', 'Cumulative counters')}</h3>
          {counterValues.size === 0 ? (
            <p className="meshcore-info-note">{t('meshcore.info.no_counters', 'No counter data yet.')}</p>
          ) : (
            <dl>
              {MC_COUNTERS.map(({ type, label }) => (
                counterValues.has(type) ? (
                  <React.Fragment key={type}>
                    <dt>{label}</dt>
                    <dd>{counterValues.get(type)?.toLocaleString()}</dd>
                  </React.Fragment>
                ) : null
              ))}
            </dl>
          )}
        </section>
      </div>

      {isCompanion && (
        <section className="meshcore-info-graphs" data-testid="meshcore-info-graphs">
          <div className="meshcore-info-graphs-header">
            <h3>{t('meshcore.info.history', 'History')}</h3>
            <div className="meshcore-info-range" role="group" aria-label="Time range">
              {HOURS_OPTIONS.map((h) => (
                <button
                  key={h}
                  className={`mc-range-btn ${hours === h ? 'active' : ''}`}
                  onClick={() => setHours(h)}
                >
                  {h < 24 ? `${h}h` : `${h / 24}d`}
                </button>
              ))}
            </div>
          </div>

          {telLoading && telemetryRows.length === 0 ? (
            <div className="meshcore-info-note">{t('meshcore.info.loading_graphs', 'Loading graphs…')}</div>
          ) : (
            <div className="meshcore-info-graphs-grid">
              {MC_TELEMETRY_DISPLAY.map(({ type, label, unit, color, integer }) => {
                const data = grouped.get(type) ?? [];
                if (data.length === 0) return null;
                return (
                  <div key={type} className="meshcore-info-graph">
                    <div className="meshcore-info-graph-title">
                      {label}
                      {unit ? ` (${unit})` : ''}
                    </div>
                    <ResponsiveContainer width="100%" height={180}>
                      <ComposedChart data={data} margin={{ top: 5, right: 12, bottom: 5, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#444" />
                        <XAxis
                          dataKey="timestamp"
                          type="number"
                          domain={['dataMin', 'dataMax']}
                          tick={{ fontSize: 11 }}
                          tickFormatter={(v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        />
                        <YAxis
                          tick={{ fontSize: 11 }}
                          domain={['auto', 'auto']}
                          allowDecimals={!integer}
                          tickFormatter={integer ? (v: number) => Math.round(v).toString() : undefined}
                        />
                        <Tooltip
                          labelFormatter={(v) => new Date(v as number).toLocaleString()}
                          formatter={(v) => [
                            typeof v === 'number'
                              ? `${Math.round(v * 100) / 100}${unit ? ' ' + unit : ''}`
                              : String(v ?? ''),
                            label,
                          ]}
                        />
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke={color}
                          strokeWidth={2}
                          dot={{ fill: color, r: 2 }}
                          activeDot={{ r: 4 }}
                          isAnimationActive={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default MeshCoreInfoView;
