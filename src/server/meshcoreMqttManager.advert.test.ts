/**
 * ADVERT → node ingest for an MQTT region feed (#5040 Phase 3).
 *
 * Adverts are the only frame a region feed can turn into node knowledge: they
 * are unencrypted and self-describing. Everything else is encrypted to someone
 * else or carries no identity.
 *
 * These tests build REAL advert frames to the wire layout
 * (pubkey 32 | timestamp 4 LE | signature 64 | appData) so they exercise the
 * shipping decoder rather than a stub of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const insertPacket = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...a: unknown[]) => upsertNode(...a),
      insertPacket: (...a: unknown[]) => insertPacket(...a),
    },
    getSettingAsync: vi.fn().mockResolvedValue('0'),
  },
}));

vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));

let lastClient: FakeClient | null = null;
class FakeClient {
  handlers = new Map<string, (arg: unknown) => void>();
  connect = vi.fn().mockResolvedValue(undefined);
  subscribe = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn().mockResolvedValue(undefined);
  isConnected = () => true;
  on(e: string, fn: (arg: unknown) => void) { this.handlers.set(e, fn); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  deliver(topic: string, body: unknown) {
    this.handlers.get('message')?.({ topic, payload: Buffer.from(JSON.stringify(body)) });
  }
}
vi.mock('./transports/mqttBrokerClient.js', () => ({
  MqttBrokerClient: class { constructor() { lastClient = new FakeClient(); return lastClient as unknown as object; } },
}));

import { MeshCoreMqttManager, advertLastHeardMs } from './meshcoreMqttManager.js';

const OBSERVER = 'AA'.repeat(32);
const NODE_KEY = '11'.repeat(32);

/** ADVERT flag bits (meshcorePacketDecode): 0x10 location, 0x80 name. */
const FLAG_LOCATION = 0x10;
const FLAG_NAME = 0x80;

/**
 * Build a wire-accurate ADVERT frame.
 * header | path_len | pubkey(32) | timestamp(4 LE) | signature(64) | appData
 */
function advertFrame(opts: {
  publicKey?: string;
  timestamp?: number;
  advType?: number;
  lat?: number;
  lon?: number;
  name?: string;
} = {}): string {
  const bytes: number[] = [];
  // route=FLOOD(1), payload_type=ADVERT(4)
  bytes.push((4 << 2) | 1, 0x00);
  const key = opts.publicKey ?? NODE_KEY;
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(key.slice(i, i + 2), 16));
  const ts = opts.timestamp ?? 1_700_000_000;
  bytes.push(ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, (ts >>> 24) & 0xff);
  for (let i = 0; i < 64; i++) bytes.push(0xcd); // signature (not verified on ingest)

  let flags = opts.advType ?? 1;
  const tail: number[] = [];
  if (opts.lat !== undefined && opts.lon !== undefined) {
    flags |= FLAG_LOCATION;
    for (const deg of [opts.lat, opts.lon]) {
      const v = Math.round(deg * 1_000_000) | 0;
      tail.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    }
  }
  if (opts.name !== undefined) {
    flags |= FLAG_NAME;
    for (const ch of Buffer.from(opts.name, 'utf8')) tail.push(ch);
  }
  bytes.push(flags, ...tail);
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

function body(raw: string) {
  return { type: 'PACKET', origin: 'Obs', origin_id: OBSERVER, raw, SNR: '-6', RSSI: '-90' };
}

async function started() {
  const mgr = new MeshCoreMqttManager('src-mqtt', 'Feed', {
    brokerUrl: 'wss://b.example', region: 'MCO',
  });
  await mgr.start();
  return mgr;
}

/** Wait out the fire-and-forget ingest promise. */
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  upsertNode.mockClear();
  lastClient = null;
});

