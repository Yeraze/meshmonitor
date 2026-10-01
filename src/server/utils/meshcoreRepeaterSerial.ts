/**
 * Pure helpers for the MeshCore Repeater serial CLI (#5500).
 *
 * A Repeater source talks to the device's text CLI over USB serial
 * (`examples/simple_repeater/main.cpp`). The firmware echoes each typed
 * character, then prints `"  -> " + reply` with NO end marker. Multi-line
 * replies (e.g. `neighbors`) prefix only the FIRST line with `->`.
 *
 * On builds compiled with `-D MESH_PACKET_LOGGING=1` (commented out in every
 * release env) the same serial port also carries unsolicited log lines:
 *
 *   "HH:MM:SS - d/m/yyyy U RAW: <full frame hex>"               (MyMesh::logRxRaw)
 *   "HH:MM:SS - d/m/yyyy U: RX, len=N (type=T, route=D|F, payload_len=P) SNR=S RSSI=R score=X time=Y hash=H [..]"
 *   "HH:MM:SS - d/m/yyyy U: TX, len=N (type=T, route=D|F, payload_len=P) [..]"
 *
 * and `MESH_DEBUG` builds add `DEBUG: …` lines. Those must never be mistaken
 * for a command reply, so every serial line is classified first.
 */

/** Fixed poll cadence for the repeater's `neighbors` table. Serial-only. */
export const REPEATER_NEIGHBORS_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * Delay before the first poll after a connect. Lets `refreshLocalNode` and the
 * connect-time CLI reads finish first. A reconnect waits out the rest of the
 * previous interval instead (see `nextRepeaterNeighborsPollDelay`).
 */
export const REPEATER_NEIGHBORS_INITIAL_DELAY_MS = 30_000;

/**
 * Idle gap that ends a `neighbors` reply. The firmware prints the whole reply
 * (≤ 160 chars) in one `Serial.println`, so every line arrives within a few ms
 * of the first `->` line; 300 ms of silence after it means the reply is done.
 * Without this the read would always wait the full command timeout, since the
 * reply carries no terminator.
 */
export const REPEATER_NEIGHBORS_IDLE_GAP_MS = 300;

/**
 * The firmware stops adding neighbour lines once the reply reaches 134 chars
 * (`formatNeighborsReply`: `dp - reply < 134`). A reply at or past that length
 * may have dropped older entries.
 */
export const REPEATER_NEIGHBORS_TRUNCATE_AT = 134;

/**
 * Max time a `RAW:` line waits for its `RX` line before it is logged alone.
 * The firmware prints RX right after RAW in the same `checkRecv()` call, and
 * skips RX entirely when the frame fails to parse.
 */
export const REPEATER_RAW_RX_PAIR_WINDOW_MS = 250;

export type RepeaterSerialLine =
  | { kind: 'raw'; rawHex: string }
  | { kind: 'rx'; len: number; snr: number; rssi: number }
  | { kind: 'tx' }
  | { kind: 'debug' }
  | { kind: 'other' };

// `MyMesh::getLogDateTime()`: "%02d:%02d:%02d - %d/%d/%d U".
const LOG_PREFIX = String.raw`^\d{1,2}:\d{2}:\d{2} - \d{1,2}/\d{1,2}/\d{4} U`;
const RAW_RE = new RegExp(`${LOG_PREFIX} RAW: ?([0-9A-Fa-f]+)$`);
const RX_RE = new RegExp(
  `${LOG_PREFIX}: RX, len=(\\d+) \\(type=\\d+, route=[DF], payload_len=\\d+\\) SNR=(-?\\d+) RSSI=(-?\\d+)`,
);
const TX_RE = new RegExp(`${LOG_PREFIX}: TX, len=\\d+ \\(type=\\d+, route=[DF], payload_len=\\d+\\)`);

/**
 * Classify one (trimmed) serial line. Only the exact firmware log shapes are
 * treated as streaming output; anything else is `other` and may be part of a
 * command reply.
 */
export function classifyRepeaterSerialLine(line: string): RepeaterSerialLine {
  const text = line.replace(/\r/g, '').trim();
  if (text.startsWith('DEBUG:')) return { kind: 'debug' };
  const raw = RAW_RE.exec(text);
  if (raw && raw[1].length % 2 === 0 && raw[1].length >= 4) {
    return { kind: 'raw', rawHex: raw[1].toLowerCase() };
  }
  const rx = RX_RE.exec(text);
  if (rx) {
    return { kind: 'rx', len: parseInt(rx[1], 10), snr: parseInt(rx[2], 10), rssi: parseInt(rx[3], 10) };
  }
  if (TX_RE.test(text)) return { kind: 'tx' };
  return { kind: 'other' };
}

/** True for unsolicited log output that must be kept out of command replies. */
export function isRepeaterStreamingLine(kind: RepeaterSerialLine['kind']): boolean {
  return kind !== 'other';
}

