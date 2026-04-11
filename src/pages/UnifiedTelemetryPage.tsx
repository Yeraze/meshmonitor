/**
 * Unified Telemetry Page
 *
 * Shows the latest telemetry readings per node across all accessible sources.
 * Grouped by source, with color-coded source tags. Fleet overview.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
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

// Compact labels for the card view. Keys must match the telemetryType values
// written by meshtasticManager — mostly camelCase, with a few legacy snake_case
// types (gps-related, snr_local/remote, estimated_*). Falls back to the raw
// type string when a label is missing.
const TYPE_LABELS: Record<string, string> = {
  // Power / device
  batteryLevel: 'Battery',
  voltage: 'Voltage',
  current: 'Current',
  channelUtilization: 'Ch Util',
  airUtilTx: 'Air TX',
  uptimeSeconds: 'Uptime',
  // Radio
  snr: 'SNR',
  snr_local: 'SNR (local)',
  snr_remote: 'SNR (remote)',
  rssi: 'RSSI',
  linkQuality: 'Link Q',
  messageHops: 'Hops',
  // LocalStats
  numOnlineNodes: 'Nodes Online',
  numTotalNodes: 'Nodes Total',
  numPacketsTx: 'Packets TX',
  numPacketsRx: 'Packets RX',
  numPacketsRxBad: 'Bad RX',
  numRxDupe: 'Dup RX',
  numTxRelay: 'TX Relay',
  numTxRelayCanceled: 'TX Relay X',
  numTxDropped: 'TX Drop',
  heapTotalBytes: 'Heap Total',
  heapFreeBytes: 'Heap Free',
  // Environment
  temperature: 'Temp',
  humidity: 'Humidity',
  pressure: 'Pressure',
  gasResistance: 'Gas',
  iaq: 'IAQ',
  lux: 'Lux',
  whiteLux: 'White Lux',
  irLux: 'IR Lux',
  uvLux: 'UV Lux',
  windDirection: 'Wind Dir',
  windSpeed: 'Wind',
  windGust: 'Wind Gust',
  windLull: 'Wind Lull',
  rainfall1h: 'Rain 1h',
  rainfall24h: 'Rain 24h',
  soilMoisture: 'Soil Moist',
  soilTemperature: 'Soil Temp',
  radiation: 'Radiation',
  distance: 'Distance',
  weight: 'Weight',
  envVoltage: 'Env V',
  envCurrent: 'Env I',
  // Air quality
  pm10Standard: 'PM1.0',
  pm25Standard: 'PM2.5',
  pm100Standard: 'PM10',
  pm10Environmental: 'PM1.0 Env',
  pm25Environmental: 'PM2.5 Env',
  pm100Environmental: 'PM10 Env',
  particles03um: 'Part 0.3µm',
  particles05um: 'Part 0.5µm',
  particles10um: 'Part 1.0µm',
  particles25um: 'Part 2.5µm',
  particles50um: 'Part 5.0µm',
  particles100um: 'Part 10µm',
  co2: 'CO₂',
  co2Temperature: 'CO₂ Temp',
  co2Humidity: 'CO₂ RH',
  // GPS / location
  latitude: 'Lat',
  longitude: 'Lon',
  altitude: 'Alt',
  sats_in_view: 'Sats',
  ground_speed: 'Speed',
  ground_track: 'Heading',
  estimated_latitude: 'Est Lat',
  estimated_longitude: 'Est Lon',
  // Paxcounter
  paxcounterWifi: 'Pax WiFi',
  paxcounterBle: 'Pax BLE',
  paxcounterUptime: 'Pax Uptime',
  // Host metrics
  hostUptimeSeconds: 'Host Uptime',
  hostFreememBytes: 'Host Free Mem',
  hostLoad1: 'Load 1m',
  hostLoad5: 'Load 5m',
  hostLoad15: 'Load 15m',
  // MeshMonitor system
  systemNodeCount: 'Active Nodes',
  systemDirectNodeCount: 'Direct Nodes',
  timeOffset: 'Clock Δ',
};

const TYPE_UNITS: Record<string, string> = {
  batteryLevel: '%',
  voltage: 'V',
  current: 'mA',
  channelUtilization: '%',
  airUtilTx: '%',
  snr: 'dB',
  snr_local: 'dB',
  snr_remote: 'dB',
  rssi: 'dBm',
  linkQuality: '%',
  temperature: '°C',
  humidity: '%',
  pressure: 'hPa',
  gasResistance: 'MΩ',
  lux: 'lx',
  whiteLux: 'lx',
  irLux: 'lx',
  uvLux: 'lx',
  windDirection: '°',
  windSpeed: 'm/s',
  windGust: 'm/s',
  windLull: 'm/s',
  rainfall1h: 'mm',
  rainfall24h: 'mm',
  soilMoisture: '%',
  soilTemperature: '°C',
  distance: 'mm',
  weight: 'kg',
  envVoltage: 'V',
  envCurrent: 'mA',
  pm10Standard: 'µg/m³',
  pm25Standard: 'µg/m³',
  pm100Standard: 'µg/m³',
  pm10Environmental: 'µg/m³',
  pm25Environmental: 'µg/m³',
  pm100Environmental: 'µg/m³',
  co2: 'ppm',
  co2Temperature: '°C',
  co2Humidity: '%',
  latitude: '°',
  longitude: '°',
  altitude: 'm',
  ground_speed: 'm/s',
  ground_track: '°',
  estimated_latitude: '°',
  estimated_longitude: '°',
  timeOffset: 'ms',
  hostLoad1: '',
  hostLoad5: '',
  hostLoad15: '',
};

/** Fallback unit inference — ch*Voltage / ch*Current pattern. */
function inferUnit(type: string): string {
  if (TYPE_UNITS[type] !== undefined) return TYPE_UNITS[type];
  if (/Voltage$/.test(type)) return 'V';
  if (/Current$/.test(type)) return 'mA';
  if (/Bytes$/.test(type)) return 'B';
  if (/Seconds$/.test(type)) return '';
  return '';
}

