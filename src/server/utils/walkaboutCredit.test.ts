/**
 * Walkabout credit rules (#5891 P1, spec §2.6).
 */
import { describe, it, expect } from 'vitest';
import { evaluateWalkaboutMeshtastic, evaluateWalkaboutMeshCore } from './walkaboutCredit.js';
import type { LastHopCandidate } from './lastHop.js';
import { TransportMechanism } from '../constants/meshtastic.js';
import type { MeshtasticDirectRfPacket } from '../services/directRfContactRecorder.js';

const NOW = 1_760_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);
const LOCAL = 0x11111111;
const FROM = 0xdeadbeef;

type Pkt = MeshtasticDirectRfPacket & { relayNode?: number | null };
const pkt = (over: Partial<Pkt> = {}): Pkt => ({
  from: FROM, id: 12345, rxSnr: 6.25, rxRssi: -88, hopStart: 3, hopLimit: 3, rxTime: NOW_SEC,
  viaMqtt: false, transportMechanism: TransportMechanism.LORA, decoded: { bitfield: 1 }, relayNode: 0,
  ...over,
});
const cand = (nodeNum: number, role: number | null = null): LastHopCandidate => ({ nodeNum, role });
const evalMt = (over: Partial<Pkt> = {}, extra: { candidates?: LastHopCandidate[]; localNodeNum?: number | null; replayed?: boolean } = {}) =>
  evaluateWalkaboutMeshtastic({ localNodeNum: LOCAL, replayed: false, nowMs: NOW, candidates: [], packet: pkt(over), ...extra });

describe('evaluateWalkaboutMeshtastic', () => {
  it('skips in spec order', () => {
    expect(evalMt({}, { localNodeNum: null })).toEqual({ skip: 'no-local-node' });
    expect(evalMt({}, { replayed: true })).toEqual({ skip: 'replayed' });
    expect(evalMt({ from: 0 })).toEqual({ skip: 'own-packet' });
    expect(evalMt({ from: LOCAL })).toEqual({ skip: 'own-packet' });
    expect(evalMt({ viaMqtt: true })).toEqual({ skip: 'via-mqtt' });
    expect(evalMt({ transportMechanism: TransportMechanism.MQTT })).toEqual({ skip: 'via-mqtt' });
    expect(evalMt({ transportMechanism: 6 })).toEqual({ skip: 'not-rf' });
    expect(evalMt({ id: 0 })).toEqual({ skip: 'no-packet-id' });
    expect(evalMt({ rxTime: NOW_SEC - 600 })).toEqual({ skip: 'not-live' });
  });

  it('skips a firmware 2.8 NodeDB replay that looks live (#5426)', () => {
    let h = FROM >>> 0;
    h = (Math.imul(h, 2654435761) + (NOW_SEC >>> 0)) >>> 0;
    h = (Math.imul(h, 2654435761) + 3) >>> 0;
    expect(evalMt({ id: h, rxTime: NOW_SEC })).toEqual({ skip: 'nodedb-replay' });
  });

  it('a zero-hop packet (0/0 with bitfield) credits the sender as direct', () => {
    const r = evalMt({ hopStart: 0, hopLimit: 0 });
    expect(r).toEqual({
      skip: null,
      credit: {
        protocol: 'meshtastic', creditedKey: '!deadbeef', creditedNodeNum: FROM, creditKind: 'direct',
        hopsAway: 0, packetKey: 'deadbeef:12345', snr: 6.25, rssi: -88,
      },
    });
  });

  it('0/0 without a bitfield is unknown-hops (pre-2.3 firmware)', () => {
    expect(evalMt({ hopStart: 0, hopLimit: 0, decoded: {} })).toEqual({ skip: 'unknown-hops' });
    expect(evalMt({ hopStart: null })).toEqual({ skip: 'unknown-hops' });
  });

  it('a relayed packet with a unique relayer credits the relayer', () => {
    const r = evalMt({ hopStart: 3, hopLimit: 2, relayNode: 0x4f }, { candidates: [cand(0xaabbcc4f), cand(0x11223301)] });
    expect(r).toMatchObject({
      skip: null,
      credit: { creditedKey: '!aabbcc4f', creditedNodeNum: 0xaabbcc4f, creditKind: 'relay', hopsAway: 1, packetKey: 'deadbeef:12345' },
    });
  });

  it('relay byte 0 is relay-none', () => {
    expect(evalMt({ hopStart: 3, hopLimit: 2, relayNode: 0 }, { candidates: [cand(0xaabbcc4f)] })).toEqual({ skip: 'relay-none' });
    expect(evalMt({ hopStart: 3, hopLimit: 2, relayNode: null }, { candidates: [cand(0xaabbcc4f)] })).toEqual({ skip: 'relay-none' });
  });

  it('two nodes sharing the byte is relay-ambiguous', () => {
    expect(evalMt({ hopStart: 3, hopLimit: 2, relayNode: 0x4f }, { candidates: [cand(0xaabbcc4f), cand(0x1122334f)] }))
      .toEqual({ skip: 'relay-ambiguous' });
  });

  it('only CLIENT_MUTE, local or sender matching is relay-unknown', () => {
    const candidates = [cand(0xaabbcc11, 1), cand(LOCAL), cand(0xdeadbe11)];
    expect(evalMt({ hopStart: 3, hopLimit: 2, relayNode: 0x11, from: 0xdeadbe11 }, { candidates })).toEqual({ skip: 'relay-unknown' });
    expect(evalMt({ hopStart: 3, hopLimit: 2, relayNode: 0x4f }, { candidates: [] })).toEqual({ skip: 'relay-unknown' });
  });

  it('-128 SNR becomes null and an explicit 0 RSSI is kept', () => {
    const r = evalMt({ hopStart: 0, hopLimit: 0, rxSnr: -128, rxRssi: 0 });
    expect(r).toMatchObject({ skip: null, credit: { snr: null, rssi: 0 } });
  });
});

