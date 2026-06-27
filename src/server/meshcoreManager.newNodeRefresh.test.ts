/**
 * Tests for MeshCoreManager fetching the full contact record when a brand-new
 * node is heard live with an incomplete advert (#3646).
 *
 * A USB-serial companion can surface a new node's advert carrying only its
 * public key (Name/type/Position absent). The full record lives on the device's
 * contact list, so the manager schedules a debounced refreshContacts() — the
 * same coalescing path used for PATH_UPDATED — so those fields populate
 * immediately instead of only after a manual reconnect.
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

const NEW_KEY = 'c'.repeat(64);

function makeCompanionManager(): {
  manager: MeshCoreManager;
  bridgeCalls: Array<{ cmd: string; params: Record<string, unknown> }>;
} {
  const m = new MeshCoreManager('src-a');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  const bridgeCalls: Array<{ cmd: string; params: Record<string, unknown> }> = [];

  // get_contacts returns the FULL record for the new node — what a reconnect
  // would have fetched.
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'get_contacts') {
      return {
        id: '1', success: true, data: [
          {
            public_key: NEW_KEY,
            adv_name: 'Repeater One',
            name: 'Repeater One',
            adv_type: 2, // Repeater
            latitude: 37.7749,
            longitude: -122.4194,
            last_advert: 0,
          },
        ],
      };
    }
    return { id: '1', success: true, data: {} };
  };

  return { manager: m, bridgeCalls };
}

describe('MeshCoreManager — new-node contact refresh (#3646)', () => {
  beforeEach(() => {
    upsertNode.mockClear();
    emitMeshCoreContactUpdated.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches the full record when a new node advertises with only its public key', async () => {
    const { manager, bridgeCalls } = makeCompanionManager();

    // Advert push carries ONLY the public key — no name/type/position.
    dispatchBridgeEvent(manager, { event_type: 'contact_advertised', data: { public_key: NEW_KEY } });

    // Debounced — nothing on the wire yet.
    expect(bridgeCalls.filter(c => c.cmd === 'get_contacts')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();
    await Promise.resolve();

    // A single get_contacts ran, and the in-memory contact is now complete.
    expect(bridgeCalls.filter(c => c.cmd === 'get_contacts')).toHaveLength(1);
    const contact = manager.getContact(NEW_KEY);
    expect(contact?.advName).toBe('Repeater One');
    expect(contact?.advType).toBe(2);
    expect(contact?.latitude).toBeCloseTo(37.7749);
  });

  it('does NOT schedule a refresh when the advert already carries name + type', async () => {
    const { manager, bridgeCalls } = makeCompanionManager();

    dispatchBridgeEvent(manager, {
      event_type: 'contact_advertised',
      data: { public_key: NEW_KEY, adv_name: 'Already Named', adv_type: 1 },
    });

    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();

    // Complete advert → no wasteful device round-trip.
    expect(bridgeCalls.filter(c => c.cmd === 'get_contacts')).toHaveLength(0);
  });

  it('does NOT re-fetch for an already-known node re-advertising', async () => {
    const { manager, bridgeCalls } = makeCompanionManager();
    // Seed the node as already known.
    (manager as any).contacts.set(NEW_KEY, { publicKey: NEW_KEY, advName: 'Known', advType: 1 });

    dispatchBridgeEvent(manager, { event_type: 'contact_advertised', data: { public_key: NEW_KEY } });

    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();

    expect(bridgeCalls.filter(c => c.cmd === 'get_contacts')).toHaveLength(0);
  });

  it('refreshes an already-known but NAMELESS contact so its name populates (#3820)', async () => {
    const { manager, bridgeCalls } = makeCompanionManager();
    // Discovery (NODE_DISCOVER_RESP) pre-creates a known-but-nameless stub: in
    // this.contacts, but with no advName/advType. The repeater's later zero-hop
    // advert then arrives as a pubkey-only push (no adv_name), and the firmware
    // has already stored the real name on the device.
    (manager as any).contacts.set(NEW_KEY, { publicKey: NEW_KEY });

    dispatchBridgeEvent(manager, { event_type: 'contact_advertised', data: { public_key: NEW_KEY } });

    // Debounced — nothing on the wire yet.
    expect(bridgeCalls.filter(c => c.cmd === 'get_contacts')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1600);
    await Promise.resolve();
    await Promise.resolve();

    // The known stub is re-read from the device and its name now populates,
    // rather than staying "Unknown" until an unrelated refresh (#3820).
    expect(bridgeCalls.filter(c => c.cmd === 'get_contacts')).toHaveLength(1);
    const contact = manager.getContact(NEW_KEY);
    expect(contact?.advName).toBe('Repeater One');
    expect(contact?.advType).toBe(2);
  });
});
