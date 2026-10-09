/**
 * Reliable PKI (#5691) through the REAL MeshtasticManager send paths.
 *
 * Drives `sendTextMessage` / `sendTelemetryRequest` with a fake transport and
 * decodes every ToRadio frame the manager hands it, so the assertions are on
 * what would actually reach the radio:
 *
 *   - a primed send is exactly one NodeInfo (to the node, on the node's
 *     channel, carrying the radio's own public key) followed by exactly one
 *     real message;
 *   - every other case is exactly one packet, the real one;
 *   - the hourly window lives in the store, so a new manager instance (a
 *     restart) and a settings save cannot reopen it.
 *
 * The DB is mocked; `pkiExchangeState` is an in-memory store that outlives a
 * manager instance, standing in for the persisted table (whose SQL is covered
 * by pkiExchangeState.test.ts / .pgmysql.test.ts).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

// ── in-memory pki_exchange_state + settings, shared across manager instances ─
// (vi.hoisted: vi.mock factories run before the module body.)
const { rows, k, blank, store, settingsMap, ignored, nodesMap } = vi.hoisted(() => {
  type Row = import('../db/repositories/pkiExchangeState.js').PkiExchangeStateRow;
  type Reason = import('../db/repositories/pkiExchangeState.js').PkiFailureReason;
  const rows = new Map<string, Row>();
  const k = (s: string, n: number) => `${s}|${n}`;
  const blank = (sourceId: string, nodeNum: number, now: number): Row => ({
    sourceId, nodeNum, state: 'pending', stateChangedAt: now, lastSuccessAt: null, failingSince: null,
    lastFailureReason: null, lastPrimedAt: null, updatedAt: now,
  });
  const fn = <T extends (...a: any[]) => any>(impl: T) => vi.fn(impl);
  const store = {
    getState: fn(async (s: string, n: number) => rows.get(k(s, n)) ?? null),
    markPending: fn(async (s: string, n: number, now = Date.now()) => {
      const r: Row = { ...(rows.get(k(s, n)) ?? blank(s, n, now)), state: 'pending', stateChangedAt: now, updatedAt: now };
      rows.set(k(s, n), r); return r;
    }),
    markSuccessful: fn(async (s: string, n: number, now = Date.now()) => {
      const r: Row = { ...(rows.get(k(s, n)) ?? blank(s, n, now)), state: 'successful', stateChangedAt: now, lastSuccessAt: now, failingSince: null, lastFailureReason: null, updatedAt: now };
      rows.set(k(s, n), r); return r;
    }),
    markFailed: fn(async (s: string, n: number, reason: Reason, now = Date.now()) => {
      const prev = rows.get(k(s, n)) ?? blank(s, n, now);
      const r: Row = { ...prev, state: 'failed', stateChangedAt: now, failingSince: prev.failingSince ?? now, lastFailureReason: reason, updatedAt: now };
      rows.set(k(s, n), r); return r;
    }),
    countPrimedSince: fn(async (s: string, since: number) =>
      [...rows.values()].filter((r) => r.sourceId === s && r.lastPrimedAt != null && r.lastPrimedAt > since).length),
    recordPriming: fn(async (s: string, n: number, now = Date.now()) => {
      const r: Row = { ...(rows.get(k(s, n)) ?? { ...blank(s, n, now), state: 'failed' }), lastPrimedAt: now, updatedAt: now };
      rows.set(k(s, n), r); return r;
    }),
  };
  return {
    rows, k, blank, store,
    settingsMap: new Map<string, string>(),
    ignored: new Set<string>(),
    nodesMap: new Map<number, any>(),
  };
});

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    getSettingAsync: vi.fn(async (key: string) => settingsMap.get(key) ?? null),
    settings: {
      getSetting: vi.fn(async (key: string) => settingsMap.get(key) ?? null),
      getSettingForSource: vi.fn(async (sourceId: string | null, key: string) =>
        settingsMap.get(sourceId ? `source:${sourceId}:${key}` : key) ?? null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn(async (n: number) => nodesMap.get(n) ?? null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    messages: { insertMessage: vi.fn().mockResolvedValue(true) },
    messageEvents: { recordEvent: vi.fn().mockResolvedValue(undefined) },
    ignoredNodes: { isIgnoredCached: vi.fn((n: number, s: string) => ignored.has(`${s}|${n}`)) },
    pkiExchangeState: store,
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import { MeshtasticManager } from './meshtasticManager.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';
import { PortNum, RoutingError } from './constants/meshtastic.js';
import { PRIMING_GAP_MS, PRIMING_MIN_INTERVAL_MS } from './services/reliablePki.js';
import { logger } from '../utils/logger.js';

const SOURCE = 'src-a';
const LOCAL = 0x0a0a0a0a;
const PEER = 0x22222222;
const PEER_CHANNEL = 2;
const OWN_KEY = new Uint8Array(32).fill(7);
const PEER_ROW = {
  nodeNum: PEER, nodeId: '!22222222', longName: 'Peer', shortName: 'PEER',
  publicKey: 'HsTA8jkJVxYBxqfm0V8KZ8wOlqL+R5vP3yEXRtY3p9c=', keyMismatchDetected: false, channel: PEER_CHANNEL,
};

interface Wire { portnum: number; to: number; channel: number; wantAck: boolean; wantResponse: boolean; publicKey?: Uint8Array }

function decode(bytes: Uint8Array): Wire {
  const root = getProtobufRoot()!;
  const toRadio = root.lookupType('meshtastic.ToRadio').decode(bytes) as any;
  const p = toRadio.packet;
  const out: Wire = {
    portnum: p.decoded.portnum, to: p.to >>> 0, channel: p.channel ?? 0,
    wantAck: !!p.wantAck, wantResponse: !!p.decoded.wantResponse,
  };
  if (p.decoded.portnum === PortNum.NODEINFO_APP) {
    const user = root.lookupType('meshtastic.User').decode(p.decoded.payload) as any;
    out.publicKey = user.publicKey?.length ? new Uint8Array(user.publicKey) : undefined;
  }
  return out;
}

function makeManager(sourceId = SOURCE) {
  const mgr = new MeshtasticManager(sourceId, { host: '127.0.0.1', port: 4403 });
  const send = vi.fn().mockResolvedValue(undefined);
  (mgr as any).isConnected = true;
  (mgr as any).transport = { send };
  (mgr as any).localNodeInfo = { nodeNum: LOCAL, nodeId: '!0a0a0a0a' };
  (mgr as any).actualDeviceConfig = { security: { publicKey: OWN_KEY } };
  (mgr as any).deviceContactKeyNums.add(PEER); // skip add_contact admin frames
  const sleep = vi.fn().mockResolvedValue(undefined);
  (mgr as any).reliablePki.sleep = sleep;
  const wire = () => send.mock.calls.map((c) => decode(c[0]));
  return { mgr, send, sleep, wire };
}

async function dm(mgr: MeshtasticManager, dest = PEER) {
  try { await mgr.sendTextMessage('hello', 0, dest); } catch { /* persistence after send is not under test */ }
}