export interface RepeaterRawPacket {
  rawHex: string;
  /** dB, integer (firmware prints `(int)pkt->getSNR()`); undefined without an RX line. */
  snr?: number;
  /** dBm, integer; undefined without an RX line. */
  rssi?: number;
}

/**
 * Pairs each `RAW:` line with the `RX` line that follows it, for SNR/RSSI.
 *
 * - RAW then RX (same byte length) within the window → one packet with signal.
 * - RAW then RAW, RAW then timeout, or a length mismatch → the pending RAW is
 *   emitted without signal. A RAW line is never dropped.
 * - An RX line with no pending RAW is ignored (nothing to attach it to).
 */
export class RepeaterPacketLinePairer {
  private pending: { rawHex: string; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly onPacket: (packet: RepeaterRawPacket) => void,
    private readonly windowMs: number = REPEATER_RAW_RX_PAIR_WINDOW_MS,
  ) {}

  feed(line: RepeaterSerialLine): void {
    if (line.kind === 'raw') {
      this.flush();
      const rawHex = line.rawHex;
      const timer = setTimeout(() => this.flush(), this.windowMs);
      this.pending = { rawHex, timer };
      return;
    }
    if (line.kind === 'rx' && this.pending) {
      const { rawHex, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      if (line.len === rawHex.length / 2) {
        this.onPacket({ rawHex, snr: line.snr, rssi: line.rssi });
      } else {
        this.onPacket({ rawHex });
      }
    }
  }

  /** Emit any pending RAW line without signal data. */
  flush(): void {
    if (!this.pending) return;
    const { rawHex, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    this.onPacket({ rawHex });
  }

  /** Drop any pending RAW line without emitting it (teardown). */
  reset(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}

/** Remove the firmware's `->` reply marker from the start of a line. */
export function stripReplyMarker(line: string): string {
  return line.replace(/^\s*->\s?/, '');
}

/**
 * Parse `get public.key` → the repeater's own 64-hex key, lowercased.
 * Firmware reply: `"  -> > <64 hex>"`. Returns null for anything else.
 */
export function parseRepeaterPublicKeyReply(reply: string): string | null {
  const m = /->\s*>\s*([0-9A-Fa-f]{64})\b/.exec(reply);
  return m ? m[1].toLowerCase() : null;
}

/**
 * True when a `neighbors` reply may have been cut short by the firmware's
 * 134-char cap, so older entries could be missing.
 */
export function isNeighborsReplyPossiblyTruncated(reply: string): boolean {
  const body = reply
    .split('\n')
    .map((l) => stripReplyMarker(l.replace(/\r/g, '')).trim())
    .filter((l) => l.length > 0)
    .join('\n');
  return body.length >= REPEATER_NEIGHBORS_TRUNCATE_AT;
}

/**
 * Delay until the next neighbours poll when the scheduler (re)starts.
 * A reconnect never polls sooner than a full interval after the last poll,
 * so a flapping serial link can't turn into a poll burst.
 */
export function nextRepeaterNeighborsPollDelay(lastPollAt: number | null, now: number): number {
  if (lastPollAt === null) return REPEATER_NEIGHBORS_INITIAL_DELAY_MS;
  const remaining = REPEATER_NEIGHBORS_POLL_INTERVAL_MS - (now - lastPollAt);
  return Math.max(REPEATER_NEIGHBORS_INITIAL_DELAY_MS, remaining);
}

/** Minimal node row shape the resolver needs. */
export interface NeighbourCandidateRow {
  publicKey: string;
  name?: string | null;
  advType?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  lastHeard?: number | null;
}

/**
 * Resolve an 8-hex neighbour prefix against candidate rows from ANY source.
 *
 * Returns the full key plus the best row to copy identity fields from, or
 * null when zero or more than one DISTINCT key matches (never guess, never
 * create a prefix stub). Several rows of the same key (one per source) count
 * as one match; the row with a name, then a position, then the newest
 * `lastHeard` wins.
 */
export function resolveNeighbourPrefix(
  prefix: string,
  rows: NeighbourCandidateRow[],
): { publicKey: string; row: NeighbourCandidateRow } | null {
  const needle = prefix.toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(needle)) return null;
  const matches = rows.filter(
    (r) => typeof r.publicKey === 'string' && /^[0-9a-fA-F]{64}$/.test(r.publicKey) && r.publicKey.toLowerCase().startsWith(needle),
  );
  const keys = new Set(matches.map((r) => r.publicKey.toLowerCase()));
  if (keys.size !== 1) return null;
  const score = (r: NeighbourCandidateRow): number =>
    (r.name ? 4 : 0) + (typeof r.latitude === 'number' && typeof r.longitude === 'number' ? 2 : 0) + (typeof r.advType === 'number' ? 1 : 0);
  const best = [...matches].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return Number(b.lastHeard ?? 0) - Number(a.lastHeard ?? 0);
  })[0];
  return { publicKey: [...keys][0], row: best };
}
