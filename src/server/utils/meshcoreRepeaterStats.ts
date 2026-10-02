/**
 * Local-stats parsers for a directly-attached MeshCore Repeater (#5533).
 *
 * A Repeater source talks to the device's text CLI over USB serial
 * (`examples/simple_repeater/main.cpp:154` prints `"  -> " + reply`). The
 * firmware answers these read-only commands locally. None of them transmits
 * on RF: `CommonCLI::handleCommand` only accepts the three `stats-*` verbs
 * when `sender_timestamp == 0`, i.e. from the serial console, never from the
 * mesh (`src/helpers/CommonCLI.cpp:437-442`).
 *
 * | Command         | Firmware source                                   | Reply body |
 * |-----------------|---------------------------------------------------|------------|
 * | `stats-core`    | `StatsFormatHelper.h` formatCoreStats             | `{"battery_mv":4120,"uptime_secs":86400,"errors":0,"queue_len":0}` |
 * | `stats-radio`   | `StatsFormatHelper.h` formatRadioStats            | `{"noise_floor":-112,"last_rssi":-87,"last_snr":7.25,"tx_air_secs":312,"rx_air_secs":4521}` |
 * | `stats-packets` | `StatsFormatHelper.h` formatPacketStats           | `{"recv":1520,"sent":340,"flood_tx":200,"direct_tx":140,"flood_rx":1100,"direct_rx":420,"recv_errors":12}` |
 * | `clock`         | `CommonCLI.cpp:213-216`                           | `14:05 - 2/10/2026 UTC` (minute resolution) |
 * | `ver`           | `CommonCLI.cpp:272-273`                           | `v1.17.1 (Build: 14 Aug 2026)` |
 * | `board`         | `CommonCLI.cpp:274-275`                           | `Heltec V3` |
 *
 * The `stats-*` JSON uses the same snake_case keys as the companion
 * protocol's `get_stats` payload, so both paths feed one mapper and produce
 * identical shapes. Every parser returns null on a missing, `Unknown command`
 * (older firmware) or garbled reply, so a field reads as unknown, never 0.
 */

import type { MeshCoreStatsCore, MeshCoreStatsRadio, MeshCoreStatsPackets } from '../meshcoreManager.js';

/**
 * Idle gap that ends a one-line stats reply. These replies carry no
 * terminator the CLI reader knows (`-> >`, `OK`, `Error`), so without it every
 * read would wait the full command timeout. Same value as the neighbours read.
 */
export const REPEATER_STATS_IDLE_GAP_MS = 300;

/** Per-command ceiling when the device stays silent (matches refreshLocalNode). */
export const REPEATER_STATS_TIMEOUT_MS = 5_000;

/** The repeater `clock` reply has minute resolution (`HH:MM - d/m/yyyy UTC`). */
export const REPEATER_CLOCK_RESOLUTION_SECS = 60;

type RawStats = Record<string, number | null | undefined>;

// typeof-only on purpose: this is the exact check the companion path always
// used, so routing it through these mappers changes nothing (#5533). The
// repeater extractor below only ever hands over finite numbers.
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Shared snake_case → camelCase mapping for `get_stats` / `stats-core`. */
export function mapStatsCore(d: RawStats): MeshCoreStatsCore {
  return {
    batteryMv: num(d.battery_mv),
    uptimeSecs: num(d.uptime_secs),
    errors: num(d.errors),
    queueLen: num(d.queue_len),
  };
}

/** Shared snake_case → camelCase mapping for `get_stats` / `stats-radio`. */
export function mapStatsRadio(d: RawStats): MeshCoreStatsRadio {
  return {
    noiseFloor: num(d.noise_floor),
    lastRssi: num(d.last_rssi),
    lastSnr: num(d.last_snr),
    txAirSecs: num(d.tx_air_secs),
    rxAirSecs: num(d.rx_air_secs),
  };
}

