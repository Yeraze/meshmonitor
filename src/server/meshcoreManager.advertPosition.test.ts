/**
 * #5578: the companion path records whether a node's LATEST advert carried a
 * position, without losing the stored coordinates.
 *
 * The firmware keeps a stored contact's old coordinates when a later advert
 * has none (BaseChatMesh::onAdvertRecv only writes gps_lat/gps_lon when the
 * advert has them), and the 0x80 "advert" push carries the public key alone.
 * So the raw advert frame (LogRxData, which precedes the push) is the evidence;
 * a full NewAdvert payload (0x8A) is the fallback; a device contact record
 * with no coordinates is a known "never had one".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
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
    emitNodeDiscovered: vi.fn(),
    emitMeshCoreNodeChanged: vi.fn(),
  },
}));

vi.mock('./utils/coverageMeshCore.js', () => ({
  maybeRecordMeshCoreCoverageReception: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: { notifyNewMeshCoreNode: vi.fn().mockResolvedValue(undefined) },
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { buildAdvertFrame } from './test-helpers/meshcoreFrames.js';

const KEY = 'ab'.repeat(32);
const SOURCE = 'src-mc';

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

/** Raw advert frame (LogRxData) then the firmware's push, as on the wire. */
function hearAdvert(
  m: MeshCoreManager,
  frame: { lat?: number; lon?: number; timestamp?: number },
  push: Record<string, unknown> = {},
  eventType: 'contact_advertised' | 'contact_added' = 'contact_advertised',
): void {
  const raw = buildAdvertFrame({ publicKey: KEY, name: 'Hilltop', advType: 2, ...frame });
  dispatch(m, 'ota_packet', { payload_type: 4, raw_hex: raw });
  dispatch(m, eventType, { public_key: KEY, ...push });
}

/** The `lastAdvertHadPosition` values persistContact wrote, in order. */
const writtenFlags = (): unknown[] => upsertNode.mock.calls.map((c) => (c[0] as any).lastAdvertHadPosition);
const lastWrite = (): any => upsertNode.mock.calls[upsertNode.mock.calls.length - 1][0];

