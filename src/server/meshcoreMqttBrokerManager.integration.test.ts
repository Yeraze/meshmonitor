/**
 * Embedded MeshCore MQTT broker (#6197): real Aedes on an ephemeral port, real
 * mqtt.js clients. Covers auth accept/reject, topic/key mismatch, the rate
 * limit, the payload cap, the ingest hand-off, and upstream forwarding in both
 * identity modes (plus the loop guard).
 *
 * The ingest pipeline itself (database writes) is covered by the
 * meshcoreMqttManager suites; here the two hand-off methods are spied so the
 * test asserts exactly what the broker accepted.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type Socket, connect as netConnect } from 'net';
import { Aedes, type Client } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';
import { verifyAuthToken } from '@michaelhart/meshcore-decoder';
import { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import { MeshCoreMqttBrokerManager } from './meshcoreMqttBrokerManager.js';
import { meshcoreMessageFilter } from './services/meshcoreMessageFilter.js';
import {
  deriveObserverPublicKey,
  generateObserverPrivateKey,
  mintObserverToken,
} from './services/meshcoreObserverToken.js';
import {
  setMeshCoreObserverKeyStoreForTesting,
  type MeshCoreObserverKeyStore,
} from './services/meshcoreObserverKeyStore.js';

const AUDIENCE = 'broker.test';
const FRAME = '0500deadbeef'; // flood ADVERT header, empty path, 4 payload bytes

let OBS_PRIV = '';
let OBS_PUB = '';
let OTHER_PRIV = '';
let OTHER_PUB = '';
let OWN_PRIV = '';
let OWN_PUB = '';

const ingestPacket = vi.spyOn(MeshCoreMqttManager.prototype as never, 'ingestDecodedPacket' as never);
const ingestStatus = vi.spyOn(MeshCoreMqttManager.prototype as never, 'ingestDecodedStatus' as never);

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function packetBody(originId: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({ origin: 'Obs', origin_id: originId, type: 'PACKET', raw: FRAME, SNR: '5.5', RSSI: '-90', ...extra }),
  );
}

function statusBody(originId: string): Buffer {
  return Buffer.from(JSON.stringify({ status: 'online', origin: 'Obs', origin_id: originId, timestamp: new Date().toISOString() }));
}

async function connectObserver(
  port: number,
  username: string,
  password: string | undefined,
): Promise<MqttClient> {
  return mqtt.connectAsync(`mqtt://127.0.0.1:${port}`, {
    username,
    password,
    reconnectPeriod: 0,
    connectTimeout: 3000,
    clientId: `test-${Math.random().toString(36).slice(2, 8)}`,
  });
}

async function connectRefused(port: number, username: string, password: string | undefined): Promise<number | null> {
  try {
    const c = await connectObserver(port, username, password);
    await c.endAsync();
    return null;
  } catch (err) {
    return (err as { code?: number }).code ?? -1;
  }
}

async function tokenLogin(port: number, priv: string, pub: string, aud = AUDIENCE): Promise<MqttClient> {
  const t = await mintObserverToken(priv, aud);
  return connectObserver(port, `v1_${pub}`, t.token);
}

/** A bare upstream broker that accepts any login and records what it is sent. */
interface Upstream {
  port: number;
  logins: Array<{ username: string; password: string }>;
  messages: Array<{ topic: string; payload: string; retain: boolean }>;
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const aedes = await Aedes.createBroker();
  const logins: Upstream['logins'] = [];
  const messages: Upstream['messages'] = [];
  aedes.authenticate = (_c, username, password, done) => {
    logins.push({ username: String(username ?? ''), password: password ? password.toString('utf8') : '' });
    done(null, true);
  };
  aedes.on('publish', (packet, client: Client | null) => {
    if (!client) return;
    messages.push({ topic: packet.topic, payload: Buffer.from(packet.payload as Buffer).toString('utf8'), retain: !!packet.retain });
  });
  const sockets = new Set<Socket>();
  const server: Server = createServer((s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
    aedes.handle(s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    logins,
    messages,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => aedes.close(() => r()));
    },
  };
}

function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listener: { port: 1 },
    auth: {
      tokenAudience: AUDIENCE,
      allowedObservers: [OBS_PUB, OTHER_PUB],
      username: 'local',
      password: 'static-secret',
    },
    ...extra,
  };
}

const managers: MeshCoreMqttBrokerManager[] = [];
const clients: MqttClient[] = [];

