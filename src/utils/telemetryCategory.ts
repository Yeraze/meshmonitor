/**
 * Category classification for telemetry graph panels (#4930).
 *
 * `TelemetryGraphs` groups panels into sections so a viewer can find the
 * weather graphs next to each other, the network graphs next to each
 * other, and so on. This module owns the mapping from telemetry type
 * (`batteryLevel`, `mc_temperature_ch1`, `tmRateLimitDrops`, ...) to one
 * of a small fixed set of categories, plus the display order those
 * categories should render in.
 *
 * The `TYPE_CATEGORY` table below covers every key in `TELEMETRY_LABELS`
 * (see `src/components/TelemetryChart.tsx`). A missing entry falls
 * through to `'other'`; the unit test at `telemetryCategory.test.ts`
 * iterates the label map to catch a new metric that ships without a
 * category assignment.
 *
 * MeshCore LPP records carry a `_ch<N>` channel suffix (and multi-axis
 * types add a further `_<axisKey>` after that); we strip the suffix
 * before the lookup so every channel of a type lands in the same section
 * as the base name. This mirrors the label-lookup pattern in
 * `TelemetryChart.getTelemetryLabel`.
 */

export type TelemetryCategory =
  | 'favorites'
  | 'power'
  | 'signal'
  | 'network'
  | 'device'
  | 'environment'
  | 'airQuality'
  | 'location'
  | 'time'
  | 'other';

/**
 * Display order for the grouped grid. `favorites` renders first when the
 * caller has any favorited graphs; the remaining categories render in
 * this order, and each category renders only when it holds at least one
 * graph after the filter pass in `TelemetryGraphs`.
 */
export const TELEMETRY_CATEGORY_ORDER: TelemetryCategory[] = [
  'favorites',
  'power',
  'signal',
  'network',
  'device',
  'environment',
  'airQuality',
  'location',
  'time',
  'other',
];

/**
 * Default English section titles. i18n keys under `telemetry.category.*`
 * live in `public/locales/en.json`; consumers should render via
 * `t('telemetry.category.<key>', TELEMETRY_CATEGORY_LABELS[<key>])`.
 */
export const TELEMETRY_CATEGORY_LABELS: Record<TelemetryCategory, string> = {
  favorites: 'Favorites',
  power: 'Power',
  signal: 'Signal & Radio',
  network: 'Network & Traffic',
  device: 'Device Health',
  environment: 'Environment & Weather',
  airQuality: 'Air Quality',
  location: 'Location',
  time: 'Time & Sync',
  other: 'Other',
};

/** MeshCore LPP suffix pattern, kept in sync with the label lookup. */
const MC_CHANNEL_SUFFIX_RE = /^(mc_[a-z_]+?)_ch(\d+)(?:_[a-z]+)?$/i;

/**
 * Static type -> category table. Keep this ordered by category so the
 * next reader can see the whole group at a glance. Add new entries here
 * as new telemetry types land in `TELEMETRY_LABELS`.
 *
 * Every key that appears in `TELEMETRY_LABELS` (TelemetryChart.tsx)
 * should be represented here or handled by the MeshCore-suffix path.
 * `telemetryCategory.test.ts` enforces this by iterating the label map.
 */
