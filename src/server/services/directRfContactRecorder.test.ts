/**
 * Direct RF Contacts recorder (#6210): the qualification predicates for both
 * protocols and the coalescing writer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/database.js', () => ({
  default: { directRfContacts: { applyDelta: vi.fn().mockResolvedValue(undefined) } },
}));

import {
  evaluateMeshtasticDirectRf,
  evaluateMeshCoreDirectRf,
  maybeRecordMeshCoreDirectRf,
  maybeRecordMeshtasticDirectRf,
  directRfContactRecorder,
  DirectRfContactRecorder,
  __resetDirectRfContactRecorderForTest,
  type MeshtasticDirectRfPacket,
  type DirectRfReception,
} from './directRfContactRecorder.js';
import { TransportMechanism } from '../constants/meshtastic.js';
import { directRfDayBucket, type DirectRfContactDelta } from '../../db/repositories/directRfContacts.js';

const NOW = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);
const LOCAL = 0x11111111;
const FROM = 0xdeadbeef;

function packet(over: Partial<MeshtasticDirectRfPacket> = {}): MeshtasticDirectRfPacket {
  return {
    from: FROM,
    id: 12345,
    rxSnr: 6.25,
    rxRssi: -88,
    hopStart: 3,
    hopLimit: 3,
    rxTime: NOW_SEC,
    viaMqtt: false,
    transportMechanism: TransportMechanism.LORA,
    decoded: { bitfield: 1 },
    ...over,
  };
}

const evalMt = (over: Partial<MeshtasticDirectRfPacket> = {}, extra: Partial<Parameters<typeof evaluateMeshtasticDirectRf>[0]> = {}) =>
  evaluateMeshtasticDirectRf({ sourceId: 'src-a', localNodeNum: LOCAL, packet: packet(over), nowMs: NOW, ...extra });

/** `PhoneAPI::makeReplayPacketId` (firmware 2.8), as replayGuard.ts computes it. */
function firmwareReplayId(fromNum: number, rxTimeSec: number, kind: number): number {
  let h = fromNum >>> 0;
  h = (Math.imul(h, 2654435761) + (rxTimeSec >>> 0)) >>> 0;
  h = (Math.imul(h, 2654435761) + kind) >>> 0;
  return h === 0 ? 1 : h;
}

describe('evaluateMeshtasticDirectRf', () => {
  it('a live zero-hop LoRa packet qualifies, keyed by !hex with its SNR/RSSI', () => {
    const r = evalMt();
    expect(r).toEqual({
      skip: null,
      reception: {
        sourceId: 'src-a', protocol: 'meshtastic', nodeKey: '!deadbeef', nodeNum: FROM,
        snr: 6.25, rssi: -88, heardAt: NOW,
      },
    });
  });

  it('counts every portnum (the predicate never looks at the payload)', () => {
    expect(evalMt({ decoded: { bitfield: 0 } }).skip).toBeNull();
  });

  it('an unset transport (older firmware) counts as RF', () => {
    expect(evalMt({ transportMechanism: null }).skip).toBeNull();
  });

  it('viaMqtt=true over LoRa (MQTT downlink rebroadcast) does NOT count', () => {
    expect(evalMt({ viaMqtt: true, transportMechanism: TransportMechanism.LORA })).toEqual({ skip: 'via-mqtt' });
  });

  it('an MQTT-transport packet does not count', () => {
    expect(evalMt({ transportMechanism: TransportMechanism.MQTT })).toEqual({ skip: 'via-mqtt' });
  });

  it('a multicast UDP packet is not RF', () => {
    expect(evalMt({ transportMechanism: TransportMechanism.MULTICAST_UDP })).toEqual({ skip: 'not-rf' });
  });

  it('a missing hopStart does not count', () => {
    expect(evalMt({ hopStart: null })).toEqual({ skip: 'no-hop-start' });
    expect(evalMt({ hopStart: undefined })).toEqual({ skip: 'no-hop-start' });
  });

  it('one or more hops, or hopStart < hopLimit, does not count', () => {
    expect(evalMt({ hopStart: 3, hopLimit: 2 })).toEqual({ skip: 'not-direct' });
    expect(evalMt({ hopStart: 2, hopLimit: 3 })).toEqual({ skip: 'not-direct' });
  });

  it('0/0 counts only with a bitfield (pre-2.3 firmware leaves hop_start unset as 0)', () => {
    expect(evalMt({ hopStart: 0, hopLimit: 0, decoded: { bitfield: 1 } }).skip).toBeNull();
    expect(evalMt({ hopStart: 0, hopLimit: 0, decoded: null })).toEqual({ skip: 'not-direct' });
  });

  it('a replayed rx_time (NodeDB replay on connect) does not count', () => {
    expect(evalMt({ rxTime: NOW_SEC - 3600 })).toEqual({ skip: 'not-live' });
  });

  it('a firmware 2.8 NodeDB replay that looks live is caught by its packet id (#5426)', () => {
    const id = firmwareReplayId(FROM, NOW_SEC, 3);
    expect(evalMt({ id, rxTime: NOW_SEC })).toEqual({ skip: 'nodedb-replay' });
  });

  it('a node with no clock (rx_time absent) still counts', () => {
    expect(evalMt({ rxTime: null }).skip).toBeNull();
  });

  it('our own node, an unknown local node, and S&F/virtual-node replays do not count', () => {
    expect(evalMt({ from: LOCAL })).toEqual({ skip: 'own-packet' });
    expect(evalMt({ from: 0 })).toEqual({ skip: 'own-packet' });
    expect(evalMt({}, { localNodeNum: null })).toEqual({ skip: 'no-local-node' });
    expect(evalMt({}, { replayed: true })).toEqual({ skip: 'replayed' });
  });

  it('the -128 "no SNR" sentinel stores as null; 0 dB stays 0', () => {
    const a = evalMt({ rxSnr: -128 });
    const b = evalMt({ rxSnr: 0, rxRssi: null });
    expect(a.skip === null && a.reception.snr).toBeNull();
    expect(b.skip === null && b.reception).toMatchObject({ snr: 0, rssi: null });
  });

  it('accepts bigint from / id / rxTime as protobuf hands them over', () => {
    expect(evalMt({ from: BigInt(FROM), id: BigInt(99), rxTime: BigInt(NOW_SEC) }).skip).toBeNull();
  });
});

