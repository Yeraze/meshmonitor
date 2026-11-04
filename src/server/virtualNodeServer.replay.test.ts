/**
 * Tests for issue #6160 — Virtual Node replays missed text messages when a
 * phone app reconnects. After the config handshake the VN re-sends the stored
 * text messages since the app's last sign of life; the app's own packet-id
 * dedup absorbs the 10-minute overlap. Opt-in (off by default).
 *
 * Confirmed limits: 50 ms pacing, 2000 newest per connection, 24 h first
 * connect, 10 min overlap margin, 3 s settle delay.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Module mocks — set up BEFORE the import of virtualNodeServer.js
// ────────────────────────────────────────────────────────────────────────────

// Hoisted so the vi.mock factory (itself hoisted above the module body) can
// reference them, while the test body can still inspect/mutate them.
const { dbMock, settingsStore } = vi.hoisted(() => {
  const settingsStore: Record<string, string | null> = {};
  const dbMock = {
    nodes: {
      getNode: vi.fn(),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      setNodeFavorite: vi.fn().mockResolvedValue(undefined),
    },
    messages: {
      getMessagesAfterTimestamp: vi.fn().mockResolvedValue([]),
    },
    settings: {
      getSetting: vi.fn(async (key: string) => (key in settingsStore ? settingsStore[key] : null)),
      setSetting: vi.fn(async (key: string, value: string) => {
        settingsStore[key] = value;
      }),
    },
    auditLogAsync: vi.fn().mockResolvedValue(undefined),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  };
  return { dbMock, settingsStore };
});

vi.mock('../services/database.js', () => ({ default: dbMock, databaseService: dbMock }));

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    createFromRadioTextMessage: vi.fn(async (_msg: unknown) => new Uint8Array([1, 2, 3])),
    parseToRadio: vi.fn(),
    normalizePortNum: vi.fn((n: unknown) => (typeof n === 'number' ? n : 0)),
    getPortNumName: (n: number) => `PORT_${n}`,
  };
  return { default: svc, meshtasticProtobufService: svc };
});

vi.mock('./protobufService.js', () => {
  const svc = { decodeAdminMessage: vi.fn() };
  return { default: svc, protobufService: svc };
});

import { VirtualNodeServer } from './virtualNodeServer.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const LOCAL = 0x11223344;
const PEER = 0x55667788;

function makeManager(sourceId = 'src-1') {
  return {
    sourceId,
    getLocalNodeInfo: () => ({ nodeNum: LOCAL, nodeId: '!11223344' }),
    processIncomingData: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeServer(sourceId = 'src-1'): VirtualNodeServer {
  return new VirtualNodeServer({ port: 4601, meshtasticManager: makeManager(sourceId) });
}

function attachClient(
  vn: VirtualNodeServer,
  clientId: string,
  remoteAddress = '192.168.1.50',
  lastActivity = new Date('2026-11-03T12:00:00Z'),
) {
  const writes: Uint8Array[] = [];
  const socket: any = {
    destroyed: false,
    writable: true,
    remoteAddress,
    write: (chunk: Uint8Array, cb?: (err?: Error) => void) => {
      writes.push(chunk);
      if (cb) cb();
      return true;
    },
    end: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn(),
  };
  const client: any = {
    socket,
    id: clientId,
    buffer: Buffer.alloc(0),
    connectedAt: new Date(),
    lastActivity,
  };
  (vn as any).clients.set(clientId, client);
  return { writes, client, socket };
}

/** A stored text message row (DbMessage-shaped). */
function textRow(over: Record<string, unknown> = {}): any {
  return {
    id: `src-1_${LOCAL}_1000`,
    fromNodeNum: PEER,
    toNodeNum: 0xffffffff,
    text: 'hello',
    channel: 0,
    portnum: 1,
    timestamp: 1_700_000_000_000,
    rxTime: null,
    replyId: null,
    emoji: null,
    sourcePath: 'mqtt_bridge',
    ...over,
  };
}

function enableReplay(enabled = true, excludeIps = '') {
  settingsStore['virtualNodeReplayEnabled'] = enabled ? '1' : '0';
  settingsStore['virtualNodeReplayExcludeIps'] = excludeIps;
}

const createFromRadio = meshtasticProtobufService.createFromRadioTextMessage as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const k of Object.keys(settingsStore)) delete settingsStore[k];
  dbMock.nodes.getNode.mockReset().mockResolvedValue(null);
  dbMock.messages.getMessagesAfterTimestamp.mockReset().mockResolvedValue([]);
  dbMock.settings.getSetting.mockClear();
  dbMock.settings.setSetting.mockClear();
  createFromRadio.mockClear();
  createFromRadio.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