const TYPE_CATEGORY: Record<string, TelemetryCategory> = {
  // ── Power ──────────────────────────────────────────────────────────
  batteryLevel: 'power',
  voltage: 'power',
  ch1Voltage: 'power', ch1Current: 'power',
  ch2Voltage: 'power', ch2Current: 'power',
  ch3Voltage: 'power', ch3Current: 'power',
  ch4Voltage: 'power', ch4Current: 'power',
  ch5Voltage: 'power', ch5Current: 'power',
  ch6Voltage: 'power', ch6Current: 'power',
  ch7Voltage: 'power', ch7Current: 'power',
  ch8Voltage: 'power', ch8Current: 'power',
  envVoltage: 'power', envCurrent: 'power',
  mc_battery_volts: 'power',
  mc_percentage: 'power',
  mc_current: 'power',
  mc_power: 'power',
  mc_energy: 'power',
  mc_status_battery_volts: 'power',

  // ── Signal & Radio ────────────────────────────────────────────────
  snr: 'signal',
  snr_local: 'signal',
  snr_remote: 'signal',
  rssi: 'signal',
  noiseFloor: 'signal',
  mc_status_noise_floor: 'signal',
  mc_status_last_rssi: 'signal',
  mc_status_last_snr: 'signal',
  mc_noise_floor: 'signal',
  mc_last_rssi: 'signal',
  mc_last_snr: 'signal',

  // ── Network & Traffic ─────────────────────────────────────────────
  channelUtilization: 'network',
  airUtilTx: 'network',
  numOnlineNodes: 'network',
  numTotalNodes: 'network',
  numPacketsTx: 'network',
  numPacketsRx: 'network',
  numPacketsRxBad: 'network',
  numRxDupe: 'network',
  numTxRelay: 'network',
  numTxRelayCanceled: 'network',
  numTxDropped: 'network',
  tmPacketsInspected: 'network',
  tmPositionDedupDrops: 'network',
  tmNodeinfoCacheHits: 'network',
  tmRateLimitDrops: 'network',
  tmUnknownPacketDrops: 'network',
  tmHopExhaustedPackets: 'network',
  tmRouterHopsPreserved: 'network',
  systemNodeCount: 'network',
  systemDirectNodeCount: 'network',
  paxcounterWifi: 'network',
  paxcounterBle: 'network',
  paxcounterUptime: 'network',
  mc_status_packets_recv: 'network',
  mc_status_packets_sent: 'network',
  mc_status_air_time_secs: 'network',
  mc_status_sent_flood: 'network',
  mc_status_sent_direct: 'network',
  mc_status_recv_flood: 'network',
  mc_status_recv_direct: 'network',
  mc_status_errors: 'network',
  mc_status_direct_dups: 'network',
  mc_status_flood_dups: 'network',
  mc_tx_duty_pct: 'network',
  mc_rx_duty_pct: 'network',
  mc_pkt_sent_rate: 'network',
  mc_pkt_recv_rate: 'network',
  mc_pkt_recv: 'network',
  mc_pkt_sent: 'network',
  mc_pkt_flood_tx: 'network',
  mc_pkt_direct_tx: 'network',
  mc_pkt_flood_rx: 'network',
  mc_pkt_direct_rx: 'network',
  mc_pkt_recv_errors: 'network',
  mc_tx_air_secs: 'network',
  mc_rx_air_secs: 'network',

  // ── Device Health ─────────────────────────────────────────────────
  uptimeSeconds: 'device',
  heapTotalBytes: 'device',
  heapFreeBytes: 'device',
  hostUptimeSeconds: 'device',
  hostFreememBytes: 'device',
  hostLoad1: 'device',
  hostLoad5: 'device',
  hostLoad15: 'device',
  mc_status_uptime_secs: 'device',
  mc_status_queue_len: 'device',
  mc_uptime_secs: 'device',
  mc_queue_len: 'device',

  // ── Environment & Weather ─────────────────────────────────────────
  temperature: 'environment',
  humidity: 'environment',
  pressure: 'environment',
  soilMoisture: 'environment',
  soilTemperature: 'environment',
  gasResistance: 'environment',
  iaq: 'environment',
  lux: 'environment',
  whiteLux: 'environment',
  irLux: 'environment',
  uvLux: 'environment',
  windDirection: 'environment',
  windSpeed: 'environment',
  windGust: 'environment',
  windLull: 'environment',
  rainfall1h: 'environment',
  rainfall24h: 'environment',
  distance: 'environment',
  weight: 'environment',
  formFormaldehyde: 'environment',
  formHumidity: 'environment',
  formTemperature: 'environment',
  pmTemperature: 'environment',
  pmHumidity: 'environment',
  radiation: 'environment',
  mc_temperature: 'environment',
  mc_humidity: 'environment',
  mc_barometer: 'environment',
  mc_illuminance: 'environment',
  mc_presence: 'environment',

  // ── Air Quality ───────────────────────────────────────────────────
  pm10Standard: 'airQuality',
  pm25Standard: 'airQuality',
  pm100Standard: 'airQuality',
  pm40Standard: 'airQuality',
  pm10Environmental: 'airQuality',
  pm25Environmental: 'airQuality',
  pm100Environmental: 'airQuality',
  particles03um: 'airQuality',
  particles05um: 'airQuality',
  particles10um: 'airQuality',
  particles25um: 'airQuality',
  particles40um: 'airQuality',
  particles50um: 'airQuality',
  particles100um: 'airQuality',
  particlesTps: 'airQuality',
  co2: 'airQuality',
  co2Temperature: 'airQuality',
  co2Humidity: 'airQuality',
  pmVocIdx: 'airQuality',
  pmNoxIdx: 'airQuality',

  // ── Location ──────────────────────────────────────────────────────
  altitude: 'location',
  sats_in_view: 'location',
  mc_altitude: 'location',

  // ── Time & Sync ───────────────────────────────────────────────────
  timeOffset: 'time',
  mc_rtc_drift_secs: 'time',
  mc_time: 'time',

  // ── Other (generic LPP; explicit so the label-map audit test passes)
  mc_analog_input: 'other',
  mc_analog_output: 'other',
  mc_frequency: 'other',
  mc_load: 'other',
  mc_concentration: 'other',
  mc_distance: 'other',
};

/**
 * Classify a telemetry type into one of the display categories. Handles
 * the `mc_*_ch<N>` and `mc_*_ch<N>_<axis>` suffixes MeshCore uses for
 * Cayenne LPP records: strip the suffix, look up the base name, fall
 * through to `'other'` on a miss.
 */
export function getTelemetryCategory(type: string): TelemetryCategory {
  const direct = TYPE_CATEGORY[type];
  if (direct) return direct;

  const match = type.match(MC_CHANNEL_SUFFIX_RE);
  if (match) {
    const base = TYPE_CATEGORY[match[1]];
    if (base) return base;
  }

  return 'other';
}
