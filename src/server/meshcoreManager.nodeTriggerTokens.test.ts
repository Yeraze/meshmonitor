/**
 * #5595: contact facts on the MeshCore node triggers, from wire-accurate
 * ADVERT frames.
 *
 *  - `hops` is the hop count of the advert frame that fired the trigger, read
 *    from its packed path_len byte (top 2 bits = hash width, bottom 6 = hops).
 *  - `hops` is absent when no advert frame fired it; the cached route length
 *    goes out separately as `routeHops` and never stands in for it.
 *  - `advType` and `lastHeard` (epoch ms) ride along.
 *  - None of this changes WHEN a trigger fires or how many fire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const emitNodeDiscovered = vi.fn();
const emitMeshCoreNodeChanged = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getNodeByPublicKeyAndSource: vi.fn().mockResolvedValue(null),
      getNodesBySource: vi.fn().mockResolvedValue([]),
    },
    sources: { getSource: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
    emitMeshCoreOtaPacket: vi.fn(),
    emitNodeDiscovered: (...args: unknown[]) => emitNodeDiscovered(...args),
    emitMeshCoreNodeChanged: (...args: unknown[]) => emitMeshCoreNodeChanged(...args),
  },
}));

vi.mock('./utils/coverageMeshCore.js', () => ({
  maybeRecordMeshCoreCoverageReception: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: { notifyNewMeshCoreNode: vi.fn().mockResolvedValue(undefined) },
}));

import { MeshCoreManager, MeshCoreDeviceType, meshCoreNodeTriggerPayload } from './meshcoreManager.js';
import { calculateMeshCorePacketHash } from './services/meshcoreObserverPacket.js';
import { decodeMeshCorePacket } from '../utils/meshcorePacketDecode.js';

const KEY = 'ab'.repeat(32);
const KEY_B = 'cd'.repeat(32);
const KEY_C = 'ef'.repeat(32);
const SOURCE = 'src-mc';
const NOW = 1_790_000_000_000;

const hex = (n: number) => n.toString(16).padStart(2, '0');

/**
 * A flood ADVERT frame as it appears on the air:
 *   header 0x11 (route FLOOD | payload ADVERT)
 *   path_len  — packed: ((hashBytes - 1) << 6) | hopCount
 *   path      — hopCount × hashBytes relay hashes
 *   payload   — pubkey[32] timestamp[4] signature[64] flags[1] name
 * `flags` 0x80 = "has name", low nibble = advert type.
 */
function advertFrame(
  pubkey: string,
  opts: { hops?: number; hashBytes?: 1 | 2 | 3; pathLenByte?: number; ts?: string; type?: number; name?: string } = {},
): string {
  const hops = opts.hops ?? 0;
  const hashBytes = opts.hashBytes ?? 1;
  const pathLen = opts.pathLenByte ?? (((hashBytes - 1) << 6) | hops);
  const path = opts.pathLenByte === undefined ? '5a'.repeat(hops * hashBytes) : '';
  const name = Buffer.from(opts.name ?? 'Hilltop', 'utf8').toString('hex');
  return '11' + hex(pathLen) + path + pubkey + (opts.ts ?? '01000000') + '00'.repeat(64) + hex(0x80 | (opts.type ?? 2)) + name;
}

let deviceContacts: Array<Record<string, unknown>> = [];

function makeManager(): MeshCoreManager {
  const m = new MeshCoreManager(SOURCE);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).correlateChannelEcho = vi.fn();
  (m as any).handleOtaPacket = vi.fn();
  (m as any).sendBridgeCommand = async (cmd: string) => {
    if (cmd === 'get_contacts') return { id: '1', success: true, data: deviceContacts };
    return { id: '1', success: true, data: {} };
  };
  (m as any).nodeTriggersReady = true;
  return m;
}

function dispatch(m: MeshCoreManager, event_type: string, data: Record<string, unknown>): void {
  (m as any).handleBridgeEvent({ event_type, data });
}

