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

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
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
