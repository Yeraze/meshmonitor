/**
 * Regression for issue #4553: a MeshCore direct message is itself a "we just
 * heard this contact" event, but the sender contact's `lastSeen` (surfaced as
 * "Last Heard" in the Contact Details panel) previously only advanced on
 * `contact_advertised` pushes or the next debounced/manual `refreshContacts()`
 * poll. A DM arriving between adverts left the panel showing a stale "1 day
 * ago" moments after a live message came in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);
const insertMessage = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
      insertMessage: (...args: unknown[]) => insertMessage(...args),
    },
  },
}));

const emitMeshCoreContactUpdated = vi.fn();
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
  // handleBridgeEvent is private; invoking it directly exercises the
  // contact-message path without standing up the native backend.
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent(evt);
}

describe('MeshCoreManager — DM updates sender Last Heard (#4553)', () => {
  const SENDER_PUBKEY = 'c'.repeat(64);

  beforeEach(() => {
    upsertNode.mockClear();
    insertMessage.mockClear();
    emitMeshCoreContactUpdated.mockClear();
    vi.useRealTimers();
  });

  function makeManagerWithContact(overrides?: Record<string, unknown>): MeshCoreManager {
    const m = new MeshCoreManager('src-a');
    (m as any).deviceType = MeshCoreDeviceType.COMPANION;
    (m as any).localNode = { publicKey: 'a'.repeat(64) };
    (m as any).contacts.set(SENDER_PUBKEY, {
      publicKey: SENDER_PUBKEY,
      advName: 'Cupid_stunt',
      advType: 1,
      lastSeen: 1_600_000_000_000, // "1 day ago"-style stale value
      lastAdvert: 1_600_000_000,
      pathLen: 4,
      outPath: '3ed6,86f1,92db,d450',
      ...overrides,
    });
    return m;
  }

  it('bumps the sender contact lastSeen to now when a direct message arrives', async () => {
    const fixedNow = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const manager = makeManagerWithContact();

    dispatchBridgeEvent(manager, {
      event_type: 'contact_message',
      data: {
        pubkey_prefix: SENDER_PUBKEY,
        text: 'test 000',
        sender_timestamp: 1_700_000_000,
      },
    });

    expect(manager.getContact(SENDER_PUBKEY)?.lastSeen).toBe(fixedNow);

    await Promise.resolve();
    await Promise.resolve();

    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: SENDER_PUBKEY, lastHeard: fixedNow }),
      'src-a',
    );
    expect(emitMeshCoreContactUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: SENDER_PUBKEY, lastSeen: fixedNow }),
      'src-a',
    );
  });

  it('does not touch the cached outbound path/hops — those reflect routing, not this message', async () => {
    const manager = makeManagerWithContact();

    dispatchBridgeEvent(manager, {
      event_type: 'contact_message',
      data: {
        pubkey_prefix: SENDER_PUBKEY,
        text: 'test 000',
        sender_timestamp: 1_700_000_000,
        // This message itself arrived direct (0 hops) — must not overwrite
        // the contact's separately-tracked outbound routing path.
        path_len: 0xff,
      },
    });

    const contact = manager.getContact(SENDER_PUBKEY);
    expect(contact?.pathLen).toBe(4);
    expect(contact?.outPath).toBe('3ed6,86f1,92db,d450');
  });

  it('is a no-op when the sender is not a known contact', () => {
    const manager = new MeshCoreManager('src-a');
    (manager as any).deviceType = MeshCoreDeviceType.COMPANION;
    (manager as any).localNode = { publicKey: 'a'.repeat(64) };

    expect(() =>
      dispatchBridgeEvent(manager, {
        event_type: 'contact_message',
        data: {
          pubkey_prefix: 'deadbeef',
          text: 'orphan dm',
          sender_timestamp: 1_700_000_000,
        },
      }),
    ).not.toThrow();

    expect(upsertNode).not.toHaveBeenCalled();
  });
});
