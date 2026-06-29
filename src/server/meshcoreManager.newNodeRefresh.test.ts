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
const getNodeByPublicKeyAndSource = vi.fn().mockResolvedValue(null);
const emitMeshCoreContactUpdated = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
      getNodeByPublicKeyAndSource: (...args: unknown[]) => getNodeByPublicKeyAndSource(...args),
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
    getNodeByPublicKeyAndSource.mockClear();
    getNodeByPublicKeyAndSource.mockResolvedValue(null);
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

describe('MeshCoreManager — re-discovered node name backfill (#3858)', () => {
  beforeEach(() => {
    upsertNode.mockClear();
    getNodeByPublicKeyAndSource.mockClear();
    getNodeByPublicKeyAndSource.mockResolvedValue(null);
    emitMeshCoreContactUpdated.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Discovery schedules a debounced path-refresh; drop it so the timer
    // doesn't leak into the next test.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('backfills a re-discovered nameless node\'s name from the surviving DB row', async () => {
    const { manager } = makeCompanionManager();
    // User deleted "Yeraze Repeater" (gone from this.contacts) then hit
    // "Discover Repeaters". The discovery response carries only key+type, but
    // the persisted meshcore_nodes row survived the delete with the real name.
    getNodeByPublicKeyAndSource.mockResolvedValue({ publicKey: NEW_KEY, name: 'Yeraze Repeater' });

    dispatchBridgeEvent(manager, {
      event_type: 'node_discovered',
      data: { public_key: NEW_KEY, adv_type: 2, snr: 5 },
    });

    // Let the async DB backfill resolve.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(getNodeByPublicKeyAndSource).toHaveBeenCalledWith(NEW_KEY, 'src-a');
    // The contact-updated push the UI receives carries the recovered name,
    // not "Unknown" — no page reload required.
    const emitted = emitMeshCoreContactUpdated.mock.calls.map((c) => c[0] as { publicKey: string; advName?: string });
    expect(emitted.some((ct) => ct.publicKey === NEW_KEY && ct.advName === 'Yeraze Repeater')).toBe(true);
    expect(manager.getContact(NEW_KEY)?.advName).toBe('Yeraze Repeater');
  });

  it('emits the discovered node as-is when no DB row exists (genuinely new)', async () => {
    const { manager } = makeCompanionManager();
    getNodeByPublicKeyAndSource.mockResolvedValue(null);

    dispatchBridgeEvent(manager, {
      event_type: 'node_discovered',
      data: { public_key: NEW_KEY, adv_type: 2, snr: 5 },
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Still emitted (so the UI shows the node), just without a name to backfill.
    const emitted = emitMeshCoreContactUpdated.mock.calls.map((c) => c[0] as { publicKey: string; advName?: string });
    expect(emitted.some((ct) => ct.publicKey === NEW_KEY)).toBe(true);
    expect(manager.getContact(NEW_KEY)?.advName).toBeUndefined();
  });
});