/** Shared snake_case → camelCase mapping for `get_stats` / `stats-packets`. */
export function mapStatsPackets(d: RawStats): MeshCoreStatsPackets {
  return {
    recv: num(d.recv),
    sent: num(d.sent),
    floodTx: num(d.flood_tx),
    directTx: num(d.direct_tx),
    floodRx: num(d.flood_rx),
    directRx: num(d.direct_rx),
    recvErrors: typeof d.recv_errors === 'number' ? d.recv_errors : null,
  };
}

/** The text after the firmware's `->` marker on the reply line, or null. */
export function repeaterReplyBody(reply: string | null | undefined): string | null {
  for (const line of (reply ?? '').split(/\r?\n/)) {
    const m = /->\s?(.*)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Pull the listed numeric keys out of a `stats-*` JSON body. Reads key by key
 * rather than with JSON.parse, so one malformed value (e.g. a `%.2f` the
 * board's printf can't render) costs only that field. Returns null when no
 * key matched at all.
 */
function extractStatsJson(reply: string | null | undefined, keys: readonly string[]): RawStats | null {
  const body = repeaterReplyBody(reply);
  if (!body || !body.startsWith('{')) return null;
  const out: RawStats = {};
  let found = 0;
  for (const key of keys) {
    const m = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(body);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) {
      out[key] = n;
      found++;
    }
  }
  return found > 0 ? out : null;
}

const CORE_KEYS = ['battery_mv', 'uptime_secs', 'errors', 'queue_len'] as const;
const RADIO_KEYS = ['noise_floor', 'last_rssi', 'last_snr', 'tx_air_secs', 'rx_air_secs'] as const;
const PACKET_KEYS = ['recv', 'sent', 'flood_tx', 'direct_tx', 'flood_rx', 'direct_rx', 'recv_errors'] as const;

/** Parse a `stats-core` reply. */
export function parseRepeaterStatsCore(reply: string | null | undefined): MeshCoreStatsCore | null {
  const raw = extractStatsJson(reply, CORE_KEYS);
  return raw ? mapStatsCore(raw) : null;
}

/** Parse a `stats-radio` reply. */
export function parseRepeaterStatsRadio(reply: string | null | undefined): MeshCoreStatsRadio | null {
  const raw = extractStatsJson(reply, RADIO_KEYS);
  return raw ? mapStatsRadio(raw) : null;
}

/** Parse a `stats-packets` reply. */
export function parseRepeaterStatsPackets(reply: string | null | undefined): MeshCoreStatsPackets | null {
  const raw = extractStatsJson(reply, PACKET_KEYS);
  return raw ? mapStatsPackets(raw) : null;
}

/**
 * Parse a `clock` reply (`"HH:MM - d/m/yyyy UTC"`) to Unix seconds at the
 * start of that minute. The firmware prints no seconds, so the result is only
 * good to {@link REPEATER_CLOCK_RESOLUTION_SECS}.
 */
export function parseRepeaterClockReply(reply: string | null | undefined): number | null {
  const body = repeaterReplyBody(reply);
  if (!body) return null;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*UTC\b/.exec(body);
  if (!m) return null;
  const [hour, minute, day, month, year] = m.slice(1).map((s) => parseInt(s, 10));
  if (hour > 23 || minute > 59 || day < 1 || day > 31 || month < 1 || month > 12) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, 0);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Parse a `ver` reply (`"v1.17.1 (Build: 14 Aug 2026)"`). */
export function parseRepeaterVerReply(reply: string | null | undefined): { ver: string; firmwareBuild?: string } | null {
  const body = repeaterReplyBody(reply);
  if (!body || /^(unknown command|error)/i.test(body)) return null;
  const m = /^(.+?)\s*\(Build:\s*([^)]*)\)\s*$/.exec(body);
  if (m) {
    const build = m[2].trim();
    return { ver: m[1].trim(), ...(build ? { firmwareBuild: build } : {}) };
  }
  return { ver: body };
}

/** Parse a `board` reply (the manufacturer/board name). */
export function parseRepeaterBoardReply(reply: string | null | undefined): string | null {
  const body = repeaterReplyBody(reply);
  if (!body || /^(unknown command|error)/i.test(body)) return null;
  return body;
}
