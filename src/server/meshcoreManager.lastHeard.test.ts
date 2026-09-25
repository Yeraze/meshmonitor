/**
 * Tests that refreshContacts() preserves each node's real Last Heard across a
 * reconnect by using the companion-reported advert timestamp instead of the
 * reconnect wall-clock (#3645).
 *
 * The MeshCore companion reports `last_advert` per contact in epoch SECONDS.
 * Previously refreshContacts() set every contact's lastSeen to Date.now(),
 * which surfaced as "Last Heard: just now" for every node after a reconnect.
 *
 * Also covers #5339: a companion with an unsynced/drifted RTC can report a
 * `last_advert` that isn't a real receive time at all (years in the past or
 * future). Trusting it verbatim, as the #3645 fix originally did, wrecks
 * Last Heard sort order and the node-visibility max-age filter for as long
 * as that bogus value sticks around — so an implausible advert time falls
 * back to now, the same as a missing one always has.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

const KEY = 'd'.repeat(64);

function makeCompanionManager(contactsData: unknown[]): MeshCoreManager {
  const m = new MeshCoreManager('src-a');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).sendBridgeCommand = async (cmd: string) => {
    if (cmd === 'get_contacts') return { id: '1', success: true, data: contactsData };
    return { id: '1', success: true, data: {} };
  };
  return m;
}

describe('MeshCoreManager — Last Heard preserved across reconnect (#3645)', () => {
  beforeEach(() => { upsertNode.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('uses the reported advert time (epoch seconds → ms) for lastSeen, not now', async () => {
    // Advert heard ~2 hours ago, reported by the companion in epoch seconds.
    const fixedNow = 1_800_000_000_000; // ms
    vi.setSystemTime(fixedNow);
    const advertSec = Math.floor(fixedNow / 1000) - 7200; // 2h ago, seconds

    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'Repeater', name: 'Repeater', adv_type: 2, last_advert: advertSec },
    ]);

    await m.refreshContacts();

    const contact = m.getContact(KEY);
    // lastSeen is the advert time in ms — NOT Date.now()
    expect(contact?.lastSeen).toBe(advertSec * 1000);
    expect(contact?.lastSeen).not.toBe(fixedNow);
    // lastAdvert preserved in seconds (for the detail panel)
    expect(contact?.lastAdvert).toBe(advertSec);

    // Persisted to meshcore_nodes.lastHeard with the advert-derived ms value.
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: KEY, lastHeard: advertSec * 1000 }),
      'src-a',
    );
  });

  it('falls back to now when the device did not report an advert time', async () => {
    const fixedNow = 1_800_000_050_000;
    vi.setSystemTime(fixedNow);

    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'NoAdvert', adv_type: 1, last_advert: 0 },
    ]);

    await m.refreshContacts();

    expect(m.getContact(KEY)?.lastSeen).toBe(fixedNow);
  });

  it('falls back to now when the reported advert time is implausibly far in the past (#5339)', async () => {
    const fixedNow = 1_800_000_000_000; // ms
    vi.setSystemTime(fixedNow);
    // A companion with an unsynced RTC reporting year 2000 — below the
    // 2020-01-01 plausibility floor.
    const advertSec = 946_684_800; // 2000-01-01T00:00:00Z

    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'DriftedPast', adv_type: 1, last_advert: advertSec },
    ]);

    await m.refreshContacts();

    expect(m.getContact(KEY)?.lastSeen).toBe(fixedNow);
  });

  it('falls back to now when the reported advert time is implausibly far in the future (#5339)', async () => {
    const fixedNow = 1_800_000_000_000; // ms
    vi.setSystemTime(fixedNow);
    // A companion with a drifted RTC reporting year 2087.
    const advertSec = 3_700_000_000;

    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'DriftedFuture', adv_type: 1, last_advert: advertSec },
    ]);

    await m.refreshContacts();

    expect(m.getContact(KEY)?.lastSeen).toBe(fixedNow);
  });

  it('accepts an advert time within a day of now (ordinary clock skew, not drift)', async () => {
    const fixedNow = 1_800_000_000_000; // ms
    vi.setSystemTime(fixedNow);
    const advertSec = Math.floor(fixedNow / 1000) + 3600; // 1h ahead — plausible skew

    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'SlightlyAhead', adv_type: 1, last_advert: advertSec },
    ]);

    await m.refreshContacts();

    expect(m.getContact(KEY)?.lastSeen).toBe(advertSec * 1000);
  });

  it('is stable across repeated refreshes (does not advance to each reconnect time)', async () => {
    const advertSec = 1_700_000_000;
    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'Stable', adv_type: 2, last_advert: advertSec },
    ]);

    vi.setSystemTime(1_800_000_000_000);
    await m.refreshContacts();
    const first = m.getContact(KEY)?.lastSeen;

    // Simulate a later reconnect — same device-reported advert time.
    vi.setSystemTime(1_800_000_500_000);
    await m.refreshContacts();
    const second = m.getContact(KEY)?.lastSeen;

    expect(first).toBe(advertSec * 1000);
    expect(second).toBe(first); // preserved, not bumped to the new reconnect time
  });
});
