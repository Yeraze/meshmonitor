/**
 * Repeater RAW stream → TRACE hop SNRs (#5742).
 *
 * A Repeater source prints each heard packet as a RAW line plus an RX line.
 * A TRACE among them must reach the same ingest the Companion TraceData push
 * feeds (#5722), in the same shape. Nothing here transmits: there is no serial
 * port, and the feature only reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import meshcorePacketLogService from './services/meshcorePacketLogService.js';
import { meshcoreTraceIngestService } from './services/meshcoreTraceIngestService.js';
import { parseTraceDataPush, traceDataEventFromPush, type TraceDataBufferReader } from '../utils/meshcoreTrace.js';

const REP = 'src-rep-trace';
const SELF_KEY = 'fe'.repeat(32);

type Internals = {
  deviceType: MeshCoreDeviceType;
  connected: boolean;
  repeaterPublicKey: string | null;
  localNode: { publicKey: string } | null;
  handleSerialData: (line: string) => void;
  handleBridgeEvent?: unknown;
};

const hex = (bytes: number[]): string => bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

/** A direct TRACE packet as `Packet::writeTo` lays it out. */
function traceFrame(o: { snrs: number[]; hashes: number[]; pathSz?: number; tag: number; auth?: number }): string {
  return hex([0x26, o.snrs.length, ...o.snrs, ...u32(o.tag), ...u32(o.auth ?? 0), o.pathSz ?? 0, ...o.hashes]);
}

const rawLine = (rawHex: string): string => `14:02:07 - 30/9/2026 U RAW: ${rawHex.toUpperCase()}`;
const rxLine = (rawHex: string, snr: number, type = 9, route = 'D'): string =>
  `14:02:07 - 30/9/2026 U: RX, len=${rawHex.length / 2} (type=${type}, route=${route}, payload_len=11) SNR=${snr} RSSI=-92 score=1000 time=1 hash=00`;

function repeater(): { i: Internals; feed: (rawHex: string, snr: number) => void } {
  const m = new MeshCoreManager(REP);
  const i = m as unknown as Internals;
  i.deviceType = MeshCoreDeviceType.REPEATER;
  i.connected = true;
  i.repeaterPublicKey = SELF_KEY;
  const feed = (rawHex: string, snr: number) => {
    i.handleSerialData(rawLine(rawHex));
    i.handleSerialData(rxLine(rawHex, snr));
  };
  return { i, feed };
}

function reader(bytes: number[]): TraceDataBufferReader {
  const buf = Uint8Array.from(bytes);
  const view = new DataView(buf.buffer);
  let at = 0;
  return {
    readByte: () => buf[at++],
    readUInt8: () => buf[at++],
    readUInt32LE: () => { const v = view.getUint32(at, true); at += 4; return v; },
    readBytes: (n) => { const out = buf.slice(at, at + n); at += n; return out; },
    readInt8: () => view.getInt8(at++),
  };
}