// A genuinely Ed25519-signed advert (the Coverage Report's golden fixture,
// `coverageMeshCore.test.ts`): zero-hop (DIRECT, path sentinel) and the
// same signed payload as a 2-hop flood.
const GOLDEN_PUBLIC_KEY = 'f3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0';
const GOLDEN_ZERO_HOP_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';
const GOLDEN_FLOOD_RAW_HEX =
  '1142aabbccddf3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790346640023807b4f8476f6c64656e4e6f6465';
const GOLDEN_TAMPERED_RAW_HEX =
  '12fff3d220dfe9d16abbbe18c13906206cfa4d39e3f37c0b5241d08db75a375050f0e0a1d36846b1826a94a718e0fd961682e4642dffce38f8593e7c9d949a461bd100871ad0bd6e86240be715d5035463db80472a35c2d02a2cf465c988a4942f1f884ed50790cb6640023807b4f8476f6c64656e4e6f6465';
const LOCAL_PUB = 'b'.repeat(64);

describe('evaluateMeshCoreDirectRf', () => {
  const ev = (raw: string | null, over: Record<string, unknown> = {}) => evaluateMeshCoreDirectRf({
    sourceId: 'src-mc', localPubKey: LOCAL_PUB, nowMs: NOW,
    event: { payload_type: 0x04, snr: 6.5, rssi: -80, raw_hex: raw, ...over },
  });

  it('a zero-hop advert qualifies', () => {
    const r = ev(GOLDEN_ZERO_HOP_RAW_HEX);
    expect(r.skip).toBeNull();
    expect(r.skip === null && r.advert.publicKey.toLowerCase()).toBe(GOLDEN_PUBLIC_KEY);
  });

  it('a flooded advert that already took hops does not', () => {
    expect(ev(GOLDEN_FLOOD_RAW_HEX)).toEqual({ skip: 'not-direct' });
  });

  it('a non-advert payload never qualifies (its 1-byte source hash collides)', () => {
    expect(ev(GOLDEN_ZERO_HOP_RAW_HEX, { payload_type: 0x02 })).toEqual({ skip: 'not-advert' });
  });

  it('our own advert, an unknown local key, and junk are skipped', () => {
    expect(evaluateMeshCoreDirectRf({
      sourceId: 'src-mc', localPubKey: GOLDEN_PUBLIC_KEY, nowMs: NOW,
      event: { payload_type: 0x04, raw_hex: GOLDEN_ZERO_HOP_RAW_HEX },
    })).toEqual({ skip: 'own-advert' });
    expect(evaluateMeshCoreDirectRf({
      sourceId: 'src-mc', localPubKey: null, nowMs: NOW,
      event: { payload_type: 0x04, raw_hex: GOLDEN_ZERO_HOP_RAW_HEX },
    })).toEqual({ skip: 'no-local-node' });
    expect(ev(null)).toEqual({ skip: 'decode-failed' });
    expect(ev('zz')).toEqual({ skip: 'decode-failed' });
  });
});

