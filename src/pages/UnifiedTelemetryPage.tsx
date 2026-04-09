/**
 * Unified Telemetry Page
 *
 * Shows the latest telemetry readings per node across all accessible sources.
 * Grouped by source, with color-coded source tags. Fleet overview.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { appBasename } from '../init';
import '../styles/unified.css';

interface TelemetryEntry {
  nodeId: string;
  nodeNum: number;
  telemetryType: string;
  value: number;
  unit?: string | null;
  timestamp: number;
  sourceId: string;
  sourceName: string;
  nodeLongName?: string | null;
  nodeShortName?: string | null;
}

const SOURCE_COLORS = [
  'var(--ctp-blue)', 'var(--ctp-mauve)', 'var(--ctp-green)',
  'var(--ctp-red)', 'var(--ctp-yellow)', 'var(--ctp-teal)',
];

function getSourceColor(sourceId: string, sourceIds: string[]): string {
  const idx = sourceIds.indexOf(sourceId);
  return SOURCE_COLORS[idx % SOURCE_COLORS.length];
}

const TYPE_LABELS: Record<string, string> = {
  battery_level: 'Battery',
  voltage: 'Voltage',
  channel_utilization: 'Ch Util',
  air_util_tx: 'Air TX',
  snr: 'SNR',
  rssi: 'RSSI',
  uptime_seconds: 'Uptime',
  temperature: 'Temp',
  relative_humidity: 'Humidity',
  barometric_pressure: 'Pressure',
  gas_resistance: 'Gas',
  distance: 'Distance',
  lux: 'Lux',
  iaq: 'IAQ',
  wind_speed: 'Wind',
  weight: 'Weight',
  current: 'Current',
  power: 'Power',
  latitude: 'Lat',
  longitude: 'Lon',
  altitude: 'Alt',
};

const TYPE_UNITS: Record<string, string> = {
  battery_level: '%',
  voltage: 'V',
  channel_utilization: '%',
  air_util_tx: '%',
  snr: 'dB',
  rssi: 'dBm',
  uptime_seconds: '',
  temperature: '°C',
  relative_humidity: '%',
  barometric_pressure: 'hPa',
  wind_speed: 'm/s',
  weight: 'kg',
  current: 'mA',
  power: 'mW',
  lux: 'lx',
};

function formatValue(type: string, value: number): string {
  if (type === 'uptime_seconds') {
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  if (type === 'voltage') return value.toFixed(2);
  if (type === 'barometric_pressure' || type === 'temperature') return value.toFixed(1);
  if (type === 'relative_humidity' || type === 'snr' || type === 'rssi') return value.toFixed(1);
  return String(Math.round(value * 10) / 10);
}

function formatAge(timestamp: number): string {
  const s = Math.floor(Date.now() / 1000) - timestamp;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type HoursOption = 1 | 6 | 24 | 72 | 168;
const HOURS_OPTIONS: HoursOption[] = [1, 6, 24, 72, 168];
const HOURS_LABELS: Record<HoursOption, string> = { 1: '1h', 6: '6h', 24: '24h', 72: '3d', 168: '7d' };

export default function UnifiedTelemetryPage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TelemetryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hours, setHours] = useState<HoursOption>(24);
  const [typeFilter, setTypeFilter] = useState('');

  const fetchTelemetry = useCallback(async () => {
    try {
      const res = await fetch(`${appBasename}/api/unified/telemetry?hours=${hours}`, {
        credentials: 'include',
      });
      if (!res.ok) { setError('Failed to load telemetry'); return; }
      setEntries(await res.json());
      setError('');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    setLoading(true);
    fetchTelemetry();
    const iv = setInterval(fetchTelemetry, 15000);
    return () => clearInterval(iv);
  }, [fetchTelemetry]);

  const sourceIds = Array.from(new Set(entries.map(e => e.sourceId)));
  const allTypes = Array.from(new Set(entries.map(e => e.telemetryType))).sort();

  // Group: sourceId → nodeId → telemetryType → latest entry
  const bySource: Record<string, Record<string, Record<string, TelemetryEntry>>> = {};
  for (const e of entries) {
    if (typeFilter && e.telemetryType !== typeFilter) continue;
    if (!bySource[e.sourceId]) bySource[e.sourceId] = {};
    if (!bySource[e.sourceId][e.nodeId]) bySource[e.sourceId][e.nodeId] = {};
    const cur = bySource[e.sourceId][e.nodeId][e.telemetryType];
    if (!cur || e.timestamp > cur.timestamp) bySource[e.sourceId][e.nodeId][e.telemetryType] = e;
  }

  return (
    <div className="unified-page">
      <div className="unified-header">
        <button className="unified-header__back" onClick={() => navigate('/')}>← Sources</button>

        <div className="unified-header__title">
          <h1>Unified Telemetry</h1>
          <p>Latest readings · all sources</p>
        </div>

        <div className="unified-controls">
          <div className="unified-btn-group">
            {HOURS_OPTIONS.map(h => (
              <button
                key={h}
                className={hours === h ? 'active' : ''}
                onClick={() => setHours(h)}
              >
                {HOURS_LABELS[h]}
              </button>
            ))}
          </div>

          <select
            className="unified-select"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
          >
            <option value="">All types</option>
            {allTypes.map(t => (
              <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
            ))}
          </select>
        </div>

        <div className="unified-source-legend">
          {sourceIds.map(sid => {
            const name = entries.find(e => e.sourceId === sid)?.sourceName ?? sid;
            const color = getSourceColor(sid, sourceIds);
            return (
              <span
                key={sid}
                className="unified-source-pill"
                style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)` }}
              >
                {name}
              </span>
            );
          })}
        </div>
      </div>

      <div className="unified-body unified-body--wide">
        {loading && <div className="unified-empty">Loading telemetry…</div>}
        {error && <div className="unified-error">{error}</div>}

        {!loading && !error && Object.keys(bySource).length === 0 && (
          <div className="unified-empty">No telemetry found in the selected time range.</div>
        )}

        {Object.entries(bySource).map(([sourceId, nodeMap]) => {
          const color = getSourceColor(sourceId, sourceIds);
          const sourceName = entries.find(e => e.sourceId === sourceId)?.sourceName ?? sourceId;
          const nodeEntries = Object.entries(nodeMap);

          return (
            <div key={sourceId} className="unified-telem-source">
              <div className="unified-telem-source__header">
                <div className="unified-telem-source__bar" style={{ background: color }} />
                <span className="unified-telem-source__name" style={{ color }}>{sourceName}</span>
                <span className="unified-telem-source__count">
                  {nodeEntries.length} node{nodeEntries.length !== 1 ? 's' : ''}
                </span>
              </div>

              <div className="unified-telem-grid">
                {nodeEntries.map(([nodeId, typeMap]) => {
                  const first = Object.values(typeMap)[0];
                  const nodeName = first?.nodeLongName || first?.nodeShortName || nodeId;
                  const readings = Object.values(typeMap).sort((a, b) =>
                    a.telemetryType.localeCompare(b.telemetryType)
                  );
                  const latestTs = Math.max(...readings.map(r => r.timestamp));

                  return (
                    <div
                      key={nodeId}
                      className="unified-node-card"
                      style={{ borderTopColor: color }}
                    >
                      <div className="unified-node-card__header">
                        <span className="unified-node-card__name">{nodeName}</span>
                        <span className="unified-node-card__age">{formatAge(latestTs)}</span>
                      </div>
                      <div className="unified-node-card__readings">
                        {readings.map(r => (
                          <div key={r.telemetryType} className="unified-reading">
                            <div className="unified-reading__label">
                              {TYPE_LABELS[r.telemetryType] ?? r.telemetryType}
                            </div>
                            <div className="unified-reading__value">
                              {formatValue(r.telemetryType, r.value)}
                              <span className="unified-reading__unit">
                                {r.unit ?? TYPE_UNITS[r.telemetryType] ?? ''}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
