/**
 * MeshCoreManager neighbour paging (#5413): the manual fetch reads the whole
 * table (up to 5 pages, one per 60 s floor, one login) and stores it ONCE;
 * the automated poll reads one page strongest-first and merges; a failed or
 * partial fetch never wipes a fuller stored set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockLoad = vi.fn();
vi.mock('./services/meshcoreCredentialStore.js', () => ({
  getMeshCoreCredentialStore: () => ({ load: mockLoad }),
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';

const KEY = 'a'.repeat(64);
const FLOOR = 60_000;

/** Prefix for entry i, and the full key the fake contact list resolves it to. */
const prefixOf = (i: number) => i.toString(16).padStart(16, '0');
const fullKeyOf = (prefix: string) => prefix.padEnd(64, 'f');

interface BridgeCall { offset: number; count: number; order_by: number }

function makeManager(tableSize: number, opts: { failCall?: number } = {}) {
  const m = new MeshCoreManager('test-source') as any;
  m.deviceType = MeshCoreDeviceType.COMPANION;
  m.connected = true;
  m.localNode = { publicKey: 'local', name: 'local', advType: MeshCoreDeviceType.COMPANION };
  const logins: string[] = [];
  m.loginToNodeWithOutcome = vi.fn(async (pk: string) => {
    logins.push(pk);
    return { result: {}, outcome: 'ok' };
  });
  const calls: BridgeCall[] = [];
  m.sendBridgeCommand = vi.fn(async (cmd: string, params: any) => {
    if (cmd !== 'get_neighbours') return { id: '1', success: false, error: 'unexpected' };
    calls.push({ offset: params.offset, count: params.count, order_by: params.order_by });
    if (opts.failCall === calls.length) return { id: '1', success: false, error: 'timeout' };
    const rows = Array.from({ length: tableSize }, (_, i) => ({
      public_key_prefix: prefixOf(i),
      heard_seconds_ago: i,
      snr: 5,
    }));
    return { id: '1', success: true, data: { total: tableSize, neighbours: rows.slice(params.offset, params.offset + 10) } };
  });
  m.resolveContactByPrefix = (prefix: string) => ({ publicKey: fullKeyOf(prefix), advName: `n-${prefix}` });
  return { m, calls, logins };
}

