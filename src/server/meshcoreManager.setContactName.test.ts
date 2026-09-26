/**
 * Tests for MeshCoreManager.setContactName() (#5350).
 *
 * The Virtual Node's AddUpdateContact relay renames a contact through this
 * method. It wraps the `set_contact_name` bridge command and, on success,
 * mirrors the new name into the in-memory contact so the UI and the next VN
 * GetContacts see it without waiting for a device re-sync.
 *
 * Uses the private-method-stubbing pattern from meshcoreManager.shareContact.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: { upsertNode: vi.fn().mockResolvedValue(undefined) },
  },
}));

const PK = 'b1'.repeat(32);

function makeManager(opts: {
  deviceType?: MeshCoreDeviceType;
  connected?: boolean;
  response?: { success: boolean; data?: unknown; error?: string };
}) {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = opts.deviceType ?? MeshCoreDeviceType.COMPANION;
  (m as any).connected = opts.connected ?? true;
  (m as any).persistContact = vi.fn().mockResolvedValue(undefined);
  (m as any).contacts.set(PK, { publicKey: PK, advName: 'Old', name: 'Old' });
  const bridgeCalls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    return { id: '1', ...(opts.response ?? { success: true, data: { ok: true } }) };
  };
  return { manager: m, bridgeCalls };
}

describe('MeshCoreManager — setContactName (#5350)', () => {
  it('issues set_contact_name and mirrors the new name locally', async () => {
    const { manager, bridgeCalls } = makeManager({});
    const updated = vi.fn();
    manager.on('contacts_updated', updated);

    expect(await manager.setContactName(PK, 'North Hill')).toBe(true);
    expect(bridgeCalls).toEqual([{ cmd: 'set_contact_name', params: { public_key: PK, name: 'North Hill' } }]);
    const contact = manager.getContacts().find((c) => c.publicKey === PK);
    expect(contact).toEqual(expect.objectContaining({ advName: 'North Hill', name: 'North Hill' }));
    expect((manager as any).persistContact).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
  });

  it('returns false and leaves the contact alone when the device refuses', async () => {
    const { manager } = makeManager({ response: { success: false, error: 'not confirmed' } });
    expect(await manager.setContactName(PK, 'North Hill')).toBe(false);
    expect(manager.getContacts().find((c) => c.publicKey === PK)?.advName).toBe('Old');
  });

  it('short-circuits for a non-Companion or disconnected source', async () => {
    const repeater = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
    expect(await repeater.manager.setContactName(PK, 'x')).toBe(false);
    expect(repeater.bridgeCalls).toHaveLength(0);

    const offline = makeManager({ connected: false });
    expect(await offline.manager.setContactName(PK, 'x')).toBe(false);
    expect(offline.bridgeCalls).toHaveLength(0);
  });
});
