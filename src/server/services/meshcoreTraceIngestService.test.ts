/**
 * MeshCore TRACE ingest (#5722): hop rows, hash resolution, dedup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/database.js', () => ({ default: {} }));

import {
  MeshCoreTraceIngestService,
  TRACE_DEDUP_WINDOW_MS,
  resolvePathHash,
  traceToHopRows,
  type TraceDataEvent,
  type TraceIngestDeps,
} from './meshcoreTraceIngestService.js';
import type { MeshCoreHopSnrRow } from '../../db/repositories/meshcoreHopSnr.js';

const key = (prefix: string) => prefix.padEnd(64, '0');
const LOCAL = key('aa11');
const REP_A = key('b1c2');
const REP_B = key('c3d4');
const REP_B2 = key('c3ff'); // shares REP_B's 1-byte hash

const trace = (over: Partial<TraceDataEvent> = {}): TraceDataEvent => ({
  tag: 0xdeadbeef,
  auth_code: 0,
  flags: 0,
  hash_bytes: 1,
  path_hashes_hex: 'b1c3',
  path_snrs_q: [34, -22],
  last_snr_q: 12,
  initiated: false,
  ...over,
});

describe('resolvePathHash (#5722)', () => {
  it('resolves a unique prefix, reports unknown and ambiguous without guessing', () => {
    expect(resolvePathHash('b1', [REP_A, REP_B])).toEqual({ publicKey: REP_A, candidates: 1 });
    expect(resolvePathHash('ee', [REP_A, REP_B])).toEqual({ publicKey: null, candidates: 0 });
    expect(resolvePathHash('c3', [REP_A, REP_B, REP_B2])).toEqual({ publicKey: null, candidates: 2 });
    // A 2-byte hash separates what a 1-byte hash could not.
    expect(resolvePathHash('C3D4', [REP_A, REP_B, REP_B2])).toEqual({ publicKey: REP_B, candidates: 1 });
  });
});

describe('traceToHopRows (#5722)', () => {
  it('overheard trace: receiver-heard-sender rows, originator unknown, final hop is our radio', () => {
    const rows = traceToHopRows('s', trace(), [REP_A, REP_B, LOCAL], LOCAL, 1000);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      hopIndex: 0, hopCount: 3, hashBytes: 1, initiated: false, timestamp: 1000,
      senderPublicKey: null, senderHash: null, senderCandidates: 0,
      receiverPublicKey: REP_A, receiverHash: 'b1', receiverCandidates: 1,
      snrQuarterDb: 34,
    });
    expect(rows[1]).toMatchObject({
      hopIndex: 1, senderPublicKey: REP_A, senderHash: 'b1',
      receiverPublicKey: REP_B, receiverHash: 'c3', snrQuarterDb: -22,
    });
    expect(rows[2]).toMatchObject({
      hopIndex: 2, senderPublicKey: REP_B, senderHash: 'c3',
      receiverPublicKey: LOCAL, receiverHash: null, receiverCandidates: 1, snrQuarterDb: 12,
    });
    expect(rows.every((r) => r.traceTag === 0xdeadbeef && r.sourceId === 's')).toBe(true);
  });

  it('our own trace: the first hop heard US', () => {
    const rows = traceToHopRows('s', trace({ initiated: true }), [REP_A, REP_B, LOCAL], LOCAL, 1);
    expect(rows[0]).toMatchObject({ senderPublicKey: LOCAL, senderCandidates: 1, receiverPublicKey: REP_A, initiated: true });
  });

  it('2-byte hashes split on the right boundary', () => {
    const rows = traceToHopRows('s', trace({ hash_bytes: 2, path_hashes_hex: 'b1c2c3d4' }), [REP_A, REP_B, REP_B2], LOCAL, 1);
    expect(rows.map((r) => r.receiverHash)).toEqual(['b1c2', 'c3d4', null]);
    expect(rows[1].receiverPublicKey).toBe(REP_B);
  });

  it('stores an ambiguous hop with its candidate count and no key', () => {
    const rows = traceToHopRows('s', trace(), [REP_A, REP_B, REP_B2], LOCAL, 1);
    expect(rows[1]).toMatchObject({ receiverPublicKey: null, receiverHash: 'c3', receiverCandidates: 2 });
    expect(rows[2]).toMatchObject({ senderPublicKey: null, senderHash: 'c3', senderCandidates: 2 });
  });

  it('rejects malformed pushes instead of storing nonsense', () => {
    expect(traceToHopRows('s', trace({ path_snrs_q: [1] }), [], LOCAL, 1)).toEqual([]); // SNR count ≠ hop count
    expect(traceToHopRows('s', trace({ path_hashes_hex: '' }), [], LOCAL, 1)).toEqual([]);
    expect(traceToHopRows('s', trace({ hash_bytes: 2, path_hashes_hex: 'b1c2c3' }), [], LOCAL, 1)).toEqual([]);
    expect(traceToHopRows('s', trace({ hash_bytes: 3 }), [], LOCAL, 1)).toEqual([]);
    expect(traceToHopRows('s', trace({ hash_bytes: 8, path_hashes_hex: 'b1c2c3d4e5f60718' }), [], LOCAL, 1)).toEqual([]);
    // A 4-byte hash is stored whole (8 hex chars, the column's width).
    expect(traceToHopRows('s', trace({ hash_bytes: 4, path_hashes_hex: 'b1c2c3d4', path_snrs_q: [1] }), [], LOCAL, 1)[0].receiverHash).toBe('b1c2c3d4');
    expect(traceToHopRows('s', trace({ path_snrs_q: [300, 1] }), [], LOCAL, 1)).toEqual([]);
  });

  it('works with no local key: the final receiver is unknown', () => {
    const rows = traceToHopRows('s', trace(), [REP_A], null, 1);
    expect(rows[2]).toMatchObject({ receiverPublicKey: null, receiverCandidates: 0 });
  });
});

describe('MeshCoreTraceIngestService (#5722)', () => {
  let now: number;
  let stored: Map<string, MeshCoreHopSnrRow[]>;
  let deps: TraceIngestDeps;
  let svc: MeshCoreTraceIngestService;

  beforeEach(() => {
    now = 1_000_000;
    stored = new Map();
    deps = {
      listContactKeys: async () => [REP_A, REP_B],
      hasTrace: async (sourceId, tag, auth, sinceMs) =>
        (stored.get(sourceId) ?? []).some((r) => r.traceTag === tag && r.authCode === auth && r.timestamp >= sinceMs),
      insertHops: async (sourceId, rows) => { stored.set(sourceId, [...(stored.get(sourceId) ?? []), ...rows]); },
      deleteOlderThan: vi.fn(async () => undefined),
      now: () => now,
    };
    svc = new MeshCoreTraceIngestService(deps);
  });

  it('stores one row per hop plus the final hop', async () => {
    expect(await svc.ingest('s1', trace(), LOCAL)).toBe(3);
    expect(stored.get('s1')).toHaveLength(3);
  });

  it('the same (tag, auth) within the window is one trace; after it, a new one', async () => {
    await svc.ingest('s1', trace(), LOCAL);
    expect(await svc.ingest('s1', trace(), LOCAL)).toBe(0);
    now += TRACE_DEDUP_WINDOW_MS + 1;
    expect(await svc.ingest('s1', trace(), LOCAL)).toBe(3);
    // A different auth code is a different trace.
    expect(await svc.ingest('s1', trace({ auth_code: 7 }), LOCAL)).toBe(3);
  });

  it('two pushes of one trace at the same instant store once', async () => {
    const results = await Promise.all([svc.ingest('s1', trace(), LOCAL), svc.ingest('s1', trace(), LOCAL)]);
    expect(results.sort()).toEqual([0, 3]);
  });

  it('dedup survives a restart: a new service still sees the stored trace', async () => {
    await svc.ingest('s1', trace(), LOCAL);
    const restarted = new MeshCoreTraceIngestService(deps);
    expect(await restarted.ingest('s1', trace(), LOCAL)).toBe(0);
  });

  it('each source keeps its own reception of the same trace', async () => {
    await svc.ingest('s1', trace(), LOCAL);
    expect(await svc.ingest('s2', trace(), key('dd22'))).toBe(3);
    expect(stored.get('s2')?.[2].receiverPublicKey).toBe(key('dd22'));
  });

  it('keeps the initiated flag and never throws on bad input', async () => {
    await svc.ingest('s1', trace({ initiated: true }), LOCAL);
    expect(stored.get('s1')?.every((r) => r.initiated)).toBe(true);
    expect(await svc.ingest('s1', null as never, LOCAL)).toBe(0);
    expect(await svc.ingest('', trace({ tag: 2 }), LOCAL)).toBe(0);
    deps.insertHops = async () => { throw new Error('db down'); };
    expect(await svc.ingest('s1', trace({ tag: 3 }), LOCAL)).toBe(0);
  });
});