/** Human-readable byte size. */
function formatBytes(v: number): string {
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)}M`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)}K`;
  return String(Math.round(v));
}

/** Human-readable duration from seconds. */
function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatValue(type: string, value: number): string {
  // Durations (seconds) → human-readable
  if (type === 'uptimeSeconds' || type === 'hostUptimeSeconds' || type === 'paxcounterUptime') {
    return formatDuration(value);
  }
  // Bytes → KB / MB
  if (/Bytes$/.test(type)) return formatBytes(value);
  // Precision presets
  if (type === 'voltage' || /Voltage$/.test(type)) return value.toFixed(2);
  if (type === 'pressure' || type === 'temperature' || type === 'soilTemperature' ||
      type === 'co2Temperature' || type === 'humidity' || type === 'co2Humidity' ||
      type === 'snr' || type === 'snr_local' || type === 'snr_remote' || type === 'rssi' ||
      type === 'hostLoad1' || type === 'hostLoad5' || type === 'hostLoad15') {
    return value.toFixed(1);
  }
  if (type === 'latitude' || type === 'longitude' ||
      type === 'estimated_latitude' || type === 'estimated_longitude') {
    return value.toFixed(5);
  }
  // Default: 1 decimal
  return String(Math.round(value * 10) / 10);
}

/** Telemetry timestamps are stored in milliseconds (Unix ms). */
function formatAge(timestampMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type HoursOption = 1 | 6 | 24 | 72 | 168;
const HOURS_OPTIONS: HoursOption[] = [1, 6, 24, 72, 168];
const HOURS_LABELS: Record<HoursOption, string> = { 1: '1h', 6: '6h', 24: '24h', 72: '3d', 168: '7d' };

type SortKey = 'newest' | 'oldest' | 'name-asc' | 'name-desc';
const SORT_LABELS: Record<SortKey, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  'name-asc': 'Name (A→Z)',
  'name-desc': 'Name (Z→A)',
};

