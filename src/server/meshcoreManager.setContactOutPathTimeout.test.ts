/**
 * Regression tests for MeshCoreManager.setContactOutPath's lost-ack handling (#4625).
 *
 * meshcore.js resolves CMD_ADD_UPDATE_CONTACT on the device's Ok ack, but that ack
 * is frequently lost in radio chatter even though the device applied the write.
 * Previously a lost ack (bridge command timeout) was reported straight to the
 * caller as failure, which surfaced to the UI as "Set out_path failed — the
 * device did not respond in time" (issue #4625) even when the path had actually
 * been written. setContactOutPath now re-reads the contact via get_contacts on a
 * timeout and only reports failure if the device-side path still doesn't match
 * what was sent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const getNodesBySource = vi.fn().mockResolvedValue([]);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
      getNodesBySource: (...args: unknown[]) => getNodesBySource(...args),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: new Proxy({}, { get: () => vi.fn() }),
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const TARGET_KEY = 'a'.repeat(64);
const TIMEOUT_ERROR = 'Native command timeout: set_out_path';

function makeManager(): MeshCoreManager {
  const m = new MeshCoreManager('src-a');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  return m;
}

describe('MeshCoreManager.setContactOutPath — lost-ack verification (#4625)', () => {
  beforeEach(() => {
    upsertNode.mockClear();
    getNodesBySource.mockClear();
  });

  it('reports success when the ack times out but get_contacts confirms the path was applied', async () => {
    const m = makeManager();
    (m as any).sendBridgeCommand = vi.fn(async (cmd: string) => {
      if (cmd === 'set_out_path') return { id: '1', success: false, error: TIMEOUT_ERROR };
      if (cmd === 'get_contacts') {
        return {
          id: '1',
          success: true,
          data: [{ public_key: TARGET_KEY, adv_name: 'Repeater', out_path: 'a3,7f,02', path_len: 3 }],
        };
      }
      return { id: '1', success: true, data: {} };
    });

    const ok = await m.setContactOutPath(TARGET_KEY, Uint8Array.from([0xa3, 0x7f, 0x02]), 1);

    expect(ok).toBe(true);
    expect(m.getContact(TARGET_KEY)?.outPath).toBe('a3,7f,02');
  });

  it('reports failure when the ack times out and get_contacts shows the path was never applied', async () => {
    const m = makeManager();
    (m as any).sendBridgeCommand = vi.fn(async (cmd: string) => {
      if (cmd === 'set_out_path') return { id: '1', success: false, error: TIMEOUT_ERROR };
      if (cmd === 'get_contacts') {
        return {
          id: '1',
          success: true,
          // Device still reports the old (empty) path — the write did not land.
          data: [{ public_key: TARGET_KEY, adv_name: 'Repeater', out_path: '', path_len: 0 }],
        };
      }
      return { id: '1', success: true, data: {} };
    });

    const ok = await m.setContactOutPath(TARGET_KEY, Uint8Array.from([0xa3, 0x7f, 0x02]), 1);

    expect(ok).toBe(false);
  });

  it('returns false without calling get_contacts when the device explicitly rejects (non-timeout)', async () => {
    const m = makeManager();
    const calls: string[] = [];
    (m as any).sendBridgeCommand = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'set_out_path') return { id: '1', success: false, error: 'Device rejected write' };
      return { id: '1', success: true, data: {} };
    });

    const ok = await m.setContactOutPath(TARGET_KEY, Uint8Array.from([0xa3]), 1);

    expect(ok).toBe(false);
    expect(calls).toEqual(['set_out_path']);
  });
});
