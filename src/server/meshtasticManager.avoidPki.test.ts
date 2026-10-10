/**
 * Reliable PKI "Avoid PKI" (#5711) through the REAL MeshtasticManager send paths.
 *
 * The radio PKI-encrypts any unicast it originates to a node whose key it holds
 * (firmware `wouldEncryptWithPKC`) and ignores `pki_encrypted = false`, so in
 * Avoid PKI mode MeshMonitor hands it the request already channel-encrypted.
 * These tests decode every ToRadio frame the manager gives the transport:
 *
 *   - telemetry / remote LocalStats / neighbor info requests leave as an
 *     `encrypted` packet whose channel byte is the node's channel hash, and the
 *     ciphertext decrypts (with the channel key) to the original request;
 *   - in Off / As needed they leave `decoded`, as before (the radio PKIs them);
 *   - DMs and waypoints are untouched; nothing is primed; request sends do not
 *     touch pki_exchange_state;
 *   - the per-source override applies; anything that cannot be encrypted the
 *     way the radio would falls back to a normal send.
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

const { rows, k, blank, store, settingsMap, nodesMap } = vi.hoisted(() => {
  type Row = import('../db/repositories/pkiExchangeState.js').PkiExchangeStateRow;
  const rows = new Map<string, Row>();
  const k = (s: string, n: number) => `${s}|${n}`;
  const blank = (sourceId: string, nodeNum: number, now: number): Row => ({
    sourceId, nodeNum, state: 'pending', stateChangedAt: now, lastSuccessAt: null, failingSince: null,
    lastFailureReason: null, lastPrimedAt: null, updatedAt: now,
  });
  const store = {
    getState: vi.fn(async (s: string, n: number) => rows.get(k(s, n)) ?? null),
    markPending: vi.fn(async (s: string, n: number, now = Date.now()) => {
      const r: Row = { ...(rows.get(k(s, n)) ?? blank(s, n, now)), state: 'pending', stateChangedAt: now, updatedAt: now };
      rows.set(k(s, n), r); return r;
    }),
    markSuccessful: vi.fn(async (s: string, n: number) => rows.get(k(s, n))),
    markFailed: vi.fn(async (s: string, n: number) => rows.get(k(s, n))),
    countPrimedSince: vi.fn(async () => 0),
    recordPriming: vi.fn(async (s: string, n: number, now = Date.now()) => {
      const r: Row = { ...(rows.get(k(s, n)) ?? blank(s, n, now)), lastPrimedAt: now, updatedAt: now };
      rows.set(k(s, n), r); return r;
    }),
  };
  return { rows, k, blank, store, settingsMap: new Map<string, string>(), nodesMap: new Map<number, any>() };
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
    ignoredNodes: { isIgnoredCached: vi.fn(() => false) },
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
import { PortNum } from './constants/meshtastic.js';
import { resolveChannelKey, encryptChannelPayload, type RadioChannel } from './utils/channelEncryption.js';
import { logger } from '../utils/logger.js';

const SOURCE = 'src-a';
const LOCAL = 0x0a0a0a0a;
const PEER = 0x22222222;
const PEER_CHANNEL = 2;
const SECRET_PSK = new Uint8Array(32).fill(9);
const PEER_ROW = {
  nodeNum: PEER, nodeId: '!22222222', longName: 'Peer', shortName: 'PEER',
  publicKey: 'HsTA8jkJVxYBxqfm0V8KZ8wOlqL+R5vP3yEXRtY3p9c=', keyMismatchDetected: false, channel: PEER_CHANNEL,
};
const LORA = { usePreset: true, modemPreset: 0, hopLimit: 3 };

/** The radio's channel 0 (default LongFast) and channel 2 ("Secret", 32-byte key). */
const RADIO_CHANNELS = [
  { index: 0, role: 1, settings: { name: '', psk: new Uint8Array([1]) } },
  { index: 2, role: 2, settings: { name: 'Secret', psk: SECRET_PSK } },
];