async function startManager(cfg: Record<string, unknown>): Promise<{ mgr: MeshCoreMqttBrokerManager; port: number }> {
  const mgr = new MeshCoreMqttBrokerManager(`src-${managers.length}`, 'Broker', cfg, { portOverride: 0 });
  managers.push(mgr);
  await mgr.start();
  const port = mgr.getBoundPort();
  if (!port) throw new Error('broker did not bind');
  return { mgr, port };
}

beforeAll(async () => {
  OBS_PRIV = generateObserverPrivateKey();
  OBS_PUB = await deriveObserverPublicKey(OBS_PRIV);
  OTHER_PRIV = generateObserverPrivateKey();
  OTHER_PUB = await deriveObserverPublicKey(OTHER_PRIV);
  OWN_PRIV = generateObserverPrivateKey();
  OWN_PUB = await deriveObserverPublicKey(OWN_PRIV);
  vi.spyOn(meshcoreMessageFilter, 'loadSource').mockResolvedValue(undefined as never);
  setMeshCoreObserverKeyStoreForTesting({
    load: async () => ({ kind: 'ok', privateKeyHex: OWN_PRIV, publicKeyHex: OWN_PUB, origin: 'manual' }),
  } as unknown as MeshCoreObserverKeyStore);
});

afterAll(() => {
  setMeshCoreObserverKeyStoreForTesting(null);
});

beforeEach(() => {
  ingestPacket.mockReset().mockImplementation((() => {}) as never);
  ingestStatus.mockReset().mockImplementation((async () => {}) as never);
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.endAsync(true).catch(() => {});
  for (const m of managers.splice(0)) await m.stop();
});

describe('MeshCoreMqttBrokerManager: auth', () => {
  it('accepts an allowlisted observer with a valid token and ingests its packet', async () => {
    const { mgr, port } = await startManager(baseConfig());
    const c = await tokenLogin(port, OBS_PRIV, OBS_PUB);
    clients.push(c);
    await c.publishAsync(`meshcore/SEA/${OBS_PUB}/packets`, packetBody(OBS_PUB));
    await waitFor(() => ingestPacket.mock.calls.length === 1);
    const decoded = ingestPacket.mock.calls[0][0] as unknown as { originId: string };
    expect(decoded.originId).toBe(OBS_PUB);
    const conn = mgr.getDiagnostics().connections[0];
    expect(conn).toMatchObject({ authMode: 'token', observerKey: OBS_PUB, accepted: 1 });
    expect(conn.lastTopic).toBe(`meshcore/SEA/${OBS_PUB}/packets`);
  });

  it('passes a status heartbeat to the status ingest', async () => {
    const { port } = await startManager(baseConfig());
    const c = await tokenLogin(port, OBS_PRIV, OBS_PUB);
    clients.push(c);
    await c.publishAsync(`meshcore/SEA/${OBS_PUB}/status`, statusBody(OBS_PUB), { retain: true });
    await waitFor(() => ingestStatus.mock.calls.length === 1);
  });

  it('refuses a key that is not on the allowlist, a wrong audience, and an anonymous login', async () => {
    const { mgr, port } = await startManager(
      baseConfig({ auth: { tokenAudience: AUDIENCE, allowedObservers: [OBS_PUB] } }),
    );
    const stranger = await mintObserverToken(OTHER_PRIV, AUDIENCE);
    expect(await connectRefused(port, `v1_${OTHER_PUB}`, stranger.token)).toBe(5);
    const wrongAud = await mintObserverToken(OBS_PRIV, 'elsewhere');
    expect(await connectRefused(port, `v1_${OBS_PUB}`, wrongAud.token)).toBe(4);
    // A token signed by another key, presented under OBS_PUB.
    expect(await connectRefused(port, `v1_${OBS_PUB}`, stranger.token)).toBe(4);
    expect(await connectRefused(port, '', undefined)).toBe(4);
    const reasons = mgr.getDiagnostics().recent.map((r) => r.reason);
    expect(reasons).toEqual(
      expect.arrayContaining(['auth_not_allowlisted', 'auth_bad_audience', 'auth_bad_token', 'auth_bad_credentials']),
    );
  });

  it('accepts the static login and refuses a wrong password', async () => {
    const { port } = await startManager(baseConfig());
    expect(await connectRefused(port, 'local', 'wrong')).toBe(4);
    const c = await connectObserver(port, 'local', 'static-secret');
    clients.push(c);
    await c.publishAsync(`meshcore/SEA/${OTHER_PUB}/packets`, packetBody(OTHER_PUB));
    await waitFor(() => ingestPacket.mock.calls.length === 1);
  });

  it('refuses a connection past the client cap', async () => {
    const { port } = await startManager(baseConfig({ limits: { maxClients: 1 } }));
    const c = await connectObserver(port, 'local', 'static-secret');
    clients.push(c);
    await waitFor(() => managers[0].getDiagnostics().clientCount === 1);
    expect(await connectRefused(port, 'local', 'static-secret')).toBe(3);
  });
});