afterEach(() => {
  vi.useRealTimers();
});

// ────────────────────────────────────────────────────────────────────────────
// isReplayableMessage — filtering
// ────────────────────────────────────────────────────────────────────────────

describe('VirtualNodeServer replay — message filtering (#6160)', () => {
  it('accepts a channel text message', () => {
    const vn = makeServer();
    expect((vn as any).isReplayableMessage(textRow({ channel: 2 }), LOCAL)).toBe(true);
  });

  it('skips non-text portnums', () => {
    const vn = makeServer();
    expect((vn as any).isReplayableMessage(textRow({ portnum: 3 }), LOCAL)).toBe(false);
  });

  it("skips MeshMonitor's internal notes (id without an underscore)", () => {
    const vn = makeServer();
    expect((vn as any).isReplayableMessage(textRow({ id: 'note42' }), LOCAL)).toBe(false);
  });

  it('skips the app\'s own sends (local node + tcp_radio)', () => {
    const vn = makeServer();
    const row = textRow({ fromNodeNum: LOCAL, sourcePath: 'tcp_radio' });
    expect((vn as any).isReplayableMessage(row, LOCAL)).toBe(false);
  });

  it('keeps a local-node send that arrived another way', () => {
    const vn = makeServer();
    const row = textRow({ fromNodeNum: LOCAL, sourcePath: 'http_api' });
    expect((vn as any).isReplayableMessage(row, LOCAL)).toBe(true);
  });

  it('includes a DM only when it involves the local node', () => {
    const vn = makeServer();
    const involving = textRow({ channel: -1, fromNodeNum: PEER, toNodeNum: LOCAL });
    const foreign = textRow({ channel: -1, fromNodeNum: PEER, toNodeNum: 0x99999999 });
    expect((vn as any).isReplayableMessage(involving, LOCAL)).toBe(true);
    expect((vn as any).isReplayableMessage(foreign, LOCAL)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// computeReplaySince — first-connect window vs mark − margin
// ────────────────────────────────────────────────────────────────────────────

describe('VirtualNodeServer replay — replay window (#6160)', () => {
  it('uses the last 24 h on first connect (no mark)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    const vn = makeServer();
    (vn as any).replayLastSeen = null;
    const since = (vn as any).computeReplaySince();
    expect(since).toBe(Date.now() - 24 * 60 * 60 * 1000);
  });

  it('uses mark − 10 min once a mark exists', () => {
    const vn = makeServer();
    const mark = 1_700_000_000_000;
    (vn as any).replayLastSeen = mark;
    expect((vn as any).computeReplaySince()).toBe(mark - 10 * 60 * 1000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// replayToClient — gating, targeting, cap, pki, pacing, mark
// ────────────────────────────────────────────────────────────────────────────

describe('VirtualNodeServer replay — replayToClient (#6160)', () => {
  it('does nothing when the feature is off (opt-in)', async () => {
    enableReplay(false);
    const vn = makeServer();
    const { writes, client } = attachClient(vn, 'c1');
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([textRow()]);

    await (vn as any).replayToClient('c1');

    expect(writes).toHaveLength(0);
    expect(client.replayTarget).toBeUndefined();
    expect(dbMock.messages.getMessagesAfterTimestamp).not.toHaveBeenCalled();
  });

  it('never targets loopback and never moves the mark', async () => {
    enableReplay(true);
    const vn = makeServer();
    const { writes, client } = attachClient(vn, 'c1', '127.0.0.1');
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([textRow()]);

    await (vn as any).replayToClient('c1');

    expect(writes).toHaveLength(0);
    expect(client.replayTarget).toBe(false);
    expect(dbMock.settings.setSetting).not.toHaveBeenCalled();
  });

  it('never targets an excluded IP', async () => {
    enableReplay(true, '192.168.1.50, 10.0.0.9');
    const vn = makeServer();
    const { writes, client } = attachClient(vn, 'c1', '192.168.1.50');
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([textRow()]);

    await (vn as any).replayToClient('c1');

    expect(writes).toHaveLength(0);
    expect(client.replayTarget).toBe(false);
  });

  it('replays the backlog, paces 50 ms apart, and advances the mark on completion', async () => {
    enableReplay(true);
    vi.useFakeTimers();
    const vn = makeServer();
    const lastActivity = new Date('2026-11-03T12:00:00Z');
    const { writes, client } = attachClient(vn, 'c1', '192.168.1.50', lastActivity);
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([
      textRow({ id: `src-1_${PEER}_1` }),
      textRow({ id: `src-1_${PEER}_2` }),
      textRow({ id: `src-1_${PEER}_3` }),
    ]);
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const run = (vn as any).replayToClient('c1');
    await vi.runAllTimersAsync();
    await run;

    expect(writes).toHaveLength(3);
    expect(createFromRadio).toHaveBeenCalledTimes(3);
    // One 50 ms gap per message.
    const gapCalls = setTimeoutSpy.mock.calls.filter((c) => c[1] === 50);
    expect(gapCalls).toHaveLength(3);
    expect(client.replayDone).toBe(true);
    // Mark persisted (forced) at the client's last activity.
    expect(dbMock.settings.setSetting).toHaveBeenCalledWith(
      `virtualNode.replayLastSeen.src-1`,
      String(lastActivity.getTime()),
    );
  });

  it('caps at 2000 messages and keeps the newest', async () => {
    enableReplay(true);
    vi.useFakeTimers();
    const vn = makeServer();
    const rows = Array.from({ length: 2100 }, (_, i) => textRow({ id: `src-1_${PEER}_${i}` }));
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue(rows);
    attachClient(vn, 'c1');

    const run = (vn as any).replayToClient('c1');
    await vi.runAllTimersAsync();
    await run;

    expect(createFromRadio).toHaveBeenCalledTimes(2000);
    // Oldest 100 dropped: the first replayed id is row index 100.
    expect(createFromRadio.mock.calls[0][0].id).toBe(`src-1_${PEER}_100`);
    expect(createFromRadio.mock.calls[1999][0].id).toBe(`src-1_${PEER}_2099`);
  });

  it('does NOT advance the mark when the client leaves mid-replay', async () => {
    enableReplay(true);
    vi.useFakeTimers();
    const vn = makeServer();
    const { client, socket } = attachClient(vn, 'c1');
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([
      textRow({ id: `src-1_${PEER}_1` }),
      textRow({ id: `src-1_${PEER}_2` }),
    ]);
    // Drop the socket as the first message is written; the next loop
    // iteration's top-of-loop check then bails before sending the rest.
    socket.write = (_chunk: Uint8Array, cb?: (err?: Error) => void) => {
      socket.destroyed = true;
      if (cb) cb();
      return true;
    };

    const run = (vn as any).replayToClient('c1');
    await vi.runAllTimersAsync();
    await run;

    expect(client.replayDone).toBeFalsy();
    expect(dbMock.settings.setSetting).not.toHaveBeenCalled();
  });

  it('recomputes pki_encrypted for a qualifying DM, caching per peer', async () => {
    enableReplay(true);
    vi.useFakeTimers();
    const vn = makeServer();
    dbMock.nodes.getNode.mockResolvedValue({ publicKey: 'base64key', keyMismatchDetected: false });
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([
      textRow({ id: `src-1_${PEER}_1`, channel: -1, fromNodeNum: PEER, toNodeNum: LOCAL }),
      textRow({ id: `src-1_${PEER}_2`, channel: -1, fromNodeNum: PEER, toNodeNum: LOCAL }),
    ]);
    attachClient(vn, 'c1');

    const run = (vn as any).replayToClient('c1');
    await vi.runAllTimersAsync();
    await run;

    expect(createFromRadio.mock.calls[0][0].pkiEncrypted).toBe(true);
    expect(createFromRadio.mock.calls[1][0].pkiEncrypted).toBe(true);
    // Peer decision cached — getNode hit once for the two DMs with the same peer.
    expect(dbMock.nodes.getNode).toHaveBeenCalledTimes(1);
  });

  it('passes the stored hop fields through so the app can show hops', async () => {
    enableReplay(true);
    vi.useFakeTimers();
    const vn = makeServer();
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([
      textRow({ hopStart: 7, hopLimit: 4, viaMqtt: false }),
      textRow({ id: `src-1_${PEER}_2`, hopStart: 6, hopLimit: 0, viaMqtt: true }),
    ]);
    attachClient(vn, 'c1');

    const run = (vn as any).replayToClient('c1');
    await vi.runAllTimersAsync();
    await run;

    expect(createFromRadio.mock.calls[0][0]).toMatchObject({ hopStart: 7, hopLimit: 4, viaMqtt: false });
    expect(createFromRadio.mock.calls[1][0]).toMatchObject({ hopStart: 6, hopLimit: 0, viaMqtt: true });
  });

  it('does not set pki_encrypted for a channel message', async () => {
    enableReplay(true);
    vi.useFakeTimers();
    const vn = makeServer();
    dbMock.nodes.getNode.mockResolvedValue({ publicKey: 'base64key', keyMismatchDetected: false });
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([textRow({ channel: 0 })]);
    attachClient(vn, 'c1');

    const run = (vn as any).replayToClient('c1');
    await vi.runAllTimersAsync();
    await run;

    expect(createFromRadio.mock.calls[0][0].pkiEncrypted).toBe(false);
    expect(dbMock.nodes.getNode).not.toHaveBeenCalled();
  });

  it('does not set pki_encrypted for a DM whose peer has a key mismatch', async () => {
    enableReplay(true);
    vi.useFakeTimers();
    const vn = makeServer();
    dbMock.nodes.getNode.mockResolvedValue({ publicKey: 'base64key', keyMismatchDetected: true });
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([
      textRow({ id: `src-1_${PEER}_1`, channel: -1, fromNodeNum: LOCAL, toNodeNum: PEER }),
    ]);
    attachClient(vn, 'c1');

    const run = (vn as any).replayToClient('c1');
    await vi.runAllTimersAsync();
    await run;

    expect(createFromRadio.mock.calls[0][0].pkiEncrypted).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Mark: persistence, per-source isolation, disconnect
// ────────────────────────────────────────────────────────────────────────────

describe('VirtualNodeServer replay — the shared mark (#6160)', () => {
  it('keys the mark per source', () => {
    expect((makeServer('src-A') as any).replayMarkKey()).toBe('virtualNode.replayLastSeen.src-A');
    expect((makeServer('src-B') as any).replayMarkKey()).toBe('virtualNode.replayLastSeen.src-B');
  });

  it('loads a persisted mark on start-up', async () => {
    settingsStore['virtualNode.replayLastSeen.src-1'] = '1700000000000';
    const vn = makeServer();
    await (vn as any).loadReplayMark();
    expect((vn as any).replayLastSeen).toBe(1700000000000);
  });

  it('throttles the persisted write but forces it on completion', async () => {
    const vn = makeServer();
    (vn as any).replayLastSaved = 0;
    (vn as any).replayLastSeen = 0;
    // A small advance within the throttle window is not written.
    await (vn as any).saveReplayMark(1000, false);
    expect(dbMock.settings.setSetting).not.toHaveBeenCalled();
    // Forced write persists immediately.
    await (vn as any).saveReplayMark(2000, true);
    expect(dbMock.settings.setSetting).toHaveBeenCalledWith('virtualNode.replayLastSeen.src-1', '2000');
  });

  it('on disconnect advances the mark only if the replay finished', async () => {
    const vn = makeServer();
    const { client } = attachClient(vn, 'c1');
    client.replayTarget = true;
    client.replayDone = false;
    (vn as any).handleClientDisconnect('c1');
    expect(dbMock.settings.setSetting).not.toHaveBeenCalled();

    const { client: c2 } = attachClient(vn, 'c2');
    c2.replayTarget = true;
    c2.replayDone = true;
    (vn as any).handleClientDisconnect('c2');
    expect(dbMock.settings.setSetting).toHaveBeenCalledWith(
      'virtualNode.replayLastSeen.src-1',
      String(c2.lastActivity.getTime()),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// scheduleReplay — settle delay reset
// ────────────────────────────────────────────────────────────────────────────

describe('VirtualNodeServer replay — settle delay (#6160)', () => {
  it('arms the replay after ~3 s and a follow-up config resets the timer', async () => {
    enableReplay(true);
    vi.useFakeTimers();
    const vn = makeServer();
    attachClient(vn, 'c1');
    dbMock.messages.getMessagesAfterTimestamp.mockResolvedValue([]);
    const replaySpy = vi.spyOn(vn as any, 'replayToClient');

    (vn as any).scheduleReplay('c1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(replaySpy).not.toHaveBeenCalled();
    // A follow-up config resets the 3 s window.
    (vn as any).scheduleReplay('c1');
    await vi.advanceTimersByTimeAsync(2000);
    expect(replaySpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(replaySpy).toHaveBeenCalledTimes(1);
  });
});