describe('ADVERT ingest (#5040 Phase 3)', () => {
  it('creates a node from an advert carrying name and position', async () => {
    const mgr = await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`,
      body(advertFrame({ name: 'Repeater One', lat: 28.5383, lon: -81.3792, advType: 2 })));
    await settle();

    expect(upsertNode).toHaveBeenCalledTimes(1);
    const [node, sourceId] = upsertNode.mock.calls[0];
    expect(sourceId).toBe('src-mqtt');
    expect(node).toMatchObject({ publicKey: NODE_KEY, name: 'Repeater One', advType: 2 });
    expect(node.latitude).toBeCloseTo(28.5383, 5);
    expect(node.longitude).toBeCloseTo(-81.3792, 5);
    expect(mgr.getIngestStats().advertsIngested).toBe(1);
  });

  it('stamps lastHeard from the advert timestamp, not our ingest time', async () => {
    // A replayed or delayed publish must not make a silent node look freshly
    // heard — the same failure class as the Meshtastic PhoneAPI replay (#5034).
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`,
      body(advertFrame({ timestamp: 1_600_000_000, name: 'Old' })));
    await settle();

    expect(upsertNode.mock.calls[0][0].lastHeard).toBe(1_600_000_000_000);
  });

  it('caps a FUTURE advert timestamp at now', async () => {
    // The timestamp is attacker-controlled in both directions. Uncapped, a
    // forged future claim parks the node at the top of every "last heard" sort
    // indefinitely, and no later genuine reception can displace it.
    const before = Date.now();
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`,
      body(advertFrame({ timestamp: 4_000_000_000, name: 'FromTheFuture' })));
    await settle();

    const stamped = upsertNode.mock.calls[0][0].lastHeard as number;
    expect(stamped).toBeLessThanOrEqual(Date.now());
    expect(stamped).toBeGreaterThanOrEqual(before);
  });

  it('omits name rather than nulling it when the advert carries none', async () => {
    // upsertNode treats undefined as "not observed" and PRESERVES the stored
    // value; null would clobber a good name with nothing.
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(advertFrame({})));
    await settle();

    expect(upsertNode.mock.calls[0][0].name).toBeUndefined();
  });

  it('omits position (and its provenance tag) when the advert has no location', async () => {
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(advertFrame({ name: 'NoFix' })));
    await settle();

    const node = upsertNode.mock.calls[0][0];
    expect(node.latitude).toBeUndefined();
    expect(node.positionSource).toBeUndefined();
  });

  it("tags an advert position as 'contact' so a telemetry fix keeps precedence", async () => {
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`,
      body(advertFrame({ lat: 1.5, lon: 2.5 })));
    await settle();

    expect(upsertNode.mock.calls[0][0].positionSource).toBe('contact');
  });

  it('ingests an advert regardless of signature validity — decoded, not enforced', async () => {
    // Deliberate (#5040): the signature bytes here are filler, and the node is
    // still created. `appDataHex` exists so a caller CAN verify; ingest does not.
    await started();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`,
      body(advertFrame({ name: 'Unsigned' })));
    await settle();

    expect(upsertNode).toHaveBeenCalledTimes(1);
  });

  it('ignores non-ADVERT frames', async () => {
    const mgr = await started();
    // A plain FLOOD text frame: header, path_len 0, payload.
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body('0500deadbeef'));
    await settle();

    expect(upsertNode).not.toHaveBeenCalled();
    expect(mgr.getIngestStats().advertsIngested).toBe(0);
  });

  it('survives a node-write failure without breaking the stream', async () => {
    upsertNode.mockRejectedValueOnce(new Error('db down'));
    const mgr = await started();

    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(advertFrame({ name: 'A' })));
    await settle();
    lastClient!.deliver(`meshcore/MCO/${OBSERVER}/packets`, body(advertFrame({ name: 'B' })));
    await settle();

    expect(upsertNode).toHaveBeenCalledTimes(2);
    // The packet itself still counted both times — node ingest is a side path.
    expect(mgr.getIngestStats().accepted).toBe(2);
  });
});

describe('advertLastHeardMs', () => {
  const NOW = 1_700_000_000_000;

  it('passes a past timestamp through, in milliseconds', () => {
    expect(advertLastHeardMs(1_600_000_000, NOW)).toBe(1_600_000_000_000);
  });

  it('clamps a future timestamp to now', () => {
    expect(advertLastHeardMs(4_000_000_000, NOW)).toBe(NOW);
  });

  it('treats the boundary as not-future', () => {
    expect(advertLastHeardMs(NOW / 1000, NOW)).toBe(NOW);
  });

  it('returns undefined for absent or nonsense values', () => {
    // undefined (not 0) so upsertNode PRESERVES any stored lastHeard rather
    // than overwriting it with the epoch.
    expect(advertLastHeardMs(0, NOW)).toBeUndefined();
    expect(advertLastHeardMs(-1, NOW)).toBeUndefined();
    expect(advertLastHeardMs(Number.NaN, NOW)).toBeUndefined();
  });
});
