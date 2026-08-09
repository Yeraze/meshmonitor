/**
 * Regression guard for the ack-timeout pivot in `setContactOutPath` (#4625).
 *
 * The whole fix hinges on ONE string test:
 *
 *   const ackTimedOut = !response.success && !!response.error?.includes('timeout');
 *
 * Get that wrong and a write that landed is reported as a failure again —
 * which is exactly the bug #4625 describes. Two independent producers feed it,
 * and neither is under this file's control:
 *
 *   1. meshcore.js rejects with the BARE STRING `"timeout"` (not an Error).
 *      `meshcoreNativeBackend.sendCommand` stringifies it, so `error` is
 *      literally `"timeout"`.
 *   2. Our own `withTimeout` wrapper in `meshcoreNativeBackend.ts` rejects with
 *      `` new Error(`Native command timeout: ${label}`) ``.
 *
 * Both happen to contain lowercase "timeout" today. `includes()` is
 * case-sensitive, so a future reword to "Timed out" or "TIMEOUT" on either side
 * would silently drop the write back into the rejected branch. These tests pin
 * both wordings so that reword fails here instead of in the field.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
  },
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const TARGET_KEY = 'c'.repeat(64);

/** One 1-byte hop, 0xa3 — mirrors to the outPath string "a3". */
const ONE_HOP = Uint8Array.from([0xa3]);

/** A connected companion whose `set_out_path` returns exactly `response`. */
function managerReturning(response: { success: boolean; error?: string; data?: unknown }): MeshCoreManager {
  const m = new MeshCoreManager('src-a');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).contacts.set(TARGET_KEY, { publicKey: TARGET_KEY, advType: MeshCoreDeviceType.REPEATER });
  (m as any).sendBridgeCommand = async (cmd: string) => (
    cmd === 'set_out_path' ? { id: '1', ...response } : { id: '1', success: true, data: {} }
  );
  return m;
}

describe('setContactOutPath ack classification (#4625)', () => {
  it('treats meshcore.js\'s bare "timeout" rejection as applied-but-unconfirmed', async () => {
    // The library does `reject("timeout")` with a plain string; the backend
    // stringifies it verbatim. This is the real-world #4625 path.
    const m = managerReturning({ success: false, error: 'timeout' });

    const result = await m.setContactOutPath(TARGET_KEY, ONE_HOP);

    expect(result.applied).toBe(true);
    expect(result.ackConfirmed).toBe(false);
  });

  it('treats our own "Native command timeout" wrapper the same way', async () => {
    const m = managerReturning({ success: false, error: 'Native command timeout: set_out_path' });

    const result = await m.setContactOutPath(TARGET_KEY, ONE_HOP);

    expect(result.applied).toBe(true);
    expect(result.ackConfirmed).toBe(false);
  });

  it('mirrors the new path locally when the ack is missing', async () => {
    // The second half of #4625: returning early on timeout left the contact
    // showing the OLD path, so the user saw a failure AND no change. The
    // optimistic mirror is what makes the retry-looks-broken symptom go away.
    const m = managerReturning({ success: false, error: 'timeout' });

    await m.setContactOutPath(TARGET_KEY, Uint8Array.from([0xa3, 0xb7]));

    expect(m.getContact(TARGET_KEY)?.outPath).toBe('a3,b7');
  });

  it('still reports a genuine rejection as not-applied', async () => {
    // The 409 must survive: a truly dead or refusing device cannot be
    // laundered into a success by the timeout branch.
    const m = managerReturning({ success: false, error: 'Set-out-path target not in device contact list' });

    const result = await m.setContactOutPath(TARGET_KEY, ONE_HOP);

    expect(result.applied).toBe(false);
    expect(result.ackConfirmed).toBe(false);
  });

  it('reports a clean ack as confirmed', async () => {
    const m = managerReturning({ success: true, data: {} });

    const result = await m.setContactOutPath(TARGET_KEY, ONE_HOP);

    expect(result.applied).toBe(true);
    expect(result.ackConfirmed).toBe(true);
  });
});
