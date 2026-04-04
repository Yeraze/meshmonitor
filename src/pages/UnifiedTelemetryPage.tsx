/**
 * Unified Telemetry Page
 *
 * Shows the latest telemetry readings per node across all accessible sources.
 * Grouped by source, with color-coded source tags. Useful as a fleet overview.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { appBasename } from '../init';

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
  '#2563eb', '#7c3aed', '#059669', '#dc2626', '#d97706', '#0891b2',
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
  uptime_seconds: 's',
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
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
  if (type === 'voltage') return value.toFixed(2);
  if (type === 'barometric_pressure') return value.toFixed(1);
  if (type === 'temperature') return value.toFixed(1);
  if (type === 'relative_humidity') return value.toFixed(0);
  if (type === 'snr' || type === 'rssi') return value.toFixed(1);
  return String(Math.round(value * 10) / 10);
}

function formatAge(timestamp: number): string {
  const ageS = Math.floor(Date.now() / 1000) - timestamp;
  if (ageS < 60) return `${ageS}s ago`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
  if (ageS < 86400) return `${Math.floor(ageS / 3600)}h ago`;
  return `${Math.floor(ageS / 86400)}d ago`;
}

type HoursOption = 1 | 6 | 24 | 72 | 168;
const HOURS_OPTIONS: HoursOption[] = [1, 6, 24, 72, 168];
const HOURS_LABELS: Record<HoursOption, string> = {
  1: '1h', 6: '6h', 24: '24h', 72: '3d', 168: '7d',
};

export default function UnifiedTelemetryPage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TelemetryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hours, setHours] = useState<HoursOption>(24);
  const [typeFilter, setTypeFilter] = useState<string>('');

  const fetchTelemetry = useCallback(async () => {
    try {
      const res = await fetch(`${appBasename}/api/unified/telemetry?hours=${hours}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        setError('Failed to load telemetry');
        return;
      }
      const data: TelemetryEntry[] = await res.json();
      setEntries(data);
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
    const interval = setInterval(fetchTelemetry, 15000);
    return () => clearInterval(interval);
  }, [fetchTelemetry]);

  const sourceIds = Array.from(new Set(entries.map(e => e.sourceId)));
  const allTypes = Array.from(new Set(entries.map(e => e.telemetryType))).sort();

  // Group: sourceId → nodeId → telemetryType → entry (latest only)
  const bySource: Record<string, Record<string, Record<string, TelemetryEntry>>> = {};
  for (const e of entries) {
    if (typeFilter && e.telemetryType !== typeFilter) continue;
    if (!bySource[e.sourceId]) bySource[e.sourceId] = {};
    if (!bySource[e.sourceId][e.nodeId]) bySource[e.sourceId][e.nodeId] = {};
    const existing = bySource[e.sourceId][e.nodeId][e.telemetryType];
    if (!existing || e.timestamp > existing.timestamp) {
      bySource[e.sourceId][e.nodeId][e.telemetryType] = e;
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: '#111', color: '#eee', fontFamily: 'sans-serif' }}>
      {/* Header */}
      <div style={{
        background: '#1a1a1a', borderBottom: '1px solid #333',
        padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: '#333', color: '#aaa', border: 'none', borderRadius: 8,
            padding: '8px 16px', fontSize: 13, cursor: 'pointer',
          }}
        >
          ← Sources
        </button>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#fff' }}>Unified Telemetry</h1>
          <p style={{ margin: 0, fontSize: 12, color: '#666' }}>Latest readings · all sources</p>
        </div>

        {/* Time range */}
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {HOURS_OPTIONS.map(h => (
            <button
              key={h}
              onClick={() => setHours(h)}
              style={{
                background: hours === h ? '#2563eb' : '#2a2a2a',
                color: hours === h ? '#fff' : '#888',
                border: 'none', borderRadius: 6,
                padding: '5px 10px', fontSize: 12, cursor: 'pointer',
              }}
            >
              {HOURS_LABELS[h]}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          style={{
            background: '#2a2a2a', color: '#ccc', border: '1px solid #444',
            borderRadius: 6, padding: '5px 10px', fontSize: 12,
          }}
        >
          <option value="">All types</option>
          {allTypes.map(t => (
            <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>

        {/* Source legend */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {sourceIds.map(sid => {
            const name = entries.find(e => e.sourceId === sid)?.sourceName ?? sid;
            const color = getSourceColor(sid, sourceIds);
            return (
              <span key={sid} style={{
                background: color + '22', border: `1px solid ${color}44`,
                color, borderRadius: 99, padding: '3px 10px', fontSize: 12, fontWeight: 600,
              }}>
                {name}
              </span>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: 64, color: '#666' }}>Loading telemetry…</div>
        )}
        {error && (
          <div style={{ textAlign: 'center', padding: 32, color: '#ef4444' }}>{error}</div>
        )}
        {!loading && !error && Object.keys(bySource).length === 0 && (
          <div style={{ textAlign: 'center', padding: 64, color: '#666' }}>
            No telemetry found in the selected time range.
          </div>
        )}

        {Object.entries(bySource).map(([sourceId, nodeMap]) => {
          const color = getSourceColor(sourceId, sourceIds);
          const sourceName = entries.find(e => e.sourceId === sourceId)?.sourceName ?? sourceId;
          const nodeEntries = Object.entries(nodeMap);

          return (
            <div key={sourceId} style={{ marginBottom: 32 }}>
              {/* Source header */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
              }}>
                <div style={{
                  width: 4, height: 20, borderRadius: 2, background: color, flexShrink: 0,
                }} />
                <span style={{ fontSize: 16, fontWeight: 700, color }}>{sourceName}</span>
                <span style={{ fontSize: 12, color: '#555' }}>
                  {nodeEntries.length} node{nodeEntries.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Node cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                {nodeEntries.map(([nodeId, typeMap]) => {
                  const firstEntry = Object.values(typeMap)[0];
                  const nodeName = firstEntry?.nodeLongName || firstEntry?.nodeShortName || nodeId;
                  const readings = Object.values(typeMap).sort((a, b) => a.telemetryType.localeCompare(b.telemetryType));
                  const latestTs = Math.max(...readings.map(r => r.timestamp));

                  return (
                    <div
                      key={nodeId}
                      style={{
                        background: '#1a1a1a',
                        border: `1px solid ${color}33`,
                        borderTop: `2px solid ${color}`,
                        borderRadius: 8, padding: 14,
                      }}
                    >
                      {/* Node name + age */}
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, color: '#ddd', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {nodeName}
                        </span>
                        <span style={{ fontSize: 11, color: '#555', flexShrink: 0 }}>
                          {formatAge(latestTs)}
                        </span>
                      </div>

                      {/* Telemetry readings */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px' }}>
                        {readings.map(r => (
                          <div key={r.telemetryType} style={{ minWidth: 70 }}>
                            <div style={{ fontSize: 10, color: '#666', marginBottom: 1 }}>
                              {TYPE_LABELS[r.telemetryType] ?? r.telemetryType}
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0e0' }}>
                              {formatValue(r.telemetryType, r.value)}
                              <span style={{ fontSize: 10, color: '#888', marginLeft: 2 }}>
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
