import { describe, it, expect } from 'vitest';
import { buildMeshCoreTraceRun, UNRESOLVED_HOP_NUM, NO_SNR_Q } from './meshcoreTraceRun.js';
import { nodeNumFromPubkey } from './meshcoreNodeNum.js';
import type { MeshCoreHopSnrRow } from '../db/repositories/meshcoreHopSnr.js';

const L = 'aa'.repeat(32);
const R1 = '11'.repeat(32);
const R2 = '22'.repeat(32);
const T = '77'.repeat(32);
const COMP = 'cc'.repeat(32);

type Hop = { pk: string | null; hash: string; cand?: number; snr: number };

/** Hop rows for a loop local -> hops -> local; `back` is the final row's SNR. */
function rows(hops: Hop[], back: number | null, over: Partial<MeshCoreHopSnrRow> = {}): MeshCoreHopSnrRow[] {
  const n = hops.length;
  const base = { sourceId: 's1', traceTag: 99, authCode: 5, hopCount: n + 1, hashBytes: 1, initiated: true, timestamp: 5000, ...over };
  const out: MeshCoreHopSnrRow[] = hops.map((h, i) => ({
    ...base, hopIndex: i,
    senderPublicKey: i === 0 ? L : hops[i - 1].pk, senderHash: i === 0 ? null : hops[i - 1].hash,
    senderCandidates: 1,
    receiverPublicKey: h.pk, receiverHash: h.hash, receiverCandidates: h.cand ?? (h.pk ? 1 : 0),
    snrQuarterDb: h.snr,
  }));
  if (back !== null) {
    out.push({
      ...base, hopIndex: n,
      senderPublicKey: hops[n - 1].pk, senderHash: hops[n - 1].hash, senderCandidates: 1,
      receiverPublicKey: L, receiverHash: null, receiverCandidates: 1, snrQuarterDb: back,
    });
  }
  return out;
}
const h = (pk: string | null, hash: string, snr: number, cand?: number): Hop => ({ pk, hash, snr, cand });
const num = nodeNumFromPubkey;

