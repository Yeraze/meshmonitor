/**
 * Integration TCP tests for the ATAK/CoT Phase 3 feed server (issue #3691).
 * Uses a real `net.connect` against an in-process server bound to an
 * ephemeral port — modeled on the "real socket, no framework mocking" style
 * used for other in-process TCP servers in this codebase. See
 * docs/internal/dev-notes/ATAK_COT_PHASE3_SPEC.md §5c.
 *
 * `databaseService`/`sourceManagerRegistry` are mocked so the snapshot is
 * built from deterministic seeded rows instead of touching a real DB.
 * `cotFeedService.configureForTest()` shortens the resend interval and
 * lowers the client cap so this suite doesn't need a real 30s wait or 16
 * real sockets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connect, type Socket } from 'net';
import { logger } from '../../utils/logger.js';
import type { AtakContactRow } from '../../db/repositories/atakContacts.js';

// vi.mock factories are hoisted above these module-level consts, so the seed
// data must be built inside vi.hoisted() to be visible at mock-factory time.
const { SEED_NODE, SEED_CONTACT } = vi.hoisted(() => {
  const now = Date.now();
  return {
    SEED_NODE: {
      nodeNum: 0xaabbccdd,
      nodeId: '!aabbccdd',
      sourceId: 'source-a',
      longName: 'Alpha Node',
      shortName: 'ALFA',
      hwModel: 43,
      latitude: 38.8895,
      longitude: -77.0353,
      altitude: 12,
      batteryLevel: 77,
      lastHeard: Math.floor(now / 1000) - 60,
      positionOverrideEnabled: false,
      positionOverrideIsPrivate: false,
      createdAt: now,
      updatedAt: now,
    },
    SEED_CONTACT: {
      uid: 'EUD-ALPHA-1',
      sourceId: 'source-a',
      nodeNum: 0xaabbccdd,
      callsign: 'ALPHA-1',
      deviceCallsign: 'EUD-ALPHA-1',
      team: 9,
      role: 1,
      battery: 85,
      latitude: 38.9,
      longitude: -77.04,
      altitude: 10,
      speed: 1,
      course: 90,
      lastSeen: now,
      createdAt: now,
    } satisfies AtakContactRow,
  };
});

vi.mock('../../services/database.js', () => {
  const shared = {
    settings: { getSetting: vi.fn().mockResolvedValue(null) },
    atakContacts: { getContacts: vi.fn().mockResolvedValue([SEED_CONTACT]) },
    nodes: { getAllNodes: vi.fn().mockResolvedValue([SEED_NODE]) },
  };
  return { default: shared };
});

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getAllManagers: vi.fn().mockReturnValue([]) },
}));

import { cotFeedService } from './cotFeedService.js';

/** Connects a client and resolves once it's connected. */
function connectClient(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Collects data on a socket until `predicate(buffer)` is true or the timeout elapses. */
function collectUntil(socket: Socket, predicate: (data: string) => boolean, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      socket.off('data', onData);
      reject(new Error(`Timed out waiting for data matching predicate. Buffer so far: ${buffer}`));
    }, timeoutMs);

    function onData(chunk: Buffer) {
      buffer += chunk.toString('utf8');
      if (predicate(buffer)) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve(buffer);
      }
    }

    socket.on('data', onData);
  });
}

async function startServer(overrides?: { resendIntervalMs?: number; maxClients?: number }): Promise<number> {
  cotFeedService.configureForTest({ resendIntervalMs: 200, maxClients: 16, ...overrides });
  await cotFeedService.restart({ enabled: true, port: 0 });
  const status = cotFeedService.getStatus();
  expect(status.listening).toBe(true);
  return status.port;
}

describe('CotFeedService integration (real TCP)', () => {
  const openSockets: Socket[] = [];

  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const s of openSockets.splice(0)) {
      s.destroy();
    }
    await cotFeedService.stop();
    cotFeedService.configureForTest({ resendIntervalMs: 30_000, maxClients: 16 }); // restore defaults
    vi.restoreAllMocks();
  });

  it('sends a snapshot on connect containing the seeded node and contact uids', async () => {
    const port = await startServer();
    const socket = await connectClient(port);
    openSockets.push(socket);

    const data = await collectUntil(socket, (buf) => buf.includes('</event>'));
    expect(data).toContain('uid="MESHMON-source-a-!aabbccdd"');
    expect(data).toContain('uid="EUD-ALPHA-1"');
    expect(data).toContain('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  });

  it('ignores inbound garbage and keeps serving periodic snapshots', async () => {
    const port = await startServer({ resendIntervalMs: 150 });
    const socket = await connectClient(port);
    openSockets.push(socket);

    // Drain the snapshot-on-connect.
    await collectUntil(socket, (buf) => buf.includes('</event>'));

    // Send garbage inbound — the server must discard it (RX-only) without
    // erroring or closing the connection.
    let errored = false;
    socket.once('error', () => { errored = true; });
    socket.write('not xml at all <<>> \x00\x01\x02 garbage');

    // Wait for the next periodic snapshot to prove the connection survived.
    const next = await collectUntil(socket, (buf) => buf.includes('</event>'), 3000);
    expect(next).toContain('MESHMON-source-a-!aabbccdd');
    expect(errored).toBe(false);
    expect(socket.destroyed).toBe(false);
  });

  it('serves multiple clients independently', async () => {
    const port = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port);
    openSockets.push(a, b);

    const [dataA, dataB] = await Promise.all([
      collectUntil(a, (buf) => buf.includes('</event>')),
      collectUntil(b, (buf) => buf.includes('</event>')),
    ]);

    expect(dataA).toContain('EUD-ALPHA-1');
    expect(dataB).toContain('EUD-ALPHA-1');
    expect(cotFeedService.getStatus().clientCount).toBe(2);
  });

  it('enforces the max-client cap by destroying excess connections', async () => {
    const port = await startServer({ maxClients: 1 });

    const first = await connectClient(port);
    openSockets.push(first);
    await collectUntil(first, (buf) => buf.includes('</event>'));
    expect(cotFeedService.getStatus().clientCount).toBe(1);

    const second = await connectClient(port);
    openSockets.push(second);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('second client was not closed')), 2000);
      second.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    expect(cotFeedService.getStatus().clientCount).toBe(1);
  });

  it('continues serving other clients when one disconnects mid-stream (E2/E10)', async () => {
    const port = await startServer({ resendIntervalMs: 150 });
    const a = await connectClient(port);
    const b = await connectClient(port);
    openSockets.push(a, b);

    await Promise.all([
      collectUntil(a, (buf) => buf.includes('</event>')),
      collectUntil(b, (buf) => buf.includes('</event>')),
    ]);
    expect(cotFeedService.getStatus().clientCount).toBe(2);

    a.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cotFeedService.getStatus().clientCount).toBe(1);

    // b must keep receiving snapshots after a's disconnect.
    const more = await collectUntil(b, (buf) => buf.includes('</event>'), 3000);
    expect(more).toContain('EUD-ALPHA-1');
  });
});
