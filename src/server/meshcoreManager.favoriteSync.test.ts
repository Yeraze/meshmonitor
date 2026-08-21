/**
 * Tests for MeshCore favourite ↔ device synchronisation (#4838/#4840 follow-up).
 *
 * MeshMonitor's ⭐ used to be a local-only `meshcore_nodes.isFavorite` column
 * that never touched the device, so a favourited contact was NOT protected from
 * the companion firmware's contact-table eviction (the firmware only skips
 * contacts whose `ContactInfo.flags` bit 0 is set). These tests cover the sync
 * that now writes that firmware favourite bit:
 *
 * - `setNodeFavorite` persists the local column AND pushes the firmware bit
 *   (companion + connected only, best-effort).
 * - `reconcileDeviceFavorites` mirrors device→app (additive) and re-asserts
 *   app→device (self-healing) so app favourites survive eviction/re-add.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getNodesBySource = vi.fn();
const dbSetNodeFavorite = vi.fn();
vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      getNodesBySource: (...args: unknown[]) => getNodesBySource(...args),
      setNodeFavorite: (...args: unknown[]) => dbSetNodeFavorite(...args),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
    emitMeshCoreStatusUpdated: vi.fn(),
  },
}));

import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreContact } from './meshcoreManager.js';

type Private = {
  deviceType: MeshCoreDeviceType;
  connected: boolean;
  contacts: Map<string, MeshCoreContact>;
  sendBridgeCommand: (cmd: string, params: Record<string, unknown>) => Promise<unknown>;
  reconcileDeviceFavorites(): Promise<void>;
};

const asPrivate = (m: MeshCoreManager) => m as unknown as Private;

const makeCompanion = (connected = true) => {
  const m = new MeshCoreManager('src-a');
  const p = asPrivate(m);
  p.deviceType = MeshCoreDeviceType.COMPANION;
  p.connected = connected;
  const bridge = vi.fn().mockResolvedValue({ success: true, data: { favorite: true } });
  p.sendBridgeCommand = bridge as unknown as Private['sendBridgeCommand'];
  return { m, p, bridge };
};

const dbNode = (publicKey: string, isFavorite: boolean) => ({
  publicKey,
  name: 'N',
  advType: MeshCoreDeviceType.REPEATER,
  isLocalNode: false,
  isFavorite,
});

const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);

describe('MeshCoreManager favourite ↔ device sync', () => {
  beforeEach(() => {
    getNodesBySource.mockReset();
    dbSetNodeFavorite.mockReset();
    dbSetNodeFavorite.mockResolvedValue(undefined);
    getNodesBySource.mockResolvedValue([]);
  });

  describe('setNodeFavorite', () => {
    it('persists the local column and pushes the firmware bit (companion, connected)', async () => {
      const { m, bridge } = makeCompanion(true);
      await m.setNodeFavorite(KEY_A, true);

      expect(dbSetNodeFavorite).toHaveBeenCalledWith('src-a', KEY_A, true);
      expect(bridge).toHaveBeenCalledWith('set_contact_favorite', { public_key: KEY_A, favorite: true });
    });

    it('un-favourite pushes favorite:false to the device', async () => {
      const { m, bridge } = makeCompanion(true);
      await m.setNodeFavorite(KEY_A, false);

      expect(dbSetNodeFavorite).toHaveBeenCalledWith('src-a', KEY_A, false);
      expect(bridge).toHaveBeenCalledWith('set_contact_favorite', { public_key: KEY_A, favorite: false });
    });

    it('persists locally but does NOT push when disconnected', async () => {
      const { m, bridge } = makeCompanion(false);
      await m.setNodeFavorite(KEY_A, true);

      expect(dbSetNodeFavorite).toHaveBeenCalledWith('src-a', KEY_A, true);
      expect(bridge).not.toHaveBeenCalled();
    });

    it('persists locally but does NOT push for a repeater source', async () => {
      const { m, p, bridge } = makeCompanion(true);
      p.deviceType = MeshCoreDeviceType.REPEATER;
      await m.setNodeFavorite(KEY_A, true);

      expect(dbSetNodeFavorite).toHaveBeenCalledWith('src-a', KEY_A, true);
      expect(bridge).not.toHaveBeenCalled();
    });

    it('keeps the local star even when the device push fails', async () => {
      const { m, p } = makeCompanion(true);
      p.sendBridgeCommand = vi.fn().mockResolvedValue({ success: false, error: 'Favorite target not in device contact list' }) as unknown as Private['sendBridgeCommand'];
      await expect(m.setNodeFavorite(KEY_A, true)).resolves.toBeUndefined();
      expect(dbSetNodeFavorite).toHaveBeenCalledWith('src-a', KEY_A, true);
    });
  });

  describe('reconcileDeviceFavorites', () => {
    it('mirrors a device-side favourite into the local column (additive)', async () => {
      const { p, bridge } = makeCompanion(true);
      p.contacts.set(KEY_A, { publicKey: KEY_A, deviceFavorite: true });
      getNodesBySource.mockResolvedValue([dbNode(KEY_A, false)]);

      await p.reconcileDeviceFavorites();

      expect(dbSetNodeFavorite).toHaveBeenCalledWith('src-a', KEY_A, true);
      // Device already holds the bit — no redundant push.
      expect(bridge).not.toHaveBeenCalled();
    });

    it('re-asserts app favourites the device is missing in a single batch (self-healing)', async () => {
      const { p, bridge } = makeCompanion(true);
      p.contacts.set(KEY_A, { publicKey: KEY_A, deviceFavorite: false });
      p.contacts.set(KEY_B, { publicKey: KEY_B, deviceFavorite: false });
      getNodesBySource.mockResolvedValue([dbNode(KEY_A, true), dbNode(KEY_B, true)]);

      await p.reconcileDeviceFavorites();

      // One batched device read+write for both, not one round-trip per contact.
      expect(bridge).toHaveBeenCalledTimes(1);
      expect(bridge).toHaveBeenCalledWith('set_contacts_favorite', {
        favorites: [
          { public_key: KEY_A, favorite: true },
          { public_key: KEY_B, favorite: true },
        ],
      });
      // App favourites are already persisted — reconcile must not rewrite the column here.
      expect(dbSetNodeFavorite).not.toHaveBeenCalled();
    });

    it('does nothing when device and app agree', async () => {
      const { p, bridge } = makeCompanion(true);
      p.contacts.set(KEY_A, { publicKey: KEY_A, deviceFavorite: true });
      p.contacts.set(KEY_B, { publicKey: KEY_B, deviceFavorite: false });
      getNodesBySource.mockResolvedValue([dbNode(KEY_A, true), dbNode(KEY_B, false)]);

      await p.reconcileDeviceFavorites();

      expect(bridge).not.toHaveBeenCalled();
      expect(dbSetNodeFavorite).not.toHaveBeenCalled();
    });

    it('is a no-op for repeater sources', async () => {
      const { p, bridge } = makeCompanion(true);
      p.deviceType = MeshCoreDeviceType.REPEATER;
      p.contacts.set(KEY_A, { publicKey: KEY_A, deviceFavorite: true });

      await p.reconcileDeviceFavorites();

      expect(getNodesBySource).not.toHaveBeenCalled();
      expect(bridge).not.toHaveBeenCalled();
      expect(dbSetNodeFavorite).not.toHaveBeenCalled();
    });
  });
});