interface Wire {
  portnum: number | null;
  to: number;
  channel: number;
  encrypted: boolean;
  id: number;
}

function decode(bytes: Uint8Array): Wire {
  const root = getProtobufRoot()!;
  const p = (root.lookupType('meshtastic.ToRadio').decode(bytes) as any).packet;
  return {
    portnum: p.decoded ? p.decoded.portnum : null,
    to: p.to >>> 0,
    channel: p.channel ?? 0,
    encrypted: !p.decoded && !!p.encrypted?.length,
    id: p.id >>> 0,
  };
}

function expectedHash(index: number): number {
  const channels = new Map<number, RadioChannel>(RADIO_CHANNELS.map((c) => [c.index, {
    index: c.index, role: c.role, name: c.settings.name, psk: c.settings.psk, useAead: false,
  }]));
  const r = resolveChannelKey(index, channels, LORA);
  if (!r.ok) throw new Error(r.reason);
  return r.channelKey.hash;
}

/** Decrypt a sent frame with channel `index`'s key and return its Data. */
function decryptSent(bytes: Uint8Array, index: number): any {
  const root = getProtobufRoot()!;
  const p = (root.lookupType('meshtastic.ToRadio').decode(bytes) as any).packet;
  const channels = new Map<number, RadioChannel>(RADIO_CHANNELS.map((c) => [c.index, {
    index: c.index, role: c.role, name: c.settings.name, psk: c.settings.psk, useAead: false,
  }]));
  const r = resolveChannelKey(index, channels, LORA);
  if (!r.ok) throw new Error(r.reason);
  const plain = encryptChannelPayload(r.channelKey.key, p.id >>> 0, LOCAL, p.encrypted);
  return root.lookupType('meshtastic.Data').decode(plain);
}

function makeManager(sourceId = SOURCE, opts: { reportChannels?: boolean } = {}) {
  const mgr = new MeshtasticManager(sourceId, { host: '127.0.0.1', port: 4403 });
  const send = vi.fn().mockResolvedValue(undefined);
  (mgr as any).isConnected = true;
  (mgr as any).transport = { send };
  (mgr as any).localNodeInfo = { nodeNum: LOCAL, nodeId: '!0a0a0a0a' };
  (mgr as any).actualDeviceConfig = { security: { publicKey: new Uint8Array(32).fill(7) }, lora: { ...LORA } };
  (mgr as any).deviceContactKeyNums.add(PEER);
  (mgr as any).reliablePki.sleep = vi.fn().mockResolvedValue(undefined);
  (mgr as any).logOutgoingPacket = vi.fn().mockResolvedValue(undefined);
  if (opts.reportChannels !== false) {
    for (const ch of RADIO_CHANNELS) (mgr as any).recordRadioChannel(ch);
  }
  const frames = () => send.mock.calls.map((c) => c[0] as Uint8Array);
  const wire = () => frames().map(decode);
  return { mgr, send, wire, frames };
}

type RequestKind = 'telemetry' | 'localStats' | 'neighborInfo';
const REQUESTS: Array<[RequestKind, number, (m: MeshtasticManager, channel?: number) => Promise<unknown>]> = [
  ['telemetry', PortNum.TELEMETRY_APP, (m, ch = PEER_CHANNEL) => m.sendTelemetryRequest(PEER, ch, 'device')],
  ['localStats', PortNum.TELEMETRY_APP, (m, ch = PEER_CHANNEL) => m.requestRemoteLocalStats(PEER, ch, 3)],
  ['neighborInfo', PortNum.NEIGHBORINFO_APP, (m, ch = PEER_CHANNEL) => m.sendNeighborInfoRequest(PEER, ch)],
];

function seedFailed() {
  rows.set(k(SOURCE, PEER), {
    ...blank(SOURCE, PEER, Date.now() - 10_000), state: 'failed', failingSince: Date.now() - 10_000,
    lastFailureReason: 'timeout', lastPrimedAt: null,
  });
}