describe('MeshCoreMqttBrokerManager: publish checks', () => {
  it('drops a token login publishing under another key, and a body/topic mismatch', async () => {
    const { mgr, port } = await startManager(baseConfig());
    const c = await tokenLogin(port, OBS_PRIV, OBS_PUB);
    clients.push(c);
    await c.publishAsync(`meshcore/SEA/${OTHER_PUB}/packets`, packetBody(OTHER_PUB));
    await waitFor(() => mgr.getDiagnostics().connections[0]?.rejected === 1);
    expect(mgr.getDiagnostics().connections[0].lastRejectReason).toBe('key_mismatch');
    await c.publishAsync(`meshcore/SEA/${OBS_PUB}/packets`, packetBody(OTHER_PUB));
    await waitFor(() => mgr.getDiagnostics().connections[0]?.rejected === 2);
    expect(mgr.getDiagnostics().connections[0].lastRejectReason).toBe('key_mismatch');
    expect(ingestPacket).not.toHaveBeenCalled();
  });

  it('reports the reject reason for a bad region, missing raw, and non-PACKET body', async () => {
    const { mgr, port } = await startManager(baseConfig({ regions: ['SEA'] }));
    const c = await tokenLogin(port, OBS_PRIV, OBS_PUB);
    clients.push(c);
    const last = () => mgr.getDiagnostics().connections[0]?.lastRejectReason;
    await c.publishAsync(`meshcore/PDX/${OBS_PUB}/packets`, packetBody(OBS_PUB));
    await waitFor(() => last() === 'bad_region');
    await c.publishAsync(`meshcore/SEA/${OBS_PUB}/packets`, packetBody(OBS_PUB, { raw: undefined }));
    await waitFor(() => last() === 'missing_raw');
    await c.publishAsync(`meshcore/SEA/${OBS_PUB}/packets`, packetBody(OBS_PUB, { type: 'STATUS' }));
    await waitFor(() => last() === 'non_packet_type');
  });

  it('drops and counts messages above the per-connection rate', async () => {
    const { mgr, port } = await startManager(baseConfig({ limits: { maxMessagesPerSecond: 2 } }));
    const c = await tokenLogin(port, OBS_PRIV, OBS_PUB);
    clients.push(c);
    for (let i = 0; i < 6; i++) {
      c.publish(`meshcore/SEA/${OBS_PUB}/packets`, packetBody(OBS_PUB, { hash: String(i) }));
    }
    await waitFor(() => (mgr.getDiagnostics().connections[0]?.received ?? 0) === 6);
    const conn = mgr.getDiagnostics().connections[0];
    expect(conn.rateDropped).toBeGreaterThanOrEqual(3);
    expect(conn.accepted + conn.rateDropped).toBe(6);
    expect(conn.lastRejectReason).toBe('rate');
    // The session survives: the observer loses frames, not its connection.
    expect(c.connected).toBe(true);
  });

  it('drops a payload over the cap and cuts a connection that declares a huge packet', async () => {
    const { mgr, port } = await startManager(baseConfig({ limits: { maxPayloadBytes: 512 } }));
    const c = await tokenLogin(port, OBS_PRIV, OBS_PUB);
    clients.push(c);
    await c.publishAsync(`meshcore/SEA/${OBS_PUB}/packets`, packetBody(OBS_PUB, { pad: 'x'.repeat(1000) }));
    await waitFor(() => mgr.getDiagnostics().connections[0]?.lastRejectReason === 'payload_too_large');

    // A raw socket that announces a 10 MB packet is dropped before it is sent.
    const sock = netConnect(port, '127.0.0.1');
    const closed = new Promise<void>((r) => sock.once('close', () => r()));
    sock.on('error', () => {});
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write(Buffer.from([0x30, 0x80, 0x80, 0x80, 0x05])); // PUBLISH, remaining length 10,485,760
    await closed;
  });
});