describe('buildMeshCoreTraceRun', () => {
  it('returns null for no rows', () => {
    expect(buildMeshCoreTraceRun([], { localPublicKey: L })).toBeNull();
  });

  it('repeater round trip splits at the middle hop (T)', () => {
    const r = buildMeshCoreTraceRun(
      rows([h(R1, '11', 20), h(T, '77', 12), h(R1, '11', 8)], -4), { localPublicKey: L, targetPublicKey: T })!;
    expect(r.fromKey).toBe(`mc:${L}`);
    expect(r.toKey).toBe(`mc:${T}`);
    expect(r.turnaroundKey).toBe(`mc:${T}`);
    expect(r.reachedTarget).toBe(true);
    expect(r.forwardKeys).toEqual([`mc:${L}`, `mc:${R1}`, `mc:${T}`]);
    expect(r.forwardSnrQ).toEqual([20, 12]);
    expect(r.backKeys).toEqual([`mc:${T}`, `mc:${R1}`, `mc:${L}`]);
    expect(r.backSnrQ).toEqual([8, -4]);
    expect(r.initiated).toBe(true);
  });

  it('splits at the palindrome middle when the target is not known', () => {
    const r = buildMeshCoreTraceRun(rows([h(R1, '11', 20), h(T, '77', 12), h(R1, '11', 8)], -4), { localPublicKey: L })!;
    expect(r.toKey).toBe(`mc:${T}`);
    expect(r.reachedTarget).toBe(true);
  });

  it('companion round trip turns at the last repeater; target is not on the wire', () => {
    const r = buildMeshCoreTraceRun(
      rows([h(R1, '11', 20), h(R2, '22', 12), h(R1, '11', 8)], -4), { localPublicKey: L, targetPublicKey: COMP })!;
    expect(r.turnaroundKey).toBe(`mc:${R2}`);
    expect(r.toKey).toBe(`mc:${COMP}`);
    expect(r.reachedTarget).toBe(false);
    expect(r.forwardKeys).toEqual([`mc:${L}`, `mc:${R1}`, `mc:${R2}`]);
    expect(r.backKeys).toEqual([`mc:${R2}`, `mc:${R1}`, `mc:${L}`]);
    // Meshtastic shape: the turnaround is a middle node, the link to the target has no SNR.
    expect(JSON.parse(r.route)).toEqual([num(R1), num(R2)]);
    expect(JSON.parse(r.snrTowards)).toEqual([20, 12, NO_SNR_Q]);
    expect(JSON.parse(r.routeBack!)).toEqual([num(R2), num(R1)]);
    expect(JSON.parse(r.snrBack!)).toEqual([NO_SNR_Q, 8, -4]);
  });

  it('direct trace [T]', () => {
    const r = buildMeshCoreTraceRun(rows([h(T, '77', 15)], -3), { localPublicKey: L, targetPublicKey: T })!;
    expect(r.forwardKeys).toEqual([`mc:${L}`, `mc:${T}`]);
    expect(r.backKeys).toEqual([`mc:${T}`, `mc:${L}`]);
    expect(r.toKey).toBe(`mc:${T}`);
    expect(JSON.parse(r.route)).toEqual([]);
    expect(JSON.parse(r.routeBack!)).toEqual([]);
    expect(JSON.parse(r.snrTowards)).toEqual([15]);
    expect(JSON.parse(r.snrBack!)).toEqual([-3]);
  });

  it('one-way (non-palindrome) path is all outbound; last row is the return link', () => {
    const r = buildMeshCoreTraceRun(rows([h(R1, '11', 20), h(R2, '22', 12)], -4), { localPublicKey: L })!;
    expect(r.turnaroundKey).toBe(`mc:${R2}`);
    expect(r.forwardKeys).toEqual([`mc:${L}`, `mc:${R1}`, `mc:${R2}`]);
    expect(r.forwardSnrQ).toEqual([20, 12]);
    expect(r.backKeys).toEqual([`mc:${R2}`, `mc:${L}`]);
    expect(r.backSnrQ).toEqual([-4]);
  });

  it('back is null when the return link was not recorded', () => {
    const r = buildMeshCoreTraceRun(rows([h(R1, '11', 20), h(R2, '22', 12)], null), { localPublicKey: L })!;
    expect(r.backKeys).toBeNull();
    expect(r.routeBack).toBeNull();
    expect(r.snrBack).toBeNull();
  });

  it('unresolved and ambiguous hashes become mch: keys and keep candidate counts', () => {
    const r = buildMeshCoreTraceRun(rows([h(null, 'a3', 20, 0), h(null, 'b4', 12, 3)], -4), { localPublicKey: L })!;
    expect(r.forwardKeys).toEqual([`mc:${L}`, 'mch:a3', 'mch:b4']);
    expect(r.hops).toEqual([
      { key: 'mch:a3', hash: 'a3', candidates: 0 },
      { key: 'mch:b4', hash: 'b4', candidates: 3 },
    ]);
    expect(JSON.parse(r.route)).toEqual([UNRESOLVED_HOP_NUM]);
    expect(r.toNodeNum).toBe(UNRESOLVED_HOP_NUM);
  });

  it('local key unknown falls back to src:<sourceId>', () => {
    const r = buildMeshCoreTraceRun(rows([h(R1, '11', 20)], -4, { initiated: true }).map((x) => ({ ...x, senderPublicKey: x.hopIndex === 0 ? null : x.senderPublicKey, receiverPublicKey: x.hopIndex === 1 ? null : x.receiverPublicKey })), { localPublicKey: null })!;
    expect(r.fromKey).toBe('src:s1');
    expect(r.fromNodeNum).toBe(UNRESOLVED_HOP_NUM);
    expect(r.backKeys![r.backKeys!.length - 1]).toBe('src:s1');
  });

  it('synthetic route uses real synthetic numbers for resolved hops', () => {
    const r = buildMeshCoreTraceRun(rows([h(R1, '11', 20), h(T, '77', 12), h(R1, '11', 8)], -4), { localPublicKey: L })!;
    expect(r.fromNodeNum).toBe(num(L));
    expect(r.toNodeNum).toBe(num(T));
    expect(JSON.parse(r.route)).toEqual([num(R1)]);
    expect(JSON.parse(r.routeBack!)).toEqual([num(R1)]);
  });

  it('carries tag, auth, timestamp, hash width', () => {
    const r = buildMeshCoreTraceRun(rows([h(T, '7777', 1)], 1, { hashBytes: 2 }), { localPublicKey: L })!;
    expect(r).toMatchObject({ traceTag: 99, authCode: 5, timestamp: 5000, hashBytes: 2, sourceId: 's1' });
  });
});
