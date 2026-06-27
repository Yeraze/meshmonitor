/**
 * Tests for MeshCoreManager.fetchOwnerName (#3820).
 *
 * A NODE_DISCOVER_RESP carries no name and a zero-hop repeater may not advert
 * for a long time, so a freshly "discovered" repeater would otherwise stay
 * "Unknown". fetchOwnerName actively pulls the name without admin login via an
 * ANON_REQ OWNER (CMD_SEND_ANON_REQ sub-type 0x02). The firmware OWNER branch
 * only answers a DIRECT-routed request, so we install a zero-hop direct out_path
 * (set_out_path) first, then issue request_owner, then write the name onto the
 * contact.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const emitMeshCoreContactUpdated = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: (...args: unknown[]) => emitMeshCoreContactUpdated(...args),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
  },
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const REPEATER_KEY = 'd'.repeat(64);

function makeCompanionManager(ownerResp: { success: boolean; data?: { name?: string } }): {
  manager: MeshCoreManager;
  calls: Array<{ cmd: string; params: Record<string, unknown> }>;
} {
  const m = new MeshCoreManager('src-a');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true; // setContactOutPath requires a live connection
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];

  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    if (cmd === 'set_out_path') return { id: '1', success: true, data: {} };
    if (cmd === 'request_owner') return { id: '1', ...ownerResp };
    return { id: '1', success: true, data: {} };
  };

  return { manager: m, calls };
}

describe('MeshCoreManager.fetchOwnerName (#3820)', () => {
  beforeEach(() => {
    upsertNode.mockClear();
    emitMeshCoreContactUpdated.mockClear();
  });

  it('installs a direct out_path, requests the owner, and applies the name', async () => {
    const { manager, calls } = makeCompanionManager({ success: true, data: { name: 'Yeraze Repeater' } });
    // Discovery pre-created a nameless repeater stub.
    (manager as any).contacts.set(REPEATER_KEY, { publicKey: REPEATER_KEY, advType: MeshCoreDeviceType.REPEATER });

    const name = await manager.fetchOwnerName(REPEATER_KEY);

    expect(name).toBe('Yeraze Repeater');
    // Direct route installed BEFORE the anon request (firmware gates OWNER on isRouteDirect).
    const order = calls.map(c => c.cmd);
    expect(order.indexOf('set_out_path')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('request_owner')).toBeGreaterThan(order.indexOf('set_out_path'));
    // Name written onto the contact and broadcast.
    expect(manager.getContact(REPEATER_KEY)?.advName).toBe('Yeraze Repeater');
    expect(emitMeshCoreContactUpdated).toHaveBeenCalled();
  });

  it('leaves the contact unnamed and does not throw when the owner request fails', async () => {
    const { manager } = makeCompanionManager({ success: false });
    (manager as any).contacts.set(REPEATER_KEY, { publicKey: REPEATER_KEY, advType: MeshCoreDeviceType.REPEATER });

    const name = await manager.fetchOwnerName(REPEATER_KEY);

    expect(name).toBeNull();
    expect(manager.getContact(REPEATER_KEY)?.advName).toBeUndefined();
  });

  it('returns null for a non-companion device (only companions run discovery)', async () => {
    const { manager, calls } = makeCompanionManager({ success: true, data: { name: 'X' } });
    (manager as any).deviceType = MeshCoreDeviceType.REPEATER;

    const name = await manager.fetchOwnerName(REPEATER_KEY);

    expect(name).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