// ---------------------------------------------------------------------------
// MeshCore frames
// ---------------------------------------------------------------------------
const hex = (n: number, fill = 0) => Array.from({ length: n }, (_, i) => ((fill + i) & 0xff).toString(16).padStart(2, '0')).join('');
const FLOOD = 1, DIRECT = 2;
const T_TXT = 0x02, T_ADVERT = 0x04, T_GRP = 0x05, T_ACK = 0x03, T_ANON = 0x07;
function frame(route: number, type: number, payloadHex: string, hops: string[] = [], hashSize = 1): string {
  const header = (route & 3) | (type << 2);
  const pathLen = ((hashSize - 1) << 6) | hops.length;
  return [header.toString(16).padStart(2, '0'), pathLen.toString(16).padStart(2, '0'), ...hops, payloadHex].join('');
}
const txt = (src: string) => `aa${src}0000deadbeef`; // dest(1) src(1) mac(2) data
const KEY = (b: string) => b.repeat(32);
const LOCALKEY = KEY('11');
const advertPayload = (key: string) => key + '01000000' + '55'.repeat(64) + '02';

describe('evaluateWalkaboutMeshCore', () => {
  const run = (raw: string, knownKeys: string[], extra: { relayKeys?: string[]; local?: string | null } = {}) =>
    evaluateWalkaboutMeshCore({
      localPubKey: extra.local === undefined ? LOCALKEY : extra.local,
      event: { raw_hex: raw, snr: 5.5, rssi: -90 }, knownKeys, relayKeys: extra.relayKeys,
    });

  it('flood with a unique last hop credits the relayer', () => {
    const r = run(frame(FLOOD, T_GRP, 'bbcc', ['aa', 'ab']), [KEY('ab'), KEY('cd')]);
    expect(r).toMatchObject({ skip: null, credit: { protocol: 'meshcore', creditedKey: KEY('ab'), creditKind: 'relay', hopsAway: 2, snr: 5.5, rssi: -90 } });
  });

  it('a last hop shared by two keys is relay-ambiguous, an unmatched one relay-unknown', () => {
    expect(run(frame(FLOOD, T_GRP, 'bbcc', ['ab']), [KEY('ab'), 'ab' + KEY('cd').slice(2)])).toEqual({ skip: 'relay-ambiguous' });
    expect(run(frame(FLOOD, T_GRP, 'bbcc', ['ee']), [KEY('ab')])).toEqual({ skip: 'relay-unknown' });
  });

  it('resolves 1-, 2- and 3-byte hash widths', () => {
    for (const w of [1, 2, 3]) {
      const hash = 'ab'.repeat(w);
      const r = run(frame(FLOOD, T_GRP, 'bbcc', [hash], w), [KEY('ab'), KEY('cd')]);
      expect(r).toMatchObject({ skip: null, credit: { creditedKey: KEY('ab'), creditKind: 'relay' } });
    }
  });

  it('relay lookup uses relayKeys (repeaters and rooms) when given', () => {
    // Companion key "ab" known, but not a relay candidate.
    expect(run(frame(FLOOD, T_GRP, 'bbcc', ['ab']), [KEY('ab')], { relayKeys: [] })).toEqual({ skip: 'relay-unknown' });
  });

  it('a direct route with a path is unknown-hops', () => {
    expect(run(frame(DIRECT, T_TXT, txt('ab'), ['cd']), [KEY('ab')])).toEqual({ skip: 'unknown-hops' });
  });

  it('direct route, empty path, TXT_MSG is direct-route-ambiguous', () => {
    expect(run(frame(DIRECT, T_TXT, txt('ab')), [KEY('ab')])).toEqual({ skip: 'direct-route-ambiguous' });
  });

  it('flood, empty path, TXT_MSG with a unique src hash credits the sender directly', () => {
    expect(run(frame(FLOOD, T_TXT, txt('ab')), [KEY('ab'), KEY('cd')]))
      .toMatchObject({ skip: null, credit: { creditedKey: KEY('ab'), creditKind: 'direct', hopsAway: 0 } });
    expect(run(frame(FLOOD, T_TXT, txt('ab')), [KEY('ab'), 'ab' + KEY('cd').slice(2)])).toEqual({ skip: 'relay-ambiguous' });
    expect(run(frame(FLOOD, T_TXT, txt('ee')), [KEY('ab')])).toEqual({ skip: 'relay-unknown' });
  });

  it('flood, empty path, ANON_REQ credits only a known full key', () => {
    const anon = `bb${KEY('ab')}00`;
    expect(run(frame(FLOOD, T_ANON, anon), [KEY('ab')])).toMatchObject({ skip: null, credit: { creditedKey: KEY('ab'), creditKind: 'direct' } });
    expect(run(frame(FLOOD, T_ANON, anon), [KEY('cd')])).toEqual({ skip: 'relay-unknown' });
  });

  it('a sender equal to (or a prefix of) our own key is own-packet', () => {
    expect(run(frame(FLOOD, T_TXT, txt('11')), [KEY('ab')])).toEqual({ skip: 'own-packet' });
    expect(run(frame(FLOOD, T_ANON, `bb${LOCALKEY}00`), [KEY('ab')])).toEqual({ skip: 'own-packet' });
  });

  it('GRP_TXT and ACK carry no sender', () => {
    expect(run(frame(FLOOD, T_GRP, 'bbcc'), [KEY('ab')])).toEqual({ skip: 'no-sender' });
    expect(run(frame(FLOOD, T_ACK, 'deadbeef'), [KEY('ab')])).toEqual({ skip: 'no-sender' });
  });

  it('a zero-hop advert returns verifyAdvert, direct and flood routed', () => {
    for (const route of [DIRECT, FLOOD]) {
      const r = run(frame(route, T_ADVERT, advertPayload(KEY('ab'))), []);
      expect(r).toMatchObject({ skip: null, credit: { creditedKey: KEY('ab'), creditKind: 'direct', hopsAway: 0 } });
      expect('verifyAdvert' in r && r.verifyAdvert?.publicKey).toBe(KEY('ab'));
    }
  });

  it('our own advert is own-advert', () => {
    expect(run(frame(FLOOD, T_ADVERT, advertPayload(LOCALKEY)), [])).toEqual({ skip: 'own-advert' });
  });

  it('bad hex is decode-failed', () => {
    expect(run('zz', [])).toEqual({ skip: 'decode-failed' });
    expect(run('', [])).toEqual({ skip: 'decode-failed' });
  });
});