describe('maybeRecord* hooks', () => {
  let recordSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetDirectRfContactRecorderForTest();
    recordSpy = vi.spyOn(directRfContactRecorder, 'record').mockImplementation(() => {});
  });
  afterEach(() => {
    recordSpy.mockRestore();
    __resetDirectRfContactRecorderForTest();
  });

  it('Meshtastic: records a qualifying packet, skips a viaMqtt one', () => {
    maybeRecordMeshtasticDirectRf({ sourceId: 'src-a', localNodeNum: LOCAL, packet: packet(), nowMs: NOW });
    maybeRecordMeshtasticDirectRf({ sourceId: 'src-a', localNodeNum: LOCAL, packet: packet({ viaMqtt: true }), nowMs: NOW });
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  it('MeshCore: a signed zero-hop advert records once; a replayed copy and a tampered one do not', async () => {
    const event = { payload_type: 0x04, snr: 6.5, rssi: -80, raw_hex: GOLDEN_ZERO_HOP_RAW_HEX };
    await maybeRecordMeshCoreDirectRf({ sourceId: 'src-mc', localPubKey: LOCAL_PUB, event, nowMs: NOW });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0][0]).toMatchObject({
      sourceId: 'src-mc', protocol: 'meshcore', nodeKey: GOLDEN_PUBLIC_KEY, nodeNum: null, snr: 6.5, rssi: -80,
    });
    // The same advert again after the path window: a replay (e.g. a shared contact).
    await maybeRecordMeshCoreDirectRf({ sourceId: 'src-mc', localPubKey: LOCAL_PUB, event, nowMs: NOW + 5 * 60_000 });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    await maybeRecordMeshCoreDirectRf({
      sourceId: 'src-mc2', localPubKey: LOCAL_PUB, event: { ...event, raw_hex: GOLDEN_TAMPERED_RAW_HEX }, nowMs: NOW,
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });
});

describe('DirectRfContactRecorder (coalescing writer)', () => {
  const D0 = directRfDayBucket(NOW);
  const rec = (over: Partial<DirectRfReception> = {}): DirectRfReception => ({
    sourceId: 'src-a', protocol: 'meshtastic', nodeKey: '!deadbeef', nodeNum: FROM,
    snr: 5, rssi: -90, heardAt: NOW, ...over,
  });

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('folds receptions of one (source, node, day) into one delta', async () => {
    const applied: DirectRfContactDelta[] = [];
    const r = new DirectRfContactRecorder(async (d) => { applied.push(d); }, 5_000, 500);
    r.record(rec({ heardAt: NOW + 1000, snr: 2, rssi: -95 }));
    r.record(rec({ heardAt: NOW, snr: 8, rssi: null }));
    r.record(rec({ heardAt: NOW + 2000, snr: null, rssi: -85 }));
    expect(applied).toHaveLength(0);
    await r.flush();
    expect(applied).toEqual([{
      sourceId: 'src-a', protocol: 'meshtastic', nodeKey: '!deadbeef', nodeNum: FROM, dayBucket: D0,
      firstHeardAt: NOW, lastHeardAt: NOW + 2000, count: 3,
      bestSnr: 8, bestRssi: -85, snrSum: 10, snrCount: 2, rssiSum: -180, rssiCount: 2,
    }]);
  });

  it('keeps separate deltas per source, node and UTC day', async () => {
    const applied: DirectRfContactDelta[] = [];
    const r = new DirectRfContactRecorder(async (d) => { applied.push(d); });
    r.record(rec());
    r.record(rec({ sourceId: 'src-b' }));
    r.record(rec({ nodeKey: '!00000001', nodeNum: 1 }));
    r.record(rec({ heardAt: D0 + 86_400_000 + 5 }));
    await r.flush();
    expect(applied).toHaveLength(4);
  });

  it('flushes on its own after the interval, and early when too many keys wait', async () => {
    const applied: DirectRfContactDelta[] = [];
    const r = new DirectRfContactRecorder(async (d) => { applied.push(d); }, 5_000, 3);
    r.record(rec());
    expect(r.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(applied).toHaveLength(1);
    expect(r.pendingCount).toBe(0);

    r.record(rec({ nodeKey: '!00000001', nodeNum: 1 }));
    r.record(rec({ nodeKey: '!00000002', nodeNum: 2 }));
    r.record(rec({ nodeKey: '!00000003', nodeNum: 3 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toHaveLength(4);
  });

  it('a failing write is dropped without stopping the rest of the batch', async () => {
    const applied: string[] = [];
    const r = new DirectRfContactRecorder(async (d) => {
      if (d.nodeKey === '!00000001') throw new Error('db down');
      applied.push(d.nodeKey);
    });
    r.record(rec({ nodeKey: '!00000001', nodeNum: 1 }));
    r.record(rec({ nodeKey: '!00000002', nodeNum: 2 }));
    await r.flush();
    expect(applied).toEqual(['!00000002']);
  });
});