function seedFailed(sourceId = SOURCE, nodeNum = PEER, lastPrimedAt: number | null = null) {
  rows.set(k(sourceId, nodeNum), {
    ...blank(sourceId, nodeNum, Date.now() - 10_000), state: 'failed', failingSince: Date.now() - 10_000,
    lastFailureReason: 'timeout', lastPrimedAt,
  });
}

describe('Reliable PKI through MeshtasticManager (#5691)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(() => {
    rows.clear();
    settingsMap.clear();
    ignored.clear();
    nodesMap.clear();
    nodesMap.set(PEER, { ...PEER_ROW });
    nodesMap.set(LOCAL, { nodeNum: LOCAL, nodeId: '!0a0a0a0a', longName: 'Local', shortName: 'LOCL', publicKey: 'x', channel: 0 });
    vi.clearAllMocks();
  });

  it('default Off: a DM to a failing node is exactly one packet', async () => {
    seedFailed();
    const { mgr, wire } = makeManager();
    await dm(mgr);
    const sent = wire();
    expect(sent).toHaveLength(1);
    expect(sent[0].portnum).toBe(PortNum.TEXT_MESSAGE_APP);
  });

  it('As needed + failed: exactly one NodeInfo (node channel, radio key, not PKI-eligible) then one DM', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed();
    const { mgr, wire, sleep } = makeManager();
    await dm(mgr);
    const sent = wire();
    expect(sent.map((w) => w.portnum)).toEqual([PortNum.NODEINFO_APP, PortNum.TEXT_MESSAGE_APP]);
    expect(sent[0].to).toBe(PEER);
    expect(sent[0].channel).toBe(PEER_CHANNEL);
    expect(sent[0].wantResponse).toBe(true);
    expect(sent[0].publicKey).toEqual(OWN_KEY);
    expect(sent[1].to).toBe(PEER);
    expect(sleep).toHaveBeenCalledWith(PRIMING_GAP_MS);
    expect(rows.get(k(SOURCE, PEER))?.lastPrimedAt).toBeTypeOf('number');
    expect(vi.mocked(logger.debug).mock.calls.some((c) => String(c[0]).includes('Reliable PKI: sent NodeInfo'))).toBe(true);
  });

  it('As needed but last exchange did not fail: one packet', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    rows.set(k(SOURCE, PEER), { ...blank(SOURCE, PEER, Date.now()), state: 'successful' });
    const { mgr, wire } = makeManager();
    await dm(mgr);
    expect(wire()).toHaveLength(1);
  });

  it('the hourly window holds: a second send within the hour is not primed', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed();
    const { mgr, wire } = makeManager();
    await dm(mgr);
    // The DM was tracked; force it back to failed as if it timed out.
    await store.markFailed(SOURCE, PEER, 'timeout');
    await dm(mgr);
    expect(wire().map((w) => w.portnum)).toEqual([PortNum.NODEINFO_APP, PortNum.TEXT_MESSAGE_APP, PortNum.TEXT_MESSAGE_APP]);
  });

  it('a restart (new manager instance) cannot reopen the window: the timer is in the store', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed(SOURCE, PEER, Date.now() - 60_000);
    const { mgr, wire } = makeManager();
    await dm(mgr);
    expect(wire()).toHaveLength(1);
  });

  it('a settings save cannot reopen the window', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed(SOURCE, PEER, Date.now() - 60_000);
    const { mgr, wire } = makeManager();
    // Re-save the same mode and flip the per-source override on: neither
    // touches pki_exchange_state.
    settingsMap.set('reliablePkiMode', 'asNeeded');
    settingsMap.set(`source:${SOURCE}:reliablePkiSourceMode`, 'asNeeded');
    await dm(mgr);
    expect(wire()).toHaveLength(1);
    expect(store.recordPriming).not.toHaveBeenCalled();
  });

  it('the window reopens after an hour', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed(SOURCE, PEER, Date.now() - PRIMING_MIN_INTERVAL_MS - 1000);
    const { mgr, wire } = makeManager();
    await dm(mgr);
    expect(wire()).toHaveLength(2);
  });

  it('per-source override wins over the global default, read with the source-scoped key', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    settingsMap.set(`source:${SOURCE}:reliablePkiSourceMode`, 'off');
    seedFailed();
    const { mgr, wire } = makeManager();
    await dm(mgr);
    expect(wire()).toHaveLength(1);
  });

  it('per-source isolation: another source\'s failure does not prime this source', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed('src-b');
    const { mgr, wire } = makeManager(SOURCE);
    await dm(mgr);
    expect(wire()).toHaveLength(1);
  });

  it.each([
    ['airtime cutoff', (m: any) => { m.isAutomationAirtimeGated = vi.fn().mockResolvedValue(true); }],
    ['radio key unknown', (m: any) => { m.actualDeviceConfig = { security: {} }; }],
  ])('TX gate (%s): no priming, the DM still goes out once', async (_label, gate) => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed();
    const { mgr, wire } = makeManager();
    gate(mgr);
    await dm(mgr);
    expect(wire().map((w) => w.portnum)).toEqual([PortNum.TEXT_MESSAGE_APP]);
    expect(store.recordPriming).not.toHaveBeenCalled();
  });

  it('TX disabled: nothing at all is sent (the DM itself is refused), and no priming is recorded', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed();
    const { mgr, wire } = makeManager();
    (mgr as any).canTransmit = () => false;
    await dm(mgr);
    expect(wire()).toHaveLength(0);
    expect(store.recordPriming).not.toHaveBeenCalled();
  });

  it('when the priming NodeInfo cannot be sent, the DM is still sent exactly once', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed();
    const { mgr, send, wire } = makeManager();
    send.mockRejectedValueOnce(new Error('radio busy'));
    await dm(mgr);
    // First call (the NodeInfo) threw; the second is the DM.
    expect(send).toHaveBeenCalledTimes(2);
    expect(wire()[1].portnum).toBe(PortNum.TEXT_MESSAGE_APP);
    // The attempt still consumed the hourly window (stamped before the send).
    expect(rows.get(k(SOURCE, PEER))?.lastPrimedAt).toBeTypeOf('number');
  });

  it('never primes an ignored node', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed();
    ignored.add(`${SOURCE}|${PEER}`);
    const { mgr, wire } = makeManager();
    await dm(mgr);
    expect(wire()).toHaveLength(1);
  });

  it('never primes a node with a key mismatch (key repair owns it); the DM is not PKI then either', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed();
    nodesMap.set(PEER, { ...PEER_ROW, keyMismatchDetected: true });
    const { mgr, wire } = makeManager();
    await dm(mgr);
    expect(wire()).toHaveLength(1);
  });

  it('never primes the local node', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed(SOURCE, LOCAL);
    const { mgr, wire } = makeManager();
    await dm(mgr, LOCAL);
    expect(wire().every((w) => w.portnum !== PortNum.NODEINFO_APP)).toBe(true);
  });

  it('at the per-source cap (10 primings this hour) the DM goes out alone', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    for (let i = 1; i <= 10; i++) seedFailed(SOURCE, 0x30000000 + i, Date.now() - 60_000);
    seedFailed();
    const { mgr, wire } = makeManager();
    await dm(mgr);
    expect(wire().map((w) => w.portnum)).toEqual([PortNum.TEXT_MESSAGE_APP]);
    expect(rows.get(k(SOURCE, PEER))?.lastPrimedAt ?? null).toBeNull();
    expect(vi.mocked(logger.debug).mock.calls.some((c) => String(c[0]).includes('priming sends already in the last hour'))).toBe(true);
  });

  it('a telemetry request to a failing node is primed too', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed();
    const { mgr, wire } = makeManager();
    await mgr.sendTelemetryRequest(PEER, 0, 'device');
    expect(wire().map((w) => w.portnum)).toEqual([PortNum.NODEINFO_APP, PortNum.TELEMETRY_APP]);
  });

  it('a traceroute (never PKI on the wire) is never primed', async () => {
    settingsMap.set('reliablePkiMode', 'asNeeded');
    seedFailed();
    const { mgr, wire } = makeManager();
    await mgr.sendTraceroute(PEER, 0);
    expect(wire().map((w) => w.portnum)).toEqual([PortNum.TRACEROUTE_APP]);
  });

  describe('state tracking from real inbound packets', () => {
    it('DM ack from the target marks successful; an implicit ack from our radio does not', async () => {
      const { mgr, send } = makeManager();
      await dm(mgr);
      const sent = getProtobufRoot()!.lookupType('meshtastic.ToRadio').decode(send.mock.calls[0][0]) as any;
      const id = sent.packet.id >>> 0;
      await vi.waitFor(() => expect(rows.get(k(SOURCE, PEER))?.state).toBe('pending'));

      // Implicit ack (our own radio overheard a relay): stays pending.
      await (mgr as any).processRoutingErrorMessage({ from: LOCAL, decoded: { requestId: id } }, { errorReason: RoutingError.NONE });
      expect(rows.get(k(SOURCE, PEER))?.state).toBe('pending');

      await (mgr as any).processRoutingErrorMessage({ from: PEER, decoded: { requestId: id } }, { errorReason: RoutingError.NONE });
      await vi.waitFor(() => expect(rows.get(k(SOURCE, PEER))?.state).toBe('successful'));
    });

    it('PKI_UNKNOWN_PUBKEY from the target marks failed and counts as a priming (the radio sent NodeInfo)', async () => {
      settingsMap.set('reliablePkiMode', 'asNeeded');
      const { mgr, send, wire } = makeManager();
      await dm(mgr);
      const id = (getProtobufRoot()!.lookupType('meshtastic.ToRadio').decode(send.mock.calls[0][0]) as any).packet.id >>> 0;
      await (mgr as any).processRoutingErrorMessage({ from: PEER, decoded: { requestId: id } }, { errorReason: RoutingError.PKI_UNKNOWN_PUBKEY });
      await vi.waitFor(() => expect(rows.get(k(SOURCE, PEER))?.state).toBe('failed'));
      await vi.waitFor(() => expect(rows.get(k(SOURCE, PEER))?.lastPrimedAt).toBeTypeOf('number'));
      // The next DM inside the hour is not primed by MeshMonitor a second time.
      await dm(mgr);
      expect(wire().map((w) => w.portnum)).toEqual([PortNum.TEXT_MESSAGE_APP, PortNum.TEXT_MESSAGE_APP]);
    });

    it('a zero-hop DM (no want_ack, no want_response) leaves the state untouched', async () => {
      rows.set(k(SOURCE, PEER), { ...blank(SOURCE, PEER, 1), state: 'successful' });
      const { mgr } = makeManager();
      try { await mgr.sendTextMessage('x', 0, PEER, undefined, undefined, undefined, undefined, { hopLimitOverride: 0 }); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 10));
      expect(store.markPending).not.toHaveBeenCalled();
      expect(rows.get(k(SOURCE, PEER))?.state).toBe('successful');
    });
  });
});
