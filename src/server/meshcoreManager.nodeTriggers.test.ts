/**
 * #5534: MeshCore node automation triggers.
 *
 *  - A live advert from an unknown key → `node:discovered` (with the advert's
 *    packet hash, taken from the raw LogRxData frame that precedes the push).
 *  - A known key whose name / position / type / path changed →
 *    `meshcore:node:changed`; a re-advert that changes nothing → nothing.
 *  - The connect-time contact sync, and adverts racing it, never fire.
 *  - A nameless first advert waits for the name, then fires discovery (not an
 *    update) with the first advert's hash.
 *  - Removing a contact and hearing it again is a fresh discovery.
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

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { calculateMeshCorePacketHash } from './services/meshcoreObserverPacket.js';

const KEY = 'ab'.repeat(32);
const SOURCE = 'src-mc';

/** A minimal flood ADVERT frame from `pubkey`: header 0x11, path_len 0, 101-byte payload. */
function advertFrame(pubkey: string, ts = '01000000'): string {
  return '11' + '00' + pubkey + ts + '00'.repeat(64) + '81';
}

let deviceContacts: Array<Record<string, unknown>> = [];

function makeManager(ready = true): MeshCoreManager {
  const m = new MeshCoreManager(SOURCE);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).correlateChannelEcho = vi.fn();
  (m as any).handleOtaPacket = vi.fn();
  (m as any).sendBridgeCommand = async (cmd: string) => {
    if (cmd === 'get_contacts') return { id: '1', success: true, data: deviceContacts };
    return { id: '1', success: true, data: {} };
  };
  (m as any).nodeTriggersReady = ready;
  return m;
}

function dispatch(m: MeshCoreManager, event_type: string, data: Record<string, unknown>): void {
  (m as any).handleBridgeEvent({ event_type, data });
}

function hearAdvert(m: MeshCoreManager, pubkey: string, push: Record<string, unknown>, ts?: string): string {
  const raw = advertFrame(pubkey, ts);
  dispatch(m, 'ota_packet', { payload_type: 4, raw_hex: raw });
  dispatch(m, 'contact_advertised', { public_key: pubkey, ...push });
  return calculateMeshCorePacketHash(raw);
}

