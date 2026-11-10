import { describe, it, expect } from 'vitest';
import {
  computeMeshcorePacketRates,
  computeMeshcoreClockOffsets,
  isClockOffsetFlagged,
} from './meshcoreSecurityScan.js';
import type { MeshcorePacketRow } from './meshcorePacketWindow.js';

const NOW = 2_000_000_000_000;
const HOUR = 3_600_000;
const KEY_A = 'ab'.repeat(32);
const KEY_B = 'cd'.repeat(32);
const KEY_B2 = 'cd' + 'ee'.repeat(31); // same first byte as KEY_B
const LOCAL = '01'.repeat(32);

function frame(payloadType: number, payloadHex: string, path = ''): string {
  const header = (payloadType << 2) | 1;
  return (
    header.toString(16).padStart(2, '0') + (path.length / 2).toString(16).padStart(2, '0') + path + payloadHex
  );
}
function advertHex(key: string, senderSec: number, path = ''): string {
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE(senderSec);
  return frame(4, key + ts.toString('hex') + '00'.repeat(64) + '81' + Buffer.from('n').toString('hex'), path);
}
let seq = 0;
function row(over: Partial<MeshcorePacketRow>): MeshcorePacketRow {
  return {
    id: ++seq,
    sourceId: 's1',
    timestamp: NOW - 1000,
    payloadType: 4,
    routeType: 1,
    hopCount: 0,
    senderPubKey: null,
    srcHash: null,
    rawHex: null,
    observerId: null,
    ...over,
  };
}
const nodes = [{ publicKey: KEY_A }, { publicKey: KEY_B }, { publicKey: LOCAL }];

describe('computeMeshcorePacketRates', () => {
  it('counts MQTT copies from three observers once', () => {
    const raw = advertHex(KEY_A, 1_999_999_000);
    const packets = ['o1', 'o2', 'o3'].map((o) =>
      row({ senderPubKey: KEY_A, rawHex: raw, observerId: o }),
    );
    const r = computeMeshcorePacketRates(packets, nodes, { nowMs: NOW });
    expect(r.get(KEY_A)).toEqual({ packets: 1, adverts: 1 });
  });

  it('counts flood copies on different paths once', () => {
    const packets = [
      row({ senderPubKey: KEY_A, rawHex: advertHex(KEY_A, 1_999_999_000, 'a1b2') }),
      row({ senderPubKey: KEY_A, rawHex: advertHex(KEY_A, 1_999_999_000, 'c3') }),
      row({ senderPubKey: KEY_A, rawHex: advertHex(KEY_A, 1_999_999_001) }),
    ];
    const r = computeMeshcorePacketRates(packets, nodes, { nowMs: NOW });
    expect(r.get(KEY_A)?.packets).toBe(2);
  });

  it('attributes a unique srcHash, not an ambiguous one', () => {
    const txtA = row({ payloadType: 2, srcHash: 'ab', rawHex: frame(2, 'ab11' + '22'.repeat(8)) });
    const txtB = row({ payloadType: 2, srcHash: 'cd', rawHex: frame(2, 'cd11' + '33'.repeat(8)) });
    const unique = computeMeshcorePacketRates([txtA, txtB], nodes, { nowMs: NOW });
    expect(unique.get(KEY_A)?.packets).toBe(1);
    expect(unique.get(KEY_B)?.packets).toBe(1);
    const ambiguous = computeMeshcorePacketRates([txtA, txtB], [...nodes, { publicKey: KEY_B2 }], { nowMs: NOW });
    expect(ambiguous.get(KEY_A)?.packets).toBe(1);
    expect(ambiguous.has(KEY_B)).toBe(false);
    expect(ambiguous.has(KEY_B2)).toBe(false);
  });

  it('never attributes GRP_TXT or ACK', () => {
    const packets = [
      row({ payloadType: 5, srcHash: 'ab', rawHex: frame(5, '11223344aabb') }),
      row({ payloadType: 3, srcHash: 'ab', rawHex: frame(3, '01020304') }),
    ];
    expect(computeMeshcorePacketRates(packets, nodes, { nowMs: NOW }).size).toBe(0);
  });

  it('attributes ANON_REQ by full key', () => {
    const p = row({ payloadType: 7, senderPubKey: KEY_B, srcHash: 'cd', rawHex: frame(7, 'ff' + KEY_B + 'dd'.repeat(6)) });
    const r = computeMeshcorePacketRates([p], nodes, { nowMs: NOW });
    expect(r.get(KEY_B)).toEqual({ packets: 1, adverts: 0 });
  });

  it('excludes the local key and packets outside the window', () => {
    const packets = [
      row({ senderPubKey: LOCAL, rawHex: advertHex(LOCAL, 1) }),
      row({ senderPubKey: KEY_A, rawHex: advertHex(KEY_A, 2), timestamp: NOW - HOUR - 1 }),
      row({ senderPubKey: KEY_A, rawHex: advertHex(KEY_A, 3), timestamp: NOW - HOUR }),
    ];
    const r = computeMeshcorePacketRates(packets, nodes, { nowMs: NOW, localKeys: new Set([LOCAL]) });
    expect(r.has(LOCAL)).toBe(false);
    expect(r.get(KEY_A)?.packets).toBe(1);
  });

  it('counts a row without a hash by its own identity', () => {
    const packets = [row({ senderPubKey: KEY_A }), row({ senderPubKey: KEY_A })];
    expect(computeMeshcorePacketRates(packets, nodes, { nowMs: NOW }).get(KEY_A)?.packets).toBe(2);
  });
});

