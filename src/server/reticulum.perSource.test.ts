/**
 * Manager-level per-source isolation test for ReticulumManager
 * (#3960 Phase 1a WP4, build spec §5).
 *
 * Two independent ReticulumManager instances (different sourceIds) must
 * never cross-write each other's data — an announce/interface_stats event
 * handled by manager A's private handlers must only ever persist with
 * sourceId 'src-a', never 'src-b', and vice versa. This is the manager-level
 * analogue of `src/db/repositories/reticulum.perSource.test.ts` (WP1, which
 * covers the repository layer); this suite covers the manager's event
 * handlers and, critically, its per-instance interface-history throttle
 * state (`lastInterfaceSample`) — two managers observing the SAME interface
 * name must keep independent throttle baselines, not share one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AnnounceMessage, InterfaceStatsEntry, InterfaceStatsMessage } from './reticulumProtocol.js';

const upsertDestination = vi.fn().mockResolvedValue(undefined);
const upsertInterface = vi.fn().mockResolvedValue(undefined);
const insertTelemetryBatch = vi.fn().mockResolvedValue(0);

vi.mock('../services/database.js', () => ({
  default: {
    reticulum: {
      upsertDestination: (...args: unknown[]) => upsertDestination(...args),
      upsertInterface: (...args: unknown[]) => upsertInterface(...args),
    },
    telemetry: {
      insertTelemetryBatch: (...args: unknown[]) => insertTelemetryBatch(...args),
    },
  },
}));

import { ReticulumManager } from './reticulumManager.js';

function announce(destinationHash: string): AnnounceMessage {
  return {
    v: 1,
    type: 'announce',
    ts: 1_700_000_000_000,
    destinationHash,
    identityHash: null,
    appName: 'lxmf',
    aspects: ['delivery'],
    displayName: null,
    appDataB64: null,
    hops: null,
    nextHopInterface: null,
    rssi: null,
    snr: null,
    q: null,
    isPathResponse: null,
  };
}

function ifaceStats(name: string, txBytes: number, rxBytes: number, ts: number): InterfaceStatsMessage {
  const entry: InterfaceStatsEntry = { name, type: 'TCPClientInterface', status: 'up', online: true, txBytes, rxBytes };
  return { v: 1, type: 'interface_stats', ts, interfaces: [entry] };
}

describe('ReticulumManager per-source isolation', () => {
  beforeEach(() => {
    upsertDestination.mockClear();
    upsertInterface.mockClear();
    insertTelemetryBatch.mockClear();
  });

  it('announce on manager A never writes sourceId B, and vice versa', async () => {
    const a = new ReticulumManager('src-a');
    const b = new ReticulumManager('src-b');

    // @ts-expect-error - exercising the private handler directly
    await a.handleAnnounce(announce('hash-a'));
    // @ts-expect-error - exercising the private handler directly
    await b.handleAnnounce(announce('hash-b'));

    expect(upsertDestination).toHaveBeenCalledTimes(2);
    const callFor = (hash: string) =>
      upsertDestination.mock.calls.find(([, dest]) => (dest as { destinationHash: string }).destinationHash === hash);
    expect(callFor('hash-a')?.[0]).toBe('src-a');
    expect(callFor('hash-b')?.[0]).toBe('src-b');
  });

  it('interface_stats + telemetry history for the SAME interface name on two managers never cross sourceIds', async () => {
    const a = new ReticulumManager('src-a');
    const b = new ReticulumManager('src-b');

    // Same interface name on both managers is plausible (both bridges expose
    // e.g. "TCP Client") — the throttle baseline must stay per-manager.
    // @ts-expect-error - exercising the private handler directly
    await a.handleInterfaceStats(ifaceStats('TCP Client', 100, 50, 1_700_000_000_000));
    // @ts-expect-error - exercising the private handler directly
    await b.handleInterfaceStats(ifaceStats('TCP Client', 200, 90, 1_700_000_000_000));

    expect(upsertInterface).toHaveBeenCalledTimes(2);
    expect(upsertInterface.mock.calls[0][0]).toBe('src-a');
    expect(upsertInterface.mock.calls[1][0]).toBe('src-b');
    // Neither manager's FIRST poll has a baseline to diff against yet.
    expect(insertTelemetryBatch).not.toHaveBeenCalled();

    // Second poll for each, with a DIFFERENT delta per manager, so a shared
    // (buggy) baseline would produce mismatched/incorrect values.
    // @ts-expect-error - exercising the private handler directly
    await a.handleInterfaceStats(ifaceStats('TCP Client', 1100, 550, 1_700_000_010_000)); // +1000/+500 over 10s
    // @ts-expect-error - exercising the private handler directly
    await b.handleInterfaceStats(ifaceStats('TCP Client', 2200, 990, 1_700_000_010_000)); // +2000/+900 over 10s

    expect(insertTelemetryBatch).toHaveBeenCalledTimes(2);
    const [rowsA, sourceIdA] = insertTelemetryBatch.mock.calls[0];
    const [rowsB, sourceIdB] = insertTelemetryBatch.mock.calls[1];
    expect(sourceIdA).toBe('src-a');
    expect(sourceIdB).toBe('src-b');

    const txValueA = (rowsA as Array<{ telemetryType: string; value: number }>).find(
      (r) => r.telemetryType === 'reticulum_iface_tx_rate',
    )?.value;
    const txValueB = (rowsB as Array<{ telemetryType: string; value: number }>).find(
      (r) => r.telemetryType === 'reticulum_iface_rx_rate',
    )?.value;
    // A's tx delta (1000 over 10s = 100 B/s) must not be contaminated by B's
    // counters (2000 over 10s = 200 B/s) or vice versa — proves the two
    // managers kept independent `lastInterfaceSample` baselines despite
    // sharing an interface name.
    expect(txValueA).toBe(100);
    expect(txValueB).toBe(90);
  });
});
