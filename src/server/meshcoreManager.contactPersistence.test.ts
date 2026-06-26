/**
 * Tests for MeshCoreManager contact → meshcore_nodes persistence.
 *
 * Regression for issue #3092: before the fix, contact_advertised /
 * contact_added events only updated the in-memory `this.contacts` map.
 * The `meshcore_nodes` SQL table was only written by
 * setNodeTelemetryConfig (publicKey + telemetry flags, advType=null),
 * so the remote-telemetry scheduler always treated every target as a
 * Companion and skipped the SendStatusReq + guest-login paths added
 * in #3094.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const getSource = vi.fn().mockResolvedValue({ name: 'Source A' });

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
    },
    sources: {
      getSource: (...args: unknown[]) => getSource(...args),
    },
  },
}));

const notifyNewMeshCoreNode = vi.fn().mockResolvedValue(undefined);
vi.mock('./services/notificationService.js', () => ({
  notificationService: {
    notifyNewMeshCoreNode: (...args: unknown[]) => notifyNewMeshCoreNode(...args),
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
  },
}));

// notifyNewNodeDiscovered runs via `void` with an awaited getSource lookup;
// flush microtasks + a macrotask so the fire-and-forget notification settles.
const flush = () => new Promise((r) => setTimeout(r, 0));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

interface BridgeEvent {
  event_type: string;
  data: Record<string, unknown>;
}

function dispatchBridgeEvent(m: MeshCoreManager, evt: BridgeEvent): void {
  // handleBridgeEvent is private; invoking it directly is the cleanest
  // way to exercise the contact-event path without standing up the
  // native backend.
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent(evt);
}

describe('MeshCoreManager contact persistence (issue #3092)', () => {
  const REPEATER_PUBKEY = 'a'.repeat(64);

  beforeEach(() => {
    upsertNode.mockClear();
    getSource.mockClear();
    notifyNewMeshCoreNode.mockClear();
  });

  it('persists advType to meshcore_nodes on contact_advertised', async () => {
    const manager = new MeshCoreManager('src-a');
    dispatchBridgeEvent(manager, {
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_name: 'MyRepeater',
        adv_type: MeshCoreDeviceType.REPEATER,
        latitude: 51.5,
        longitude: -0.1,
        last_advert: 1_700_000_000,
      },
    });

    // persistContact runs via `void`, so flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(upsertNode).toHaveBeenCalledTimes(1);
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: REPEATER_PUBKEY,
        name: 'MyRepeater',
        advType: MeshCoreDeviceType.REPEATER,
        latitude: 51.5,
        longitude: -0.1,
      }),
      'src-a',
    );
  });

  it('stores null lat/lon for a Null Island (0,0) contact (issue #3763)', async () => {
    const manager = new MeshCoreManager('src-a');
    dispatchBridgeEvent(manager, {
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_name: 'MyRepeater',
        adv_type: MeshCoreDeviceType.REPEATER,
        // (0,0) — uninitialized GPS default; must not be persisted as a position.
        latitude: 0,
        longitude: 0,
        last_advert: 1_700_000_000,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(upsertNode).toHaveBeenCalledTimes(1);
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: REPEATER_PUBKEY,
        latitude: null,
        longitude: null,
      }),
      'src-a',
    );
  });

  it('persists advType to meshcore_nodes on contact_added', async () => {
    const manager = new MeshCoreManager('src-a');
    dispatchBridgeEvent(manager, {
      event_type: 'contact_added',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_name: 'Room1',
        adv_type: MeshCoreDeviceType.ROOM_SERVER,
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(upsertNode).toHaveBeenCalledTimes(1);
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({
        publicKey: REPEATER_PUBKEY,
        advType: MeshCoreDeviceType.ROOM_SERVER,
      }),
      'src-a',
    );
  });

  it('does not directly upsert on contact_path_updated (refresh is debounced)', async () => {
    // Slice 4 change: the PUSH_CODE_PATH_UPDATED frame body is just the
    // pubkey, so the only way to learn the new path bytes is to re-read
    // the contact record from the device. The push handler now schedules
    // a debounced refreshContacts() call instead of upserting a stub
    // immediately. The in-memory advType from the prior advert is
    // preserved (no synchronous overwrite), and the refresh happens
    // off-timer — covered by the debounce-specific tests below.
    const manager = new MeshCoreManager('src-a');
    dispatchBridgeEvent(manager, {
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_name: 'MyRepeater',
        adv_type: MeshCoreDeviceType.REPEATER,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    upsertNode.mockClear();

    dispatchBridgeEvent(manager, {
      event_type: 'contact_path_updated',
      data: { public_key: REPEATER_PUBKEY },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(upsertNode).not.toHaveBeenCalled();
    expect(manager.getContact(REPEATER_PUBKEY)?.advType).toBe(MeshCoreDeviceType.REPEATER);
  });

  it('logs but does not throw when the DB upsert fails', async () => {
    upsertNode.mockRejectedValueOnce(new Error('db kaput'));
    const manager = new MeshCoreManager('src-a');

    expect(() =>
      dispatchBridgeEvent(manager, {
        event_type: 'contact_advertised',
        data: {
          public_key: REPEATER_PUBKEY,
          adv_name: 'MyRepeater',
          adv_type: MeshCoreDeviceType.REPEATER,
        },
      }),
    ).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
    // In-memory contact still updated even though the persist failed.
    expect(manager.getContact(REPEATER_PUBKEY)?.advType).toBe(MeshCoreDeviceType.REPEATER);
  });

  it('fires a "new node discovered" notification the first time a contact advertises', async () => {
    const manager = new MeshCoreManager('src-a');
    dispatchBridgeEvent(manager, {
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_name: 'MyRepeater',
        adv_type: MeshCoreDeviceType.REPEATER,
      },
    });

    await flush();

    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(1);
    expect(notifyNewMeshCoreNode).toHaveBeenCalledWith(
      REPEATER_PUBKEY,
      'MyRepeater',
      'Repeater',     // MeshCoreDeviceType.REPEATER → friendly label
      'src-a',
      'Source A',     // resolved via databaseService.sources.getSource
    );
  });

  it('does not re-notify when an already-known contact re-advertises', async () => {
    const manager = new MeshCoreManager('src-a');
    const advert = {
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_name: 'MyRepeater',
        adv_type: MeshCoreDeviceType.REPEATER,
      },
    };

    dispatchBridgeEvent(manager, advert);
    await flush();
    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(1);

    // Second advert for the same (now-known) contact must not notify again.
    dispatchBridgeEvent(manager, advert);
    await flush();
    expect(notifyNewMeshCoreNode).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a brand-new contact that has no display name yet', async () => {
    const manager = new MeshCoreManager('src-a');
    dispatchBridgeEvent(manager, {
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_type: MeshCoreDeviceType.REPEATER,
        // no adv_name
      },
    });

    await flush();

    expect(notifyNewMeshCoreNode).not.toHaveBeenCalled();
  });

  it('preserves stored name when a subsequent advert arrives with empty adv_name (issue #3756)', async () => {
    const manager = new MeshCoreManager('src-a');
    // First advert establishes the name.
    dispatchBridgeEvent(manager, {
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_name: 'MyRepeater',
        adv_type: MeshCoreDeviceType.REPEATER,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    upsertNode.mockClear();

    // Second advert (e.g. from a zero-hop repeater) arrives with empty name.
    dispatchBridgeEvent(manager, {
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_name: '',
        adv_type: MeshCoreDeviceType.REPEATER,
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    // In-memory contact must keep the previously stored name.
    expect(manager.getContact(REPEATER_PUBKEY)?.advName).toBe('MyRepeater');
    // DB persist must also use the preserved name, not the empty string.
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'MyRepeater' }),
      'src-a',
    );
  });

  it('exposes the in-memory contact via getContact for route-side backfill', () => {
    const manager = new MeshCoreManager('src-a');
    expect(manager.getContact(REPEATER_PUBKEY)).toBeUndefined();

    dispatchBridgeEvent(manager, {
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER_PUBKEY,
        adv_name: 'MyRepeater',
        adv_type: MeshCoreDeviceType.REPEATER,
      },
    });

    expect(manager.getContact(REPEATER_PUBKEY)).toMatchObject({
      publicKey: REPEATER_PUBKEY,
      advName: 'MyRepeater',
      advType: MeshCoreDeviceType.REPEATER,
    });
  });
});