describe('MeshCoreMqttBrokerManager: forwarding', () => {
  let upstream: Upstream;
  beforeEach(async () => {
    upstream = await startUpstream();
  });
  afterEach(async () => {
    await upstream.close();
  });

  it('pass-through: relays allowlisted observers verbatim with the static login', async () => {
    const { mgr, port } = await startManager(
      baseConfig({
        forwarding: {
          targets: [
            {
              id: 't1',
              enabled: true,
              url: `mqtt://127.0.0.1:${upstream.port}`,
              identityMode: 'passthrough',
              username: 'up-user',
              password: 'up-pass',
              observers: [OBS_PUB],
            },
          ],
        },
      }),
    );
    await waitFor(() => mgr.getDiagnostics().forwarding[0]?.connected === true);
    expect(upstream.logins[0]).toEqual({ username: 'up-user', password: 'up-pass' });

    const obs = await tokenLogin(port, OBS_PRIV, OBS_PUB);
    const other = await tokenLogin(port, OTHER_PRIV, OTHER_PUB);
    clients.push(obs, other);
    const body = packetBody(OBS_PUB);
    await obs.publishAsync(`meshcore/SEA/${OBS_PUB}/packets`, body);
    await other.publishAsync(`meshcore/SEA/${OTHER_PUB}/packets`, packetBody(OTHER_PUB));
    await waitFor(() => upstream.messages.length >= 1 && ingestPacket.mock.calls.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(upstream.messages).toHaveLength(1); // OTHER_PUB is not on this target's list
    expect(upstream.messages[0]).toMatchObject({ topic: `meshcore/SEA/${OBS_PUB}/packets`, payload: body.toString('utf8') });

    // Loop guard: the same bytes coming back in are dropped, not re-ingested.
    await obs.publishAsync(`meshcore/SEA/${OBS_PUB}/packets`, body);
    await waitFor(() => mgr.getDiagnostics().connections.some((c) => c.lastRejectReason === 'loop'));
    expect(ingestPacket).toHaveBeenCalledTimes(2);
  });

  it('own identity: republishes under MeshMonitor\'s key with a minted token', async () => {
    const { mgr, port } = await startManager(
      baseConfig({
        forwarding: {
          ownIdentityName: 'MM',
          targets: [
            {
              id: 't2',
              enabled: true,
              url: `mqtt://127.0.0.1:${upstream.port}`,
              identityMode: 'own',
              tokenAudience: 'upstream.example',
              observers: [OBS_PUB],
              iataFilter: ['SEA'],
            },
          ],
        },
      }),
    );
    await waitFor(() => mgr.getDiagnostics().forwarding[0]?.connected === true);
    const login = upstream.logins[0];
    expect(login.username).toBe(`v1_${OWN_PUB}`);
    const claims = await verifyAuthToken(login.password, OWN_PUB);
    expect(claims?.aud).toBe('upstream.example');

    const obs = await tokenLogin(port, OBS_PRIV, OBS_PUB);
    clients.push(obs);
    await obs.publishAsync(`meshcore/PDX/${OBS_PUB}/packets`, packetBody(OBS_PUB)); // filtered by IATA
    await obs.publishAsync(`meshcore/SEA/${OBS_PUB}/packets`, packetBody(OBS_PUB));
    await obs.publishAsync(`meshcore/SEA/${OBS_PUB}/status`, statusBody(OBS_PUB)); // not relayed in own mode
    await waitFor(() => upstream.messages.some((m) => m.topic.endsWith('/packets')));
    await new Promise((r) => setTimeout(r, 100));
    const packets = upstream.messages.filter((m) => m.topic.endsWith('/packets'));
    expect(packets).toHaveLength(1);
    expect(packets[0].topic).toBe(`meshcore/SEA/${OWN_PUB}/packets`);
    const relayed = JSON.parse(packets[0].payload) as Record<string, unknown>;
    expect(relayed).toMatchObject({ origin_id: OWN_PUB, origin: 'MM', raw: FRAME });
    // Only our own online status, never the observer's heartbeat.
    const statuses = upstream.messages.filter((m) => m.topic.endsWith('/status'));
    expect(statuses.every((m) => m.topic === `meshcore/SEA/${OWN_PUB}/status`)).toBe(true);

    // Our own identity can never log in to our own broker.
    const own = await mintObserverToken(OWN_PRIV, AUDIENCE);
    expect(await connectRefused(port, `v1_${OWN_PUB}`, own.token)).toBe(5);
  });
});