/** The raw frame (LogRxData) followed by the firmware's advert push. */
function hear(m: MeshCoreManager, raw: string, pubkey: string, push: Record<string, unknown>): string {
  dispatch(m, 'ota_packet', { payload_type: 4, raw_hex: raw });
  dispatch(m, 'contact_advertised', { public_key: pubkey, ...push });
  return calculateMeshCorePacketHash(raw);
}

beforeEach(() => {
  emitNodeDiscovered.mockClear();
  emitMeshCoreNodeChanged.mockClear();
  deviceContacts = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('advert frame fixture', () => {
  it('decodes as a real advert with the path it was built with', () => {
    const d = decodeMeshCorePacket(advertFrame(KEY, { hops: 3, hashBytes: 2, name: 'Hilltop', type: 2 }));
    expect(d?.payload.advert?.publicKey?.toLowerCase()).toBe(KEY);
    expect(d?.path.rawLen).toBe(0x43);
    expect(d?.path.hashSize).toBe(2);
    expect(d?.path.hopCount).toBe(3);
    expect(d?.path.hops).toEqual(['5a5a', '5a5a', '5a5a']);
  });
});

describe('trigger.nodeDiscovered payload (#5595)', () => {
  it('carries hops, type and last-heard for an advert heard direct', () => {
    const m = makeManager();
    const hash = hear(m, advertFrame(KEY), KEY, { adv_name: 'Hilltop', adv_type: 2 });
    expect(emitNodeDiscovered).toHaveBeenCalledTimes(1);
    expect(emitNodeDiscovered).toHaveBeenCalledWith(
      { nodeNum: null, publicKey: KEY, name: 'Hilltop', packetHash: hash, hops: 0, advType: 2, routeHops: undefined, lastHeard: NOW },
      SOURCE,
    );
  });

  // path_len packs the hash width in its top 2 bits. Read as a plain number
  // these three frames would report 3, 67 and 131 hops.
  it.each([
    [1, 0x03],
    [2, 0x43],
    [3, 0x83],
  ] as const)('reads 3 hops from a frame with %i-byte relay hashes (path_len 0x%s)', (hashBytes, pathLenByte) => {
    const m = makeManager();
    const raw = advertFrame(KEY, { hops: 3, hashBytes });
    expect(parseInt(raw.slice(2, 4), 16)).toBe(pathLenByte);
    hear(m, raw, KEY, { adv_name: 'Hilltop', adv_type: 2 });
    expect(emitNodeDiscovered.mock.calls[0][0].hops).toBe(3);
  });

  it('reads the largest hop count each width can carry', () => {
    for (const hashBytes of [1, 2, 3] as const) {
      emitNodeDiscovered.mockClear();
      const m = makeManager();
      hear(m, advertFrame(KEY, { hops: 63, hashBytes }), KEY, { adv_name: 'Hilltop', adv_type: 2 });
      expect(emitNodeDiscovered.mock.calls[0][0].hops).toBe(63);
    }
  });

  it('leaves hops unknown for the reserved 4-byte width and the 0xFF sentinel', () => {
    for (const pathLenByte of [0xc0, 0xff]) {
      emitNodeDiscovered.mockClear();
      const m = makeManager();
      const hash = hear(m, advertFrame(KEY, { pathLenByte }), KEY, { adv_name: 'Hilltop', adv_type: 2 });
      const d = emitNodeDiscovered.mock.calls[0][0];
      expect(d.hops).toBeUndefined();
      expect(d.packetHash).toBe(hash);
    }
  });

  it('has no hops when no raw advert frame preceded the push', () => {
    const m = makeManager();
    dispatch(m, 'contact_advertised', { public_key: KEY, adv_name: 'Hilltop', adv_type: 1 });
    const d = emitNodeDiscovered.mock.calls[0][0];
    expect(d.hops).toBeUndefined();
    expect(d.packetHash).toBeUndefined();
    expect(d.advType).toBe(1);
    expect(d.lastHeard).toBe(NOW);
  });

  it('a Discover reply is a discovery with a type but no hops', () => {
    const m = makeManager();
    dispatch(m, 'node_discovered', { public_key: KEY, adv_type: 4, snr: 5 });
    expect(emitNodeDiscovered).not.toHaveBeenCalled(); // nameless: waits
    hear(m, advertFrame(KEY, { hops: 2, type: 4 }), KEY, { adv_name: 'Probe', adv_type: 4 });
    expect(emitNodeDiscovered).toHaveBeenCalledTimes(1);
    const d = emitNodeDiscovered.mock.calls[0][0];
    // The sweep reply had no frame, so the naming advert's frame is the origin.
    expect(d).toMatchObject({ name: 'Probe', advType: 4, hops: 2 });
    expect(emitMeshCoreNodeChanged).not.toHaveBeenCalled();
  });

  it('a nameless first advert keeps ITS hash and hops when the name arrives later', () => {
    const m = makeManager();
    const firstHash = hear(m, advertFrame(KEY, { hops: 4, hashBytes: 2, name: '' }), KEY, {});
    expect(emitNodeDiscovered).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 1000);
    hear(m, advertFrame(KEY, { hops: 1, ts: '02000000' }), KEY, { adv_name: 'Late', adv_type: 2 });
    expect(emitNodeDiscovered).toHaveBeenCalledTimes(1);
    expect(emitNodeDiscovered.mock.calls[0][0]).toMatchObject({
      name: 'Late', packetHash: firstHash, hops: 4, advType: 2, lastHeard: NOW + 1000,
    });
  });
});

describe('trigger.nodeUpdated payload (#5595)', () => {
  it('carries the hops of the advert that changed the node, not the first one', () => {
    const m = makeManager();
    hear(m, advertFrame(KEY, { hops: 5 }), KEY, { adv_name: 'Hilltop', adv_type: 2 });
    vi.setSystemTime(NOW + 60_000);
    const hash2 = hear(m, advertFrame(KEY, { hops: 2, hashBytes: 3, ts: '02000000', name: 'Renamed' }), KEY, {
      adv_name: 'Renamed', adv_type: 2,
    });
    expect(emitMeshCoreNodeChanged).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreNodeChanged).toHaveBeenCalledWith(
      {
        publicKey: KEY, name: 'Renamed', changed: ['name'], packetHash: hash2,
        hops: 2, advType: 2, routeHops: undefined, lastHeard: NOW + 60_000,
      },
      SOURCE,
    );
  });

  it('a type change reports the new type', () => {
    const m = makeManager();
    hear(m, advertFrame(KEY, { type: 1 }), KEY, { adv_name: 'Hilltop', adv_type: 1 });
    hear(m, advertFrame(KEY, { type: 3, ts: '02000000' }), KEY, { adv_name: 'Hilltop', adv_type: 3 });
    expect(emitMeshCoreNodeChanged.mock.calls[0][0]).toMatchObject({ changed: ['advType'], advType: 3, hops: 0 });
  });

  it('a path discovery response has no hops; the stored route goes out as routeHops', () => {
    const m = makeManager();
    hear(m, advertFrame(KEY, { hops: 4 }), KEY, { adv_name: 'Hilltop', adv_type: 2 });
    dispatch(m, 'path_discovery_response', {
      pubkey_prefix: KEY.slice(0, 12), out_path_len: 2, out_path_hex: 'cd01', out_hash_size: 1,
    });
    expect(emitMeshCoreNodeChanged).toHaveBeenCalledTimes(1);
    const d = emitMeshCoreNodeChanged.mock.calls[0][0];
    expect(d.changed).toEqual(['outPath', 'pathLen']);
    expect(d.packetHash).toBeUndefined();
    expect(d.hops).toBeUndefined();
    expect(d.routeHops).toBe(2);
    expect(d.advType).toBe(2);
  });

  it('an advert that follows a path change reports both numbers, each its own', () => {
    const m = makeManager();
    hear(m, advertFrame(KEY), KEY, { adv_name: 'Hilltop', adv_type: 2 });
    dispatch(m, 'path_discovery_response', {
      pubkey_prefix: KEY.slice(0, 12), out_path_len: 2, out_path_hex: 'cd01', out_hash_size: 1,
    });
    emitMeshCoreNodeChanged.mockClear();
    hear(m, advertFrame(KEY, { hops: 6, ts: '02000000', name: 'Moved' }), KEY, { adv_name: 'Moved', adv_type: 2 });
    expect(emitMeshCoreNodeChanged.mock.calls[0][0]).toMatchObject({ hops: 6, routeHops: 2 });
  });
});