describe('MeshCoreManager neighbour paging (#5413)', () => {
  let insertSpy: ReturnType<typeof vi.spyOn>;
  let storedSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
    mockLoad.mockReset().mockResolvedValue({ kind: 'ok', password: 'guest' });
    insertSpy = vi.spyOn(databaseService.meshcore, 'insertNeighborsBatch').mockResolvedValue(undefined);
    storedSpy = vi.spyOn(databaseService.meshcore, 'getNeighborsForReporter').mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('manual: 10 entries a reply, total 37 → 4 pages 60 s apart, one login, stored once in full', async () => {
    const { m, calls, logins } = makeManager(37);
    const t0 = Date.now();
    const p = m.fetchAndStoreNeighbours(KEY, { mode: 'manual' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(FLOOR - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * FLOOR);
    const summary = await p;

    expect(calls).toEqual([
      { offset: 0, count: 10, order_by: 0 },
      { offset: 10, count: 10, order_by: 0 },
      { offset: 20, count: 10, order_by: 0 },
      { offset: 30, count: 10, order_by: 0 },
    ]);
    expect(logins).toEqual([KEY]);
    expect(summary).toMatchObject({ outcome: 'complete', total: 37, pagesFetched: 4, written: 37, stored: 'replaced' });
    expect(summary.neighbours[0]).toMatchObject({ name: `n-${prefixOf(0)}`, fullPublicKey: fullKeyOf(prefixOf(0)) });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy.mock.calls[0][2]).toHaveLength(37);
    // A complete read replaces: no need to read the stored set.
    expect(storedSpy).not.toHaveBeenCalled();
    // The shared floor now reflects the last page, sent 3 floors after the first.
    expect(m.getLastMeshTxAt()).toBe(t0 + 3 * FLOOR);
  });

  it('automated (scheduler): one page, order_by 2, no wait after the caller stamped, merged into the stored set', async () => {
    const { m, calls } = makeManager(37);
    storedSpy.mockResolvedValue([
      { neighborPublicKey: 'e'.repeat(64), snr: 2, lastHeardSecs: 100, timestamp: Date.now() - 60_000 },
    ]);
    m.recordMeshTx(Date.now()); // the scheduler stamps before it calls
    const result = await m.pollNeighborsAndStore(KEY);

    expect(calls).toEqual([{ offset: 0, count: 10, order_by: 2 }]);
    expect(result).toEqual({ total: 37, written: 10 });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const rows = insertSpy.mock.calls[0][2] as Array<{ neighborPublicKey: string; lastHeardSecs: number }>;
    expect(rows).toHaveLength(11); // 10 fresh + the stored one it did not see
    expect(rows[10]).toMatchObject({ neighborPublicKey: 'e'.repeat(64), lastHeardSecs: 160 });
  });

  it('automated: a failed single page returns null and stores nothing', async () => {
    const { m } = makeManager(37, { failCall: 1 });
    m.recordMeshTx(Date.now());
    expect(await m.pollNeighborsAndStore(KEY)).toBeNull();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('a page failure part-way merges what arrived and keeps the stored set', async () => {
    const { m, calls } = makeManager(37, { failCall: 3 });
    const stored = Array.from({ length: 30 }, (_, i) => ({
      neighborPublicKey: `s${i}`.padEnd(64, '0'),
      snr: 1,
      lastHeardSecs: 50 + i,
      timestamp: Date.now(),
    }));
    storedSpy.mockResolvedValue(stored);
    const p = m.fetchAndStoreNeighbours(KEY, { mode: 'manual' });
    await vi.advanceTimersByTimeAsync(5 * FLOOR);
    const summary = await p;

    expect(calls).toHaveLength(3);
    expect(summary).toMatchObject({ outcome: 'failed', pagesFetched: 2, total: 37, written: 20, stored: 'merged' });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    // 20 fresh + 17 carried (the table holds 37), never fewer than before.
    expect(insertSpy.mock.calls[0][2]).toHaveLength(37);
  });

  it('a failure before any page leaves the stored set untouched', async () => {
    const { m } = makeManager(37, { failCall: 1 });
    const summary = await m.fetchAndStoreNeighbours(KEY, { mode: 'manual' });
    expect(summary).toMatchObject({ outcome: 'failed', pagesFetched: 0, stored: 'none' });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('cancel stops further pages; what arrived is merged, not replacing', async () => {
    const { m, calls } = makeManager(37);
    const ctrl = new AbortController();
    const p = m.fetchAndStoreNeighbours(KEY, { mode: 'manual', signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(FLOOR + 5_000); // pages 1 and 2 in
    ctrl.abort();
    const summary = await p;
    await vi.advanceTimersByTimeAsync(5 * FLOOR);

    expect(calls).toHaveLength(2);
    expect(summary).toMatchObject({ outcome: 'cancelled', pagesFetched: 2, stored: 'merged' });
    expect(summary.neighbours).toHaveLength(20);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('streams resolved neighbours to onProgress as each page lands', async () => {
    const { m } = makeManager(15);
    const seen: number[] = [];
    const p = m.fetchAndStoreNeighbours(KEY, {
      mode: 'manual',
      onProgress: (e: any) => {
        if (e.phase === 'page') {
          seen.push(e.neighbours.length);
          expect(e.neighbours[0].name).toBe(`n-${prefixOf(0)}`);
        }
      },
    });
    await vi.advanceTimersByTimeAsync(2 * FLOOR);
    await p;
    expect(seen).toEqual([10, 15]);
  });
});
