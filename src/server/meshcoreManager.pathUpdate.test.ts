/**
 * Tests for MeshCoreManager's debounced response to PUSH_CODE_PATH_UPDATED
 * (slice 4 of MeshCore path management).
 *
 * The push frame body is just the affected pubkey — the new path bytes
 * live on the contact record itself. meshcore.js doesn't expose
 * CMD_GET_CONTACT_BY_KEY yet, so the manager falls back to
 * refreshContacts() coalesced over a {@link PATH_REFRESH_DEBOUNCE_MS}
 * window so a chatty contact churning its route doesn't thunder the
 * device.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

interface BridgeEvent {
  event_type: string;
  data: Record<string, unknown>;
}

function dispatchBridgeEvent(m: MeshCoreManager, evt: BridgeEvent): void {
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent(evt);
}

function makeCompanionManager(): {
  manager: MeshCoreManager;
  bridgeCalls: Array<{ cmd: string; params: Record<string, unknown> }>;
  contactsResponse: { value: unknown };
} {
  const m = new MeshCoreManager('src-a');
  // Force device type so refreshContacts() doesn't short-circuit on the
  // "not Companion" branch.
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  const bridgeCalls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  const contactsResponse: { value: unknown } = {
    value: [
      {
        public_key: 'a'.repeat(64),
        adv_name: 'Bob',
        name: 'Bob',
        adv_type: MeshCoreDeviceType.COMPANION,
        latitude: 0,
        longitude: 0,
        last_advert: 0,
        out_path: 'a3,7f,02',
        path_len: 3,
      },
    ],
  };

  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'get_contacts') {
      return { id: '1', success: true, data: contactsResponse.value };
    }
    return { id: '1', success: true, data: {} };
  };

  return { manager: m, bridgeCalls, contactsResponse };
}

describe('MeshCoreManager — PUSH_CODE_PATH_UPDATED debounce', () => {
  beforeEach(() => {
    upsertNode.mockClear();
    emitMeshCoreContactUpdated.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple path-updated pushes into a single refreshContacts() call', async () => {
    const { manager, bridgeCalls } = makeCompanionManager();
    const PUBKEY = 'a'.repeat(64);

    // Three pushes inside the debounce window — should collapse to one refresh.
    dispatchBridgeEvent(manager, { event_type: 'contact_path_updated', data: { public_key: PUBKEY } });
    dispatchBridgeEvent(manager, { event_type: 'contact_path_updated', data: { public_key: PUBKEY } });
    dispatchBridgeEvent(manager, { event_type: 'contact_path_updated', data: { public_key: PUBKEY } });

    // Nothing should have hit the wire yet — we're inside the window.
    expect(bridgeCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1600);

    const getContactsCalls = bridgeCalls.filter(c => c.cmd === 'get_contacts');
    expect(getContactsCalls).toHaveLength(1);
  });

  it('updates in-memory contact with the new path bytes after refresh', async () => {
    const { manager } = makeCompanionManager();
    const PUBKEY = 'a'.repeat(64);

    dispatchBridgeEvent(manager, { event_type: 'contact_path_updated', data: { public_key: PUBKEY } });
    await vi.advanceTimersByTimeAsync(1600);
    // refreshContacts → persistContact runs via `void`; flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    const contact = manager.getContact(PUBKEY);
    expect(contact?.outPath).toBe('a3,7f,02');
    expect(contact?.pathLen).toBe(3);
  });

  it('emits a contact-updated WS event for each affected pubkey post-refresh', async () => {
    const { manager } = makeCompanionManager();
    const PUBKEY = 'a'.repeat(64);

    dispatchBridgeEvent(manager, { event_type: 'contact_path_updated', data: { public_key: PUBKEY } });
    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();
    await Promise.resolve();

    expect(emitMeshCoreContactUpdated).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreContactUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: PUBKEY,
        outPath: 'a3,7f,02',
        pathLen: 3,
      }),
      'src-a',
    );
  });

  it('does not emit for pubkeys that no longer appear in the refreshed list', async () => {
    // Push arrives for X, but by the time we refresh the device has dropped
    // X (e.g. contacts-table aging). We shouldn't synthesize a fake row —
    // the WS event would push stale path bytes back into the UI.
    const { manager, contactsResponse } = makeCompanionManager();
    const X = 'b'.repeat(64);
    contactsResponse.value = []; // empty refresh

    dispatchBridgeEvent(manager, { event_type: 'contact_path_updated', data: { public_key: X } });
    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();
    await Promise.resolve();

    expect(emitMeshCoreContactUpdated).not.toHaveBeenCalled();
  });
});