describe('MeshCoreManager node triggers (#5534)', () => {
  beforeEach(() => {
    emitNodeDiscovered.mockClear();
    emitMeshCoreNodeChanged.mockClear();
    deviceContacts = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('fires node:discovered with the advert hash for an unknown key', () => {
    const m = makeManager();
    const hash = hearAdvert(m, KEY, { adv_name: 'Hilltop', adv_type: 2 });
    expect(hash).toMatch(/^[0-9A-F]{16}$/);
    expect(emitNodeDiscovered).toHaveBeenCalledTimes(1);
    expect(emitNodeDiscovered).toHaveBeenCalledWith(
      { nodeNum: null, publicKey: KEY, name: 'Hilltop', packetHash: hash },
      SOURCE,
    );
    expect(emitMeshCoreNodeChanged).not.toHaveBeenCalled();
  });

  it('leaves packetHash undefined when no raw advert frame preceded the push', () => {
    const m = makeManager();
    dispatch(m, 'contact_advertised', { public_key: KEY, adv_name: 'Hilltop', adv_type: 2 });
    expect(emitNodeDiscovered.mock.calls[0][0].packetHash).toBeUndefined();
  });

  it('a re-advert with nothing changed fires nothing', () => {
    const m = makeManager();
    hearAdvert(m, KEY, { adv_name: 'Hilltop', adv_type: 2, latitude: 1, longitude: 2 });
    emitNodeDiscovered.mockClear();
    hearAdvert(m, KEY, { adv_name: 'Hilltop', adv_type: 2, latitude: 1, longitude: 2, last_advert: 999 }, '02000000');
    expect(emitNodeDiscovered).not.toHaveBeenCalled();
    expect(emitMeshCoreNodeChanged).not.toHaveBeenCalled();
  });

  it('a re-advert that moves the node fires meshcore:node:changed with that advert\'s hash', () => {
    const m = makeManager();
    hearAdvert(m, KEY, { adv_name: 'Hilltop', adv_type: 2, latitude: 1, longitude: 2 });
    const hash2 = hearAdvert(m, KEY, { adv_name: 'Hilltop', adv_type: 2, latitude: 1.5, longitude: 2 }, '02000000');
    expect(emitMeshCoreNodeChanged).toHaveBeenCalledWith(
      { publicKey: KEY, name: 'Hilltop', changed: ['latitude'], packetHash: hash2 },
      SOURCE,
    );
  });

  it('a path discovery response that changes the route fires an update without a hash', () => {
    const m = makeManager();
    hearAdvert(m, KEY, { adv_name: 'Hilltop', adv_type: 2 });
    dispatch(m, 'path_discovery_response', {
      pubkey_prefix: KEY.slice(0, 12), out_path_len: 1, out_path_hex: 'cd', out_hash_size: 1,
    });
    expect(emitMeshCoreNodeChanged).toHaveBeenCalledTimes(1);
    const d = emitMeshCoreNodeChanged.mock.calls[0][0];
    expect(d.changed).toEqual(['outPath', 'pathLen']);
    expect(d.packetHash).toBeUndefined();
  });

  it('nothing fires before the connect-time contact sync has finished', () => {
    const m = makeManager(false);
    hearAdvert(m, KEY, { adv_name: 'Hilltop', adv_type: 2 });
    hearAdvert(m, KEY, { adv_name: 'Renamed', adv_type: 2 }, '02000000');
    expect(emitNodeDiscovered).not.toHaveBeenCalled();
    expect(emitMeshCoreNodeChanged).not.toHaveBeenCalled();
  });

  it('a contact-list sync (refreshContacts) never fires discovery', async () => {
    const m = makeManager();
    deviceContacts = [{ public_key: KEY, adv_name: 'Synced', adv_type: 1 }];
    await m.refreshContacts();
    expect(emitNodeDiscovered).not.toHaveBeenCalled();
    expect(emitMeshCoreNodeChanged).not.toHaveBeenCalled();
  });

  it('a nameless first advert waits for the name, then fires discovery (not update) with the first hash', async () => {
    const m = makeManager();
    const firstHash = hearAdvert(m, KEY, {});
    expect(emitNodeDiscovered).not.toHaveBeenCalled();

    // The debounced get_contacts re-read pulls the stored name.
    deviceContacts = [{ public_key: KEY, adv_name: 'Late Name', adv_type: 2 }];
    await vi.advanceTimersByTimeAsync(5000);

    expect(emitNodeDiscovered).toHaveBeenCalledTimes(1);
    expect(emitNodeDiscovered.mock.calls[0][0]).toMatchObject({ publicKey: KEY, name: 'Late Name', packetHash: firstHash });
    expect(emitMeshCoreNodeChanged).not.toHaveBeenCalled();
  });

  it('removing a contact and hearing it again is a fresh discovery', () => {
    const m = makeManager();
    hearAdvert(m, KEY, { adv_name: 'Hilltop', adv_type: 2 });
    (m as any).contacts.delete(KEY); // what removeContact does in memory
    hearAdvert(m, KEY, { adv_name: 'Hilltop', adv_type: 2 }, '03000000');
    expect(emitNodeDiscovered).toHaveBeenCalledTimes(2);
    expect(emitMeshCoreNodeChanged).not.toHaveBeenCalled();
  });

  it('a stale advert hash (older than the TTL) is not used', () => {
    const m = makeManager();
    dispatch(m, 'ota_packet', { payload_type: 4, raw_hex: advertFrame(KEY) });
    vi.advanceTimersByTime(60_000);
    dispatch(m, 'contact_advertised', { public_key: KEY, adv_name: 'Hilltop', adv_type: 2 });
    expect(emitNodeDiscovered.mock.calls[0][0].packetHash).toBeUndefined();
  });
});