export default function UnifiedTelemetryPage() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TelemetryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hours, setHours] = useState<HoursOption>(24);
  const [typeFilter, setTypeFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('newest');

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

  // Full source list (unfiltered) — stable palette + dropdown options. Using
  // a ref-ish memo over `entries` only so the color assignment doesn't change
  // when the user filters by source.
  const allSources = useMemo(() => {
    const seen = new Map<string, string>(); // id → name
    for (const e of entries) if (!seen.has(e.sourceId)) seen.set(e.sourceId, e.sourceName);
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [entries]);
  const sourceIds = allSources.map((s) => s.id);
  const allTypes = useMemo(
    () => Array.from(new Set(entries.map((e) => e.telemetryType))).sort(),
    [entries],
  );

  // Group entries → sourceId → nodeId → telemetryType → latest entry. Apply
  // type/source/search filters as we walk. Memoized so sort-only changes
  // don't re-scan the raw entry list.
  type NodeTypeMap = Record<string, TelemetryEntry>;
  type SourceNodeMap = Record<string, NodeTypeMap>;
  const searchLower = search.trim().toLowerCase();
  const bySource = useMemo(() => {
    const out: Record<string, SourceNodeMap> = {};
    for (const e of entries) {
      if (typeFilter && e.telemetryType !== typeFilter) continue;
      if (sourceFilter && e.sourceId !== sourceFilter) continue;
      if (searchLower) {
        const haystack = [e.nodeLongName, e.nodeShortName, e.nodeId, e.sourceName]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(searchLower)) continue;
      }
      if (!out[e.sourceId]) out[e.sourceId] = {};
      if (!out[e.sourceId][e.nodeId]) out[e.sourceId][e.nodeId] = {};
      const cur = out[e.sourceId][e.nodeId][e.telemetryType];
      if (!cur || e.timestamp > cur.timestamp) {
        out[e.sourceId][e.nodeId][e.telemetryType] = e;
      }
    }
    return out;
  }, [entries, typeFilter, sourceFilter, searchLower]);

  // Return nodes in the order the user asked for. `first` is any reading in
  // the node's type map used to pull the node name / latest timestamp.
  const sortNodes = (nodeMap: SourceNodeMap): Array<[string, NodeTypeMap]> => {
    const arr = Object.entries(nodeMap);
    const getName = (m: NodeTypeMap): string => {
      const first = Object.values(m)[0];
      return (first?.nodeLongName || first?.nodeShortName || '').toLowerCase();
    };
    const getLatest = (m: NodeTypeMap): number =>
      Math.max(...Object.values(m).map((r) => r.timestamp));

    switch (sortKey) {
      case 'newest':
        return arr.sort((a, b) => getLatest(b[1]) - getLatest(a[1]));
      case 'oldest':
        return arr.sort((a, b) => getLatest(a[1]) - getLatest(b[1]));
      case 'name-asc':
        return arr.sort((a, b) => getName(a[1]).localeCompare(getName(b[1])));
      case 'name-desc':
        return arr.sort((a, b) => getName(b[1]).localeCompare(getName(a[1])));
    }
  };

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

          <input
            className="unified-select unified-search"
            type="search"
            placeholder="Search nodes…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Search nodes"
          />

          <select
            className="unified-select"
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value)}
            aria-label="Filter by source"
          >
            <option value="">All sources</option>
            {allSources.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          <select
            className="unified-select"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            aria-label="Filter by type"
          >
            <option value="">All types</option>
            {allTypes.map(t => (
              <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
            ))}
          </select>

          <select
            className="unified-select"
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
            aria-label="Sort nodes"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map(k => (
              <option key={k} value={k}>{SORT_LABELS[k]}</option>
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

        {!loading && !error && Object.keys(bySource).length === 0 && entries.length > 0 && (
          <div className="unified-empty">No nodes match the current filters.</div>
        )}

        {Object.entries(bySource).map(([sourceId, nodeMap]) => {
          const color = getSourceColor(sourceId, sourceIds);
          const sourceName = allSources.find(s => s.id === sourceId)?.name ?? sourceId;
          const nodeEntries = sortNodes(nodeMap);

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
                  const readings = Object.values(typeMap).sort((a, b) => {
                    const la = TYPE_LABELS[a.telemetryType] ?? a.telemetryType;
                    const lb = TYPE_LABELS[b.telemetryType] ?? b.telemetryType;
                    return la.localeCompare(lb);
                  });
                  const latestTs = Math.max(...readings.map(r => r.timestamp));

                  return (
                    <div
                      key={nodeId}
                      className="unified-node-card"
                      style={{ borderTopColor: color }}
                    >
                      <div className="unified-node-card__header">
                        <span className="unified-node-card__name" title={nodeId}>{nodeName}</span>
                        <span className="unified-node-card__age">{formatAge(latestTs)}</span>
                      </div>
                      <div className="unified-node-card__readings">
                        {readings.map(r => {
                          const label = TYPE_LABELS[r.telemetryType] ?? r.telemetryType;
                          const unit = r.unit ?? inferUnit(r.telemetryType);
                          return (
                            <div key={r.telemetryType} className="unified-reading">
                              <div className="unified-reading__label" title={r.telemetryType}>
                                {label}
                              </div>
                              <div className="unified-reading__value">
                                {formatValue(r.telemetryType, r.value)}
                                {unit && <span className="unified-reading__unit">{unit}</span>}
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
        })}
      </div>
    </div>
  );
}
