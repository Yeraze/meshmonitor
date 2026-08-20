/**
 * Regression tests for issue #4838 — a contact evicted from the companion's
 * own contact table took its identity down with it.
 *
 * The MeshCore companion firmware holds contacts in a fixed-size table and
 * evicts the least-recently-adverted non-favorite entry once it fills. A
 * rarely-adverting repeater is the natural victim. `refreshContacts()` then
 * clear-and-replaced its in-memory map from that shorter `get_contacts`
 * result, so the contact's name and advType vanished — the UI fell back to
 * a truncated public key, the type defaulted to Companion, and ping/path
 * discovery failed with "Contact is not known to this source."
 *
 * The fix re-seeds those contacts from `meshcore_nodes` after the replace,
 * flagged `onDevice: false`: identity survives, callers can still tell the
 * radio cannot address them, and the error text says so.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getNodesBySource = vi.fn();
const upsertNode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      getNodesBySource: (...args: unknown[]) => getNodesBySource(...args),
      upsertNode: (...args: unknown[]) => upsertNode(...args),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: new Proxy({}, { get: () => vi.fn() }),
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const REPEATER = 'a'.repeat(64);
const COMPANION = 'b'.repeat(64);

/** A `meshcore_nodes` row for the repeater, as it survives an eviction. */
const REPEATER_ROW = {
  publicKey: REPEATER,
  name: 'Hilltop Repeater',
  advType: MeshCoreDeviceType.REPEATER,
  rssi: -78,
  snr: 6,
  isLocalNode: false,
  lastHeard: 1_700_000_000_000,
};

const COMPANION_ROW = {
  publicKey: COMPANION,
  name: 'Alice',
  advType: MeshCoreDeviceType.COMPANION,
  isLocalNode: false,
};

/** Device contact-list entry as `get_contacts` reports it. */
const companionContact = {
  public_key: COMPANION,
  adv_name: 'Alice',
  name: 'Alice',
  adv_type: MeshCoreDeviceType.COMPANION,
  last_advert: 1_700_000_500,
};

const repeaterContact = {
  public_key: REPEATER,
  adv_name: 'Hilltop Repeater',
  name: 'Hilltop Repeater',
  adv_type: MeshCoreDeviceType.REPEATER,
  last_advert: 1_700_000_000,
};

function makeManager(contactsData: unknown[]): MeshCoreManager {
  const m = new MeshCoreManager('src-a');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).sendBridgeCommand = async (cmd: string) => {
    if (cmd === 'get_contacts') return { id: '1', success: true, data: contactsData };
    return { id: '1', success: true, data: {} };
  };
  return m;
}

describe('MeshCoreManager — firmware contact eviction (#4838)', () => {
  beforeEach(() => {
    getNodesBySource.mockReset();
    getNodesBySource.mockResolvedValue([REPEATER_ROW, COMPANION_ROW]);
    upsertNode.mockClear();
  });

  it('keeps an evicted contact\'s name and advType, restored from the DB', async () => {
    // The device no longer reports the repeater — only the companion.
    const m = makeManager([companionContact]);

    await m.refreshContacts();

    const restored = m.getContact(REPEATER);
    expect(restored).toBeDefined();
    expect(restored?.advName).toBe('Hilltop Repeater');
    // Without the fix this defaulted to Companion in the UI.
    expect(restored?.advType).toBe(MeshCoreDeviceType.REPEATER);
    expect(restored?.rssi).toBe(-78);
  });

  it('flags device-reported contacts on-device and restored ones off-device', async () => {
    const m = makeManager([companionContact]);

    await m.refreshContacts();

    expect(m.getContact(COMPANION)?.onDevice).toBe(true);
    expect(m.getContact(REPEATER)?.onDevice).toBe(false);
  });

  it('does not re-persist a restored contact, so the DB row is untouched', async () => {
    const m = makeManager([companionContact]);

    await m.refreshContacts();

    const persistedKeys = upsertNode.mock.calls.map(([node]) => node.publicKey);
    expect(persistedKeys).toContain(COMPANION);
    expect(persistedKeys).not.toContain(REPEATER);
  });

  it('pings an evicted contact with an actionable error, not "not known to this source"', async () => {
    const m = makeManager([companionContact]);
    await m.refreshContacts();

    const result = await m.pingContactZeroHop(REPEATER);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('evicted-contact');
    expect(result.error).toMatch(/no longer in the device's contact list/);
    expect(result.error).not.toMatch(/not known to this source/);
  });

  it('still reports a genuinely unknown key as unknown-contact', async () => {
    getNodesBySource.mockResolvedValue([COMPANION_ROW]);
    const m = makeManager([companionContact]);
    await m.refreshContacts();

    const result = await m.pingContactZeroHop('f'.repeat(64));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('unknown-contact');
  });

  it('clears the off-device flag when the node adverts again', async () => {
    const m = makeManager([companionContact]);
    await m.refreshContacts();
    expect(m.getContact(REPEATER)?.onDevice).toBe(false);

    // The repeater's next advert puts it back in the companion's table.
    (m as any).handleBridgeEvent({
      event_type: 'contact_advertised',
      data: {
        public_key: REPEATER,
        adv_name: 'Hilltop Repeater',
        adv_type: MeshCoreDeviceType.REPEATER,
      },
    });
    await Promise.resolve();

    expect(m.getContact(REPEATER)?.onDevice).toBe(true);
  });

  it('does not resurrect a contact the user just removed', async () => {
    const m = makeManager([companionContact]);
    // removeContact()/forgetLocalContact() tombstone the key; a DB row can
    // still be in flight when the next refresh lands.
    (m as any).tombstoneContact(REPEATER);

    await m.refreshContacts();

    expect(m.getContact(REPEATER)).toBeUndefined();
  });

  it('leaves the map alone when the device returns an empty list (#3884 guard holds)', async () => {
    const m = makeManager([companionContact, repeaterContact]);
    await m.refreshContacts();
    expect(m.getContacts()).toHaveLength(2);

    (m as any).sendBridgeCommand = async () => ({ id: '2', success: true, data: [] });
    await m.refreshContacts();

    expect(m.getContacts()).toHaveLength(2);
    expect(m.getContact(REPEATER)?.onDevice).toBe(true);
  });
});
