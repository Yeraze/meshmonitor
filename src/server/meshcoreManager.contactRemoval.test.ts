/**
 * Tests for MeshCore contact removal + the resurrection guard (issue #3878).
 *
 * A room server that no longer exists on the network can linger on the
 * companion's saved-contact list. Deleting it from MeshMonitor used to be
 * undone by the next advert-triggered / reconnect `get_contacts` sync, which
 * re-`persistContact`s every device contact — so "Remove" appeared to do
 * nothing. Removal now tombstones the key so re-sync can't resurrect the row,
 * and a live advert (or the TTL) lifts the tombstone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const deleteNode = vi.fn().mockResolvedValue(true);
const getSource = vi.fn().mockResolvedValue({ name: 'Source A' });

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
      deleteNode: (...args: unknown[]) => deleteNode(...args),
    },
    sources: {
      getSource: (...args: unknown[]) => getSource(...args),
    },
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: { notifyNewMeshCoreNode: vi.fn().mockResolvedValue(undefined) },
}));

const emitMeshCoreContactUpdated = vi.fn();
vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: (...args: unknown[]) => emitMeshCoreContactUpdated(...args),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
  },
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const flush = () => Promise.resolve().then(() => Promise.resolve());

function advertise(m: MeshCoreManager, publicKey: string): void {
  // @ts-expect-error - exercising the private bridge-event path
  m.handleBridgeEvent({
    event_type: 'contact_advertised',
    data: { public_key: publicKey, adv_name: 'Room1', adv_type: MeshCoreDeviceType.ROOM_SERVER },
  });
}

/** Simulate the get_contacts bulk re-sync's per-contact persist. */
async function resyncPersist(m: MeshCoreManager, publicKey: string): Promise<void> {
  // @ts-expect-error - persistContact is private; the bulk refresh calls it per contact
  await m.persistContact({ publicKey, advName: 'Room1', advType: MeshCoreDeviceType.ROOM_SERVER });
}

describe('MeshCore contact removal + resurrection guard (#3878)', () => {
  const PUBKEY = 'c2' + 'a'.repeat(62);

  beforeEach(() => {
    upsertNode.mockClear();
    deleteNode.mockClear();
    deleteNode.mockResolvedValue(true);
    emitMeshCoreContactUpdated.mockClear();
  });

  it('forgetLocalContact tombstones the key so a re-sync cannot resurrect it', async () => {
    const manager = new MeshCoreManager('src-a');

    const ok = await manager.forgetLocalContact(PUBKEY);
    expect(ok).toBe(true);
    expect(deleteNode).toHaveBeenCalledWith(PUBKEY, 'src-a');

    // The lingering device contact comes back in the next get_contacts sync —
    // persistContact must NOT re-insert it while the tombstone holds.
    await resyncPersist(manager, PUBKEY);
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('a live advert lifts the tombstone so the node syncs again', async () => {
    const manager = new MeshCoreManager('src-a');
    await manager.forgetLocalContact(PUBKEY);

    // Suppressed…
    await resyncPersist(manager, PUBKEY);
    expect(upsertNode).not.toHaveBeenCalled();

    // …until a genuine advert proves the node is back.
    advertise(manager, PUBKEY);
    await flush();
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: PUBKEY }),
      'src-a',
    );
  });

  it('forgetLocalContact returns false and emits nothing for a key that matched neither a row nor memory', async () => {
    const manager = new MeshCoreManager('src-a');
    deleteNode.mockResolvedValue(false); // no stored row
    const ok = await manager.forgetLocalContact('deadbeef'.repeat(8));
    expect(ok).toBe(false);
    // A genuine no-op must not fire the removed-contact push — the UI would
    // otherwise flicker (node vanishes then reappears on the next poll).
    expect(emitMeshCoreContactUpdated).not.toHaveBeenCalled();
  });

  it('forgetLocalContact returns true when only an in-memory contact existed', async () => {
    const manager = new MeshCoreManager('src-a');
    advertise(manager, PUBKEY); // populate in-memory contact
    await flush();
    upsertNode.mockClear();
    deleteNode.mockResolvedValue(false); // nothing persisted yet

    const ok = await manager.forgetLocalContact(PUBKEY);
    expect(ok).toBe(true);
  });
});