describe('repeater RAW stream → TRACE ingest (#5742)', () => {
  let ingestSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(false);
    vi.spyOn(meshcorePacketLogService, 'logPacket').mockResolvedValue(undefined as never);
    ingestSpy = vi.spyOn(meshcoreTraceIngestService, 'ingest').mockResolvedValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a finished 1-byte-hash TRACE reaches ingest in the Companion push shape', () => {
    const { feed } = repeater();
    feed(traceFrame({ snrs: [34, 0xea], hashes: [0xb1, 0xc3], tag: 0xdeadbeef }), 3);

    // What a Companion at the same spot would push for this trace (3 dB = 12 q).
    const companion = traceDataEventFromPush(
      parseTraceDataPush(reader([0, 2, 0, ...u32(0xdeadbeef), ...u32(0), 0xb1, 0xc3, 34, 0xea, 12])),
      false,
    );
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(ingestSpy).toHaveBeenCalledWith(REP, companion, SELF_KEY, { inFlight: true });
    expect(companion).toEqual({
      tag: 0xdeadbeef, auth_code: 0, flags: 0, hash_bytes: 1,
      path_hashes_hex: 'b1c3', path_snrs_q: [34, -22], last_snr_q: 12, initiated: false,
    });
  });

  it('a 2-byte-hash TRACE keeps its hash width', () => {
    const { feed } = repeater();
    feed(traceFrame({ snrs: [40, 24], hashes: [0xb1, 0xc2, 0xc3, 0xd4], pathSz: 1, tag: 7, auth: 9 }), -5);
    expect(ingestSpy).toHaveBeenCalledWith(
      REP,
      { tag: 7, auth_code: 9, flags: 1, hash_bytes: 2, path_hashes_hex: 'b1c2c3d4', path_snrs_q: [40, 24], last_snr_q: -20, initiated: false },
      SELF_KEY,
      { inFlight: true },
    );
  });

  it('a TRACE caught mid-route carries only the SNRs on the wire', () => {
    const { feed } = repeater();
    feed(traceFrame({ snrs: [34], hashes: [0xb1, 0xc3, 0xb1], tag: 8 }), 6);
    expect(ingestSpy).toHaveBeenCalledWith(
      REP,
      expect.objectContaining({ path_hashes_hex: 'b1c3b1', path_snrs_q: [34], last_snr_q: 24 }),
      SELF_KEY,
      { inFlight: true },
    );
  });

  it('uses the key from `get public.key`, never the placeholder local node', () => {
    const { i, feed } = repeater();
    i.localNode = { publicKey: 'repeater' };
    i.repeaterPublicKey = null;
    feed(traceFrame({ snrs: [34], hashes: [0xb1], tag: 9 }), 6);
    expect(ingestSpy).toHaveBeenCalledWith(REP, expect.anything(), null, { inFlight: true });
  });

  it('a RAW line with no RX line still stores the path SNRs, with no local reading', () => {
    vi.useFakeTimers();
    try {
      const { i } = repeater();
      i.handleSerialData(rawLine(traceFrame({ snrs: [34], hashes: [0xb1, 0xc3], tag: 10 })));
      expect(ingestSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(ingestSpy).toHaveBeenCalledWith(REP, expect.objectContaining({ path_snrs_q: [34], last_snr_q: null }), SELF_KEY, { inFlight: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores packets that are not a TRACE, and malformed ones', () => {
    const { i, feed } = repeater();
    // GRP_TXT flood and a direct TXT_MSG.
    feed('1500aabbccddeeff00112233', 5);
    feed('0a01b1' + 'cd'.repeat(20), 5);
    // TRACE header, cut off inside the tag.
    feed('2600deadbe', 5);
    // TRACE with more SNRs than hops.
    feed(traceFrame({ snrs: [1, 2, 3], hashes: [0xb1], tag: 11 }), 5);
    // Not a log line at all.
    i.handleSerialData('  -> OK');
    expect(ingestSpy).not.toHaveBeenCalled();
  });

  it('a Companion source never reads RAW lines as traces', () => {
    const { i, feed } = repeater();
    i.deviceType = MeshCoreDeviceType.COMPANION;
    feed(traceFrame({ snrs: [34], hashes: [0xb1], tag: 12 }), 6);
    expect(ingestSpy).not.toHaveBeenCalled();
  });
});

describe('repeater TRACE → meshcore_hop_snr rows (#5742)', () => {
  beforeEach(async () => {
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(false);
    vi.spyOn(meshcorePacketLogService, 'logPacket').mockResolvedValue(undefined as never);
    await databaseService.meshcoreHopSnr.deleteBySourceId(REP);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await databaseService.meshcoreHopSnr.deleteBySourceId(REP);
  });

  it('stores each link once across the stages of one trace', async () => {
    const { feed } = repeater();
    const tag = 0x5742_0001;
    const hashes = [0xb1, 0xc3];
    feed(traceFrame({ snrs: [], hashes, tag }), 2);
    feed(traceFrame({ snrs: [34], hashes, tag }), 4);
    feed(traceFrame({ snrs: [34, 0xea], hashes, tag }), 3);

    await vi.waitFor(async () => {
      expect(await databaseService.meshcoreHopSnr.getRecent(REP, 0)).toHaveLength(4);
    });
    const rows = (await databaseService.meshcoreHopSnr.getRecent(REP, 0))
      .map((r) => ({
        hopIndex: r.hopIndex, sender: r.senderHash, receiver: r.receiverHash,
        receiverKey: r.receiverPublicKey, snr: r.snrQuarterDb, initiated: r.initiated, tag: r.traceTag,
      }))
      .sort((a, b) => a.hopIndex - b.hopIndex || (a.receiver === null ? 1 : 0) - (b.receiver === null ? 1 : 0));
    expect(rows).toEqual([
      { hopIndex: 0, sender: null, receiver: 'b1', receiverKey: null, snr: 34, initiated: false, tag },
      { hopIndex: 1, sender: 'b1', receiver: 'c3', receiverKey: null, snr: -22, initiated: false, tag },
      { hopIndex: 1, sender: 'b1', receiver: null, receiverKey: SELF_KEY, snr: 16, initiated: false, tag },
      { hopIndex: 2, sender: 'c3', receiver: null, receiverKey: SELF_KEY, snr: 12, initiated: false, tag },
    ]);
  });
});