describe('meshCoreNodeTriggerPayload (#5595)', () => {
  it('never copies the cached route length into hops', () => {
    expect(meshCoreNodeTriggerPayload({ pathLen: 3, advType: 2, lastSeen: NOW }, undefined)).toEqual({
      packetHash: undefined, hops: undefined, advType: 2, routeHops: 3, lastHeard: NOW,
    });
  });

  it('drops an unknown route, a missing last-heard and a bad hop count', () => {
    expect(meshCoreNodeTriggerPayload({ pathLen: null }, { packetHash: 'H', hops: -1 })).toEqual({
      packetHash: 'H', hops: undefined, advType: undefined, routeHops: undefined, lastHeard: undefined,
    });
  });
});

/**
 * #5595 must not change when triggers fire or how many. This sequence fires
 * exactly 3 discoveries and 2 updates on the code before #5595 too.
 */
describe('trigger count for a fixed event sequence is unchanged (#5595)', () => {
  it('3 discoveries and 2 updates', () => {
    const m = makeManager();
    const push = { adv_name: 'Hilltop', adv_type: 2, latitude: 1, longitude: 2 };

    // 1. New named node → discovery.
    hear(m, advertFrame(KEY), KEY, push);
    // 2. Same advert again → nothing.
    hear(m, advertFrame(KEY, { ts: '02000000' }), KEY, push);
    // 3. Same node, different hop count and hash width, nothing else → nothing.
    hear(m, advertFrame(KEY, { hops: 5, hashBytes: 2, ts: '03000000' }), KEY, push);
    hear(m, advertFrame(KEY, { hops: 1, hashBytes: 3, ts: '04000000' }), KEY, push);
    // 4. It moved → update.
    hear(m, advertFrame(KEY, { hops: 2, ts: '05000000' }), KEY, { ...push, latitude: 1.5 });
    // 5. A push with no raw frame, nothing changed → nothing.
    dispatch(m, 'contact_advertised', { public_key: KEY, ...push, latitude: 1.5 });
    // 6. Route learned → update; the same route again → nothing.
    const route = { pubkey_prefix: KEY.slice(0, 12), out_path_len: 1, out_path_hex: 'cd', out_hash_size: 1 };
    dispatch(m, 'path_discovery_response', route);
    dispatch(m, 'path_discovery_response', route);
    // 7. Nameless node → waits; its name arrives → one discovery, no update.
    hear(m, advertFrame(KEY_B, { hops: 3, name: '' }), KEY_B, {});
    hear(m, advertFrame(KEY_B, { hops: 1, ts: '02000000', name: 'Late' }), KEY_B, { adv_name: 'Late', adv_type: 1 });
    // 8. Discover reply (no name) → waits; a named advert → one discovery.
    dispatch(m, 'node_discovered', { public_key: KEY_C, adv_type: 4, snr: 3 });
    hear(m, advertFrame(KEY_C, { type: 4, name: 'Probe' }), KEY_C, { adv_name: 'Probe', adv_type: 4 });
    // 9. A later advert from each, nothing changed → nothing.
    hear(m, advertFrame(KEY_B, { hops: 7, ts: '03000000', name: 'Late' }), KEY_B, { adv_name: 'Late', adv_type: 1 });
    hear(m, advertFrame(KEY_C, { hops: 7, ts: '02000000', type: 4, name: 'Probe' }), KEY_C, { adv_name: 'Probe', adv_type: 4 });

    expect(emitNodeDiscovered.mock.calls.map((c) => c[0].publicKey)).toEqual([KEY, KEY_B, KEY_C]);
    expect(emitMeshCoreNodeChanged.mock.calls.map((c) => c[0].changed)).toEqual([['latitude'], ['outPath', 'pathLen']]);
  });
});