describe('MeshCoreManager latest-advert position flag (#5578)', () => {
  beforeEach(() => {
    upsertNode.mockClear();
    deviceContacts = [];
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes true when the raw advert frame carries a position', async () => {
    const m = makeManager();
    hearAdvert(m, { lat: 45.5, lon: -75.5 });
    await vi.waitFor(() => expect(upsertNode).toHaveBeenCalled());
    expect(lastWrite().lastAdvertHadPosition).toBe(true);
  });

  it('writes false when a later raw advert has no position, and never nulls the stored coordinates', async () => {
    const m = makeManager();
    hearAdvert(m, { lat: 45.5, lon: -75.5 }, { latitude: 45.5, longitude: -75.5 }, 'contact_added');
    hearAdvert(m, { timestamp: 1_700_000_100 });
    await vi.waitFor(() => expect(upsertNode).toHaveBeenCalledTimes(2));
    expect(writtenFlags()).toEqual([true, false]);
    // The in-memory contact (and so the write) still holds the last known fix.
    expect(lastWrite().latitude).toBeCloseTo(45.5);
    expect(lastWrite().longitude).toBeCloseTo(-75.5);
    expect(m.getContact(KEY)?.lastAdvertHadPosition).toBe(false);
    expect(m.getContact(KEY)?.latitude).toBeCloseTo(45.5);
  });

  it('treats a raw advert carrying 0/0 as no position', async () => {
    const m = makeManager();
    hearAdvert(m, { lat: 0, lon: 0 });
    await vi.waitFor(() => expect(upsertNode).toHaveBeenCalled());
    expect(lastWrite().lastAdvertHadPosition).toBe(false);
  });

  it('a key-only 0x80 push with no raw frame says nothing: the flag is left unwritten', async () => {
    const m = makeManager();
    dispatch(m, 'contact_advertised', { public_key: KEY });
    await vi.waitFor(() => expect(upsertNode).toHaveBeenCalled());
    expect(lastWrite().lastAdvertHadPosition).toBeUndefined();
  });

  it('a key-only push keeps a flag learned from an earlier raw frame', async () => {
    const m = makeManager();
    hearAdvert(m, {});
    dispatch(m, 'contact_advertised', { public_key: KEY });
    await vi.waitFor(() => expect(upsertNode).toHaveBeenCalledTimes(2));
    expect(writtenFlags()).toEqual([false, false]);
  });

  it('falls back to a full NewAdvert (0x8A) payload when no raw frame preceded it', async () => {
    const m = makeManager();
    dispatch(m, 'contact_added', { public_key: KEY, adv_name: 'Hilltop', adv_type: 2 });
    dispatch(m, 'contact_added', { public_key: KEY, adv_name: 'Hilltop', adv_type: 2, latitude: 10, longitude: 20 });
    await vi.waitFor(() => expect(upsertNode).toHaveBeenCalledTimes(2));
    expect(writtenFlags()).toEqual([false, true]);
  });

  it('contact sync: a device record with no coordinates is a known false', async () => {
    const m = makeManager();
    deviceContacts = [{ public_key: KEY, adv_name: 'Hilltop', adv_type: 2 }];
    await m.refreshContacts();
    expect(upsertNode).toHaveBeenCalledTimes(1);
    expect(lastWrite().lastAdvertHadPosition).toBe(false);
  });

  it('contact sync: a device record WITH coordinates proves nothing, so the flag is not written', async () => {
    const m = makeManager();
    deviceContacts = [{ public_key: KEY, adv_name: 'Hilltop', adv_type: 2, latitude: 45.5, longitude: -75.5 }];
    await m.refreshContacts();
    expect(lastWrite().lastAdvertHadPosition).toBeUndefined();
    expect(lastWrite().latitude).toBeCloseTo(45.5);
  });

  it('contact sync keeps a false learned from a raw advert even though the device still reports the old fix', async () => {
    const m = makeManager();
    hearAdvert(m, {});
    await vi.waitFor(() => expect(upsertNode).toHaveBeenCalledTimes(1));
    // Firmware kept the earlier coordinates on its stored contact.
    deviceContacts = [{ public_key: KEY, adv_name: 'Hilltop', adv_type: 2, latitude: 45.5, longitude: -75.5 }];
    await m.refreshContacts();
    expect(lastWrite().lastAdvertHadPosition).toBe(false);
    expect(lastWrite().latitude).toBeCloseTo(45.5);
  });

  it('getAllNodes exposes the stored flag and position source', async () => {
    const db = (await import('../services/database.js')).default as any;
    db.meshcore.getNodesBySource.mockResolvedValueOnce([
      { publicKey: KEY, name: 'Hilltop', advType: 2, latitude: 45.5, longitude: -75.5, positionSource: 'contact', lastAdvertHadPosition: false },
      { publicKey: 'cd'.repeat(32), name: 'Tracker', advType: 1, latitude: 46, longitude: -76, positionSource: 'telemetry', lastAdvertHadPosition: false },
      { publicKey: 'ef'.repeat(32), name: 'Old', advType: 1, latitude: 47, longitude: -77, positionSource: null, lastAdvertHadPosition: null },
    ]);
    const nodes = await makeManager().getAllNodes();
    const byName = new Map(nodes.map((n) => [n.name, n]));
    expect(byName.get('Hilltop')).toMatchObject({ lastAdvertHadPosition: false, positionSource: 'contact', latitude: 45.5 });
    expect(byName.get('Tracker')).toMatchObject({ lastAdvertHadPosition: false, positionSource: 'telemetry' });
    expect(byName.get('Old')?.lastAdvertHadPosition).toBeUndefined();
  });
});