describe('computeMeshcoreClockOffsets', () => {
  const nowSec = Math.floor(NOW / 1000);

  it('positive offset = node behind; threshold edge is exclusive', () => {
    const behind = row({ timestamp: NOW, rawHex: advertHex(KEY_A, nowSec - 2 * 3600) });
    const out = computeMeshcoreClockOffsets({ adverts: [behind], dms: [], nodes, nowMs: NOW });
    const o = out.get(KEY_A)!;
    expect(o.offsetMs).toBe(2 * 3600_000);
    expect(o.source).toBe('advert');
    expect(isClockOffsetFlagged(o.offsetMs)).toBe(true);
    expect(isClockOffsetFlagged(30 * 60_000)).toBe(false);
    expect(isClockOffsetFlagged(30 * 60_000 + 1)).toBe(true);
    const ahead = row({ timestamp: NOW, rawHex: advertHex(KEY_B, nowSec + 3600) });
    expect(computeMeshcoreClockOffsets({ adverts: [ahead], dms: [], nodes, nowMs: NOW }).get(KEY_B)!.offsetMs).toBe(-3600_000);
  });

  it('flags a never-set 2024 clock and a zero stamp', () => {
    const y2024 = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    const a = row({ timestamp: NOW, rawHex: advertHex(KEY_A, y2024) });
    const b = row({ timestamp: NOW, rawHex: advertHex(KEY_B, 0) });
    const out = computeMeshcoreClockOffsets({ adverts: [a, b], dms: [], nodes, nowMs: NOW });
    expect(isClockOffsetFlagged(out.get(KEY_A)!.offsetMs)).toBe(true);
    expect(out.get(KEY_A)!.offsetMs).toBeGreaterThan(365 * 86_400_000);
    expect(isClockOffsetFlagged(out.get(KEY_B)!.offsetMs)).toBe(true);
  });

  it('the newest observation wins across adverts and DMs', () => {
    const oldBad = row({ timestamp: NOW - 5000, rawHex: advertHex(KEY_A, nowSec - 7200) });
    const newGood = { fromPublicKey: KEY_A, senderTimestamp: nowSec - 1, receivedAtMs: NOW };
    const out = computeMeshcoreClockOffsets({ adverts: [oldBad], dms: [newGood], nodes, nowMs: NOW });
    expect(out.get(KEY_A)!.source).toBe('message');
    expect(isClockOffsetFlagged(out.get(KEY_A)!.offsetMs)).toBe(false);
    const newBad = row({ timestamp: NOW + 10, rawHex: advertHex(KEY_A, nowSec - 7200) });
    const out2 = computeMeshcoreClockOffsets({ adverts: [newBad], dms: [newGood], nodes, nowMs: NOW });
    expect(out2.get(KEY_A)!.source).toBe('advert');
  });

  it('resolves a DM prefix only when unique; ignores unset DM stamps', () => {
    const dm = (from: string, ts = nowSec - 7200) => ({ fromPublicKey: from, senderTimestamp: ts, receivedAtMs: NOW });
    const ok = computeMeshcoreClockOffsets({ adverts: [], dms: [dm(KEY_A.slice(0, 12))], nodes, nowMs: NOW });
    expect(ok.get(KEY_A)?.offsetMs).toBe(7200_000);
    const amb = computeMeshcoreClockOffsets({
      adverts: [],
      dms: [dm('cd')],
      nodes: [...nodes, { publicKey: KEY_B2 }],
      nowMs: NOW,
    });
    expect(amb.size).toBe(0);
    expect(computeMeshcoreClockOffsets({ adverts: [], dms: [dm(KEY_A, 0)], nodes, nowMs: NOW }).size).toBe(0);
  });

  it('skips the local key and undecodable adverts', () => {
    const local = row({ timestamp: NOW, rawHex: advertHex(LOCAL, 5) });
    const junk = row({ timestamp: NOW, rawHex: 'zz' });
    const out = computeMeshcoreClockOffsets({
      adverts: [local, junk],
      dms: [],
      nodes,
      nowMs: NOW,
      localKeys: new Set([LOCAL]),
    });
    expect(out.size).toBe(0);
  });
});