describe('Avoid PKI through MeshtasticManager (#5711)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(() => {
    rows.clear();
    settingsMap.clear();
    nodesMap.clear();
    nodesMap.set(PEER, { ...PEER_ROW });
    nodesMap.set(LOCAL, { nodeNum: LOCAL, nodeId: '!0a0a0a0a', longName: 'Local', shortName: 'LOCL', publicKey: 'x', channel: 0 });
    vi.clearAllMocks();
  });

  describe.each(REQUESTS)('%s request', (_kind, portnum, send) => {
    it('Avoid PKI: one channel-encrypted packet on the node\'s channel, decrypting to the request; never primed or tracked', async () => {
      settingsMap.set('reliablePkiMode', 'avoid');
      seedFailed(); // As needed would prime this node
      const { mgr, wire, frames } = makeManager();
      await send(mgr);
      const sent = wire();
      expect(sent).toHaveLength(1);
      expect(sent[0].encrypted).toBe(true);
      expect(sent[0].to).toBe(PEER);
      expect(sent[0].channel).toBe(expectedHash(PEER_CHANNEL));
      const data = decryptSent(frames()[0], PEER_CHANNEL);
      expect(data.portnum).toBe(portnum);
      expect(data.wantResponse).toBe(true);
      expect(store.recordPriming).not.toHaveBeenCalled();
      expect(store.markPending).not.toHaveBeenCalled();
      // The existing row is left as it was.
      expect(rows.get(k(SOURCE, PEER))?.state).toBe('failed');
    });

    it('Off: one decoded packet (the radio PKI-encrypts it), tracked as before', async () => {
      const { mgr, wire } = makeManager();
      await send(mgr);
      const sent = wire();
      expect(sent).toHaveLength(1);
      expect(sent[0].encrypted).toBe(false);
      expect(sent[0].portnum).toBe(portnum);
      await vi.waitFor(() => expect(store.markPending).toHaveBeenCalledWith(SOURCE, PEER, expect.any(Number)));
    });

    it('As needed: still primes a failing node, then sends decoded', async () => {
      settingsMap.set('reliablePkiMode', 'asNeeded');
      seedFailed();
      const { mgr, wire } = makeManager();
      await send(mgr);
      expect(wire().map((w) => w.portnum)).toEqual([PortNum.NODEINFO_APP, portnum]);
    });
  });

  it('channel 0 from the caller resolves to the node\'s stored channel, as key repair picks it', async () => {
    settingsMap.set('reliablePkiMode', 'avoid');
    const { mgr, wire, frames } = makeManager();
    await mgr.sendTelemetryRequest(PEER, 0, 'device');
    expect(wire()[0].channel).toBe(expectedHash(PEER_CHANNEL));
    expect(decryptSent(frames()[0], PEER_CHANNEL).portnum).toBe(PortNum.TELEMETRY_APP);
  });

  it('a node on the primary channel gets the primary channel\'s hash (LongFast = 8)', async () => {
    settingsMap.set('reliablePkiMode', 'avoid');
    nodesMap.set(PEER, { ...PEER_ROW, channel: 0 });
    const { mgr, wire } = makeManager();
    await mgr.sendTelemetryRequest(PEER, 0, 'device');
    expect(wire()[0]).toMatchObject({ encrypted: true, channel: 8 });
  });

  it('per-source override: a source set to Avoid PKI under a global Off', async () => {
    settingsMap.set('reliablePkiMode', 'off');
    settingsMap.set(`source:${SOURCE}:reliablePkiSourceMode`, 'avoid');
    const a = makeManager(SOURCE);
    await a.mgr.sendTelemetryRequest(PEER, PEER_CHANNEL, 'device');
    expect(a.wire()[0].encrypted).toBe(true);
    const b = makeManager('src-b');
    await b.mgr.sendTelemetryRequest(PEER, PEER_CHANNEL, 'device');
    expect(b.wire()[0].encrypted).toBe(false);
  });

  it('per-source override: a source set to Off under a global Avoid PKI', async () => {
    settingsMap.set('reliablePkiMode', 'avoid');
    settingsMap.set(`source:${SOURCE}:reliablePkiSourceMode`, 'off');
    const { mgr, wire } = makeManager();
    await mgr.sendNeighborInfoRequest(PEER, PEER_CHANNEL);
    expect(wire()[0].encrypted).toBe(false);
  });

  it('falls back to a normal send when the radio has not reported the channel (and still does not prime or track)', async () => {
    settingsMap.set('reliablePkiMode', 'avoid');
    seedFailed();
    const { mgr, wire } = makeManager(SOURCE, { reportChannels: false });
    await mgr.sendTelemetryRequest(PEER, PEER_CHANNEL, 'device');
    const sent = wire();
    expect(sent).toHaveLength(1);
    expect(sent[0].encrypted).toBe(false);
    expect(store.recordPriming).not.toHaveBeenCalled();
    expect(store.markPending).not.toHaveBeenCalled();
    expect(vi.mocked(logger.debug).mock.calls.some((c) => String(c[0]).includes('sent the normal way'))).toBe(true);
  });

  it('falls back on an AEAD channel', async () => {
    settingsMap.set('reliablePkiMode', 'avoid');
    const { mgr, wire } = makeManager();
    (mgr as any).recordRadioChannel({ index: 2, role: 2, settings: { name: 'Secret', psk: SECRET_PSK, useAead: true } });
    await mgr.sendTelemetryRequest(PEER, PEER_CHANNEL, 'device');
    expect(wire()[0].encrypted).toBe(false);
  });

  it('a slot reconfigured through MeshMonitor is not encrypted with its old key', async () => {
    settingsMap.set('reliablePkiMode', 'avoid');
    const { mgr, wire } = makeManager();
    (mgr as any).deviceAdminService.setChannelConfig = vi.fn().mockResolvedValue(undefined);
    await mgr.setChannelConfig(PEER_CHANNEL, { name: 'New', psk: 'AQ==' });
    await mgr.sendTelemetryRequest(PEER, PEER_CHANNEL, 'device');
    expect(wire()[0].encrypted).toBe(false);
  });

  it('DMs are untouched: decoded, never primed, tracked as in Off', async () => {
    settingsMap.set('reliablePkiMode', 'avoid');
    seedFailed();
    const { mgr, wire } = makeManager();
    try { await mgr.sendTextMessage('hello', 0, PEER); } catch { /* persistence after send is not under test */ }
    const sent = wire();
    expect(sent.map((w) => w.portnum)).toEqual([PortNum.TEXT_MESSAGE_APP]);
    expect(sent[0].encrypted).toBe(false);
    expect(store.recordPriming).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(store.markPending).toHaveBeenCalledWith(SOURCE, PEER, expect.any(Number)));
  });

  it('a waypoint to one node is untouched: decoded', async () => {
    settingsMap.set('reliablePkiMode', 'avoid');
    const { mgr, wire } = makeManager();
    await mgr.broadcastWaypoint(
      { id: 1, latitude: 1, longitude: 2, expire: 0, name: 'wp' },
      { destination: PEER, channel: PEER_CHANNEL },
    );
    const sent = wire();
    expect(sent).toHaveLength(1);
    expect(sent[0].encrypted).toBe(false);
    expect(sent[0].portnum).toBe(PortNum.WAYPOINT_APP);
  });

  it('a position request is never PKI on the wire and is left decoded', async () => {
    settingsMap.set('reliablePkiMode', 'avoid');
    const { mgr, wire } = makeManager();
    await mgr.sendPositionRequest(PEER, PEER_CHANNEL);
    const sent = wire();
    expect(sent.every((w) => !w.encrypted)).toBe(true);
    expect(sent.some((w) => w.portnum === PortNum.POSITION_APP)).toBe(true);
  });
});
