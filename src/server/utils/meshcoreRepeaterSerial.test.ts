/**
 * Pure helpers for the MeshCore Repeater serial CLI (#5500). Line shapes are
 * copied from MeshCore a366955 (== repeater-v1.17.1): MyMesh::logRxRaw,
 * Dispatcher::checkRecv / checkSend, MESH_DEBUG_PRINTLN, formatNeighborsReply.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyRepeaterSerialLine,
  isRepeaterStreamingLine,
  RepeaterPacketLinePairer,
  parseRepeaterPublicKeyReply,
  isNeighborsReplyPossiblyTruncated,
  nextRepeaterNeighborsPollDelay,
  resolveNeighbourPrefix,
  stripReplyMarker,
  REPEATER_NEIGHBORS_INITIAL_DELAY_MS,
  REPEATER_NEIGHBORS_POLL_INTERVAL_MS,
  REPEATER_RAW_RX_PAIR_WINDOW_MS,
  type RepeaterRawPacket,
} from './meshcoreRepeaterSerial.js';

// Real GRP_TXT flood frame (69 bytes) — CoreScope capture, see meshcoreObserverPacket.test.ts.
const GRP_TXT =
  '1540D9AEFFB8183F8F47F919E136150469109973F7C3E2C2932DCA02542008F06F72F2A75639827A40C96F08A544D1BC568BAD9F100D29DACA0B3E8098F75476195E43E9F5';

const RAW_LINE = `14:02:07 - 30/9/2026 U RAW: ${GRP_TXT}`;
const RX_LINE =
  '14:02:07 - 30/9/2026 U: RX, len=69 (type=5, route=F, payload_len=66) SNR=7 RSSI=-92 score=1000 time=1234 hash=931D5DA9D6054F49';
const TX_LINE = '14:02:08 - 30/9/2026 U: TX, len=69 (type=5, route=F, payload_len=66)';

describe('classifyRepeaterSerialLine', () => {
  it('recognises a RAW line and lowercases the hex', () => {
    expect(classifyRepeaterSerialLine(RAW_LINE)).toEqual({ kind: 'raw', rawHex: GRP_TXT.toLowerCase() });
  });

  it('recognises an RX line with SNR / RSSI, with or without the [src -> dst] tail', () => {
    expect(classifyRepeaterSerialLine(RX_LINE)).toEqual({ kind: 'rx', len: 69, snr: 7, rssi: -92 });
    expect(classifyRepeaterSerialLine(`${RX_LINE.replace('type=5', 'type=2')} [A1 -> B2]`)).toEqual({
      kind: 'rx', len: 69, snr: 7, rssi: -92,
    });
    expect(
      classifyRepeaterSerialLine('09:00:00 - 1/1/2024 U: RX, len=26 (type=1, route=D, payload_len=19) SNR=-3 RSSI=-110 score=250 time=40 hash=26EB14C8F6B56595'),
    ).toEqual({ kind: 'rx', len: 26, snr: -3, rssi: -110 });
  });

  it('recognises TX and DEBUG lines', () => {
    expect(classifyRepeaterSerialLine(TX_LINE)).toEqual({ kind: 'tx' });
    expect(classifyRepeaterSerialLine(`${TX_LINE} [A1 -> B2]`)).toEqual({ kind: 'tx' });
    expect(classifyRepeaterSerialLine('DEBUG: Login, sender not in ACL')).toEqual({ kind: 'debug' });
  });

  it('leaves command replies, echoes and garbage as other', () => {
    for (const line of [
      '  -> > MC HR ZG SQ42',
      '  -> ABCD1234:12:40',
      'EF015678:300:-8',
      '-none-',
      'neighbors',
      'RAW: deadbeef', // no log-date prefix: not the firmware shape
      '14:02:07 - 30/9/2026 U RAW: xyz',
      '',
      '\u0000ÿ garbage',
    ]) {
      expect(classifyRepeaterSerialLine(line).kind).toBe('other');
    }
  });

  it('isRepeaterStreamingLine is true only for log output', () => {
    expect(isRepeaterStreamingLine('raw')).toBe(true);
    expect(isRepeaterStreamingLine('rx')).toBe(true);
    expect(isRepeaterStreamingLine('tx')).toBe(true);
    expect(isRepeaterStreamingLine('debug')).toBe(true);
    expect(isRepeaterStreamingLine('other')).toBe(false);
  });
});

describe('RepeaterPacketLinePairer', () => {
  afterEach(() => vi.useRealTimers());

  function pairer() {
    const out: RepeaterRawPacket[] = [];
    const p = new RepeaterPacketLinePairer((pkt) => out.push(pkt));
    return { p, out };
  }

  it('attaches SNR / RSSI from the RX line that follows', () => {
    const { p, out } = pairer();
    p.feed(classifyRepeaterSerialLine(RAW_LINE));
    expect(out).toEqual([]);
    p.feed(classifyRepeaterSerialLine(RX_LINE));
    expect(out).toEqual([{ rawHex: GRP_TXT.toLowerCase(), snr: 7, rssi: -92 }]);
  });

  it('emits a lone RAW line without signal after the pairing window', () => {
    vi.useFakeTimers();
    const { p, out } = pairer();
    p.feed(classifyRepeaterSerialLine(RAW_LINE));
    vi.advanceTimersByTime(REPEATER_RAW_RX_PAIR_WINDOW_MS + 1);
    expect(out).toEqual([{ rawHex: GRP_TXT.toLowerCase() }]);
    // A late RX has nothing to pair with.
    p.feed(classifyRepeaterSerialLine(RX_LINE));
    expect(out).toHaveLength(1);
  });

  it('flushes the pending RAW when the next RAW arrives first', () => {
    const { p, out } = pairer();
    p.feed(classifyRepeaterSerialLine(RAW_LINE));
    p.feed(classifyRepeaterSerialLine('14:02:09 - 30/9/2026 U RAW: 0642359A9CC9782930704E86F9D77715A516E5B1F7DC14F3CC75'));
    expect(out).toEqual([{ rawHex: GRP_TXT.toLowerCase() }]);
    p.flush();
    expect(out[1]).toEqual({ rawHex: '0642359a9cc9782930704e86f9d77715a516e5b1f7dc14f3cc75' });
  });

  it('does not attach an RX line whose length disagrees', () => {
    const { p, out } = pairer();
    p.feed(classifyRepeaterSerialLine(RAW_LINE));
    p.feed(classifyRepeaterSerialLine(RX_LINE.replace('len=69', 'len=12')));
    expect(out).toEqual([{ rawHex: GRP_TXT.toLowerCase() }]);
  });

  it('reset drops a pending RAW without emitting', () => {
    vi.useFakeTimers();
    const { p, out } = pairer();
    p.feed(classifyRepeaterSerialLine(RAW_LINE));
    p.reset();
    vi.advanceTimersByTime(REPEATER_RAW_RX_PAIR_WINDOW_MS * 2);
    expect(out).toEqual([]);
  });
});

describe('parseRepeaterPublicKeyReply', () => {
  it('reads the 64-hex key and lowercases it', () => {
    const key = 'AB'.repeat(32);
    expect(parseRepeaterPublicKeyReply(`  -> > ${key}`)).toBe(key.toLowerCase());
  });

  it('returns null for errors, short keys and empty replies', () => {
    expect(parseRepeaterPublicKeyReply('  -> Error: unknown config')).toBeNull();
    expect(parseRepeaterPublicKeyReply('  -> > ABCD')).toBeNull();
    expect(parseRepeaterPublicKeyReply('')).toBeNull();
  });
});

describe('stripReplyMarker', () => {
  it('removes a leading ->', () => {
    expect(stripReplyMarker('  -> ABCD1234:1:2')).toBe('ABCD1234:1:2');
    expect(stripReplyMarker('ABCD1234:1:2')).toBe('ABCD1234:1:2');
  });
});

describe('isNeighborsReplyPossiblyTruncated', () => {
  it('is false for short replies and -none-', () => {
    expect(isNeighborsReplyPossiblyTruncated('  -> -none-')).toBe(false);
    expect(isNeighborsReplyPossiblyTruncated('  -> ABCD1234:12:40\nEF015678:300:-8')).toBe(false);
  });

  it('is true once the body reaches the firmware 134-char cap', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `${(0xa0000000 + i).toString(16).toUpperCase()}:${1000 + i}:-40`);
    const reply = `  -> ${lines.join('\n')}`;
    expect(isNeighborsReplyPossiblyTruncated(reply)).toBe(true);
  });
});

describe('nextRepeaterNeighborsPollDelay', () => {
  it('waits the initial delay on the first connect', () => {
    expect(nextRepeaterNeighborsPollDelay(null, 1_000_000)).toBe(REPEATER_NEIGHBORS_INITIAL_DELAY_MS);
  });

  it('waits out the rest of the interval after a recent poll (no reconnect burst)', () => {
    const now = 10_000_000;
    expect(nextRepeaterNeighborsPollDelay(now - 60_000, now)).toBe(REPEATER_NEIGHBORS_POLL_INTERVAL_MS - 60_000);
  });

  it('never goes below the initial delay', () => {
    const now = 10_000_000;
    expect(nextRepeaterNeighborsPollDelay(now - REPEATER_NEIGHBORS_POLL_INTERVAL_MS * 3, now)).toBe(
      REPEATER_NEIGHBORS_INITIAL_DELAY_MS,
    );
  });
});

describe('resolveNeighbourPrefix', () => {
  const K1 = 'abcd1234' + '1'.repeat(56);
  const K2 = 'abcd1234' + '2'.repeat(56);

  it('resolves a unique key and picks the richest row across sources', () => {
    const r = resolveNeighbourPrefix('ABCD1234', [
      { publicKey: K1, name: null, lastHeard: 9 },
      { publicKey: K1.toUpperCase(), name: 'Hilltop', latitude: 45.1, longitude: 15.9, advType: 2, lastHeard: 5 },
    ]);
    expect(r?.publicKey).toBe(K1);
    expect(r?.row.name).toBe('Hilltop');
  });

  it('breaks ties on the newest lastHeard', () => {
    const r = resolveNeighbourPrefix('abcd1234', [
      { publicKey: K1, name: 'Old', lastHeard: 1 },
      { publicKey: K1, name: 'New', lastHeard: 2 },
    ]);
    expect(r?.row.name).toBe('New');
  });

  it('skips an ambiguous prefix', () => {
    expect(resolveNeighbourPrefix('abcd1234', [{ publicKey: K1 }, { publicKey: K2 }])).toBeNull();
  });

  it('skips when nothing matches, or the prefix/keys are malformed', () => {
    expect(resolveNeighbourPrefix('abcd1234', [])).toBeNull();
    expect(resolveNeighbourPrefix('abcd1234', [{ publicKey: 'ffff0000' + '1'.repeat(56) }])).toBeNull();
    expect(resolveNeighbourPrefix('abcd', [{ publicKey: K1 }])).toBeNull();
    expect(resolveNeighbourPrefix('abcd1234', [{ publicKey: 'abcd1234' }])).toBeNull();
    expect(resolveNeighbourPrefix('abcd1234', [{ publicKey: 'repeater' }])).toBeNull();
  });
});
