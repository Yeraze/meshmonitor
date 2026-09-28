/**
 * Tests that refreshContacts() preserves each node's real Last Heard across a
 * reconnect instead of stamping the reconnect wall-clock (#3645).
 *
 * #5339: Last Heard comes from the companion's `last_mod` — stamped by the
 * COMPANION's own clock (which MeshMonitor keeps synced) whenever it hears the
 * contact — and never from `last_advert`, which is the SENDER's clock. A node
 * with no RTC boots at the firmware's fixed 2024 default and one that drifted
 * can read years off either way, so trusting `last_advert` wrecked Last Heard
 * sort order and the node-visibility max-age filter.
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

  it('uses the companion-clock last_mod (epoch seconds → ms) for lastSeen, not now', async () => {
    const fixedNow = 1_800_000_000_000; // ms
    vi.setSystemTime(fixedNow);
    const lastModSec = Math.floor(fixedNow / 1000) - 7200; // heard 2h ago

    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'Repeater', name: 'Repeater', adv_type: 2, last_advert: lastModSec - 5, last_mod: lastModSec },
    ]);

    await m.refreshContacts();

    const contact = m.getContact(KEY);
    expect(contact?.lastSeen).toBe(lastModSec * 1000);
    // lastAdvert preserved in seconds (for the detail panel)
    expect(contact?.lastAdvert).toBe(lastModSec - 5);
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: KEY, lastHeard: lastModSec * 1000 }),
      'src-a',
    );
  });

  it('ignores last_advert even when it looks plausible (no-RTC node at the firmware 2024 default, #5339)', async () => {
    const fixedNow = 1_800_000_000_000;
    vi.setSystemTime(fixedNow);
    const noRtcDefaultSec = 1_715_770_351; // VolatileRTCClock base, 2024-05-15
    const lastModSec = Math.floor(fixedNow / 1000) - 60;

    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'NoRtc', adv_type: 2, last_advert: noRtcDefaultSec, last_mod: lastModSec },
    ]);

    await m.refreshContacts();

    expect(m.getContact(KEY)?.lastSeen).toBe(lastModSec * 1000);
    expect(upsertNode).not.toHaveBeenCalledWith(
      expect.objectContaining({ lastHeard: noRtcDefaultSec * 1000 }),
      'src-a',
    );
  });

  it('does not fall back to last_advert when last_mod is absent', async () => {
    vi.setSystemTime(1_800_000_000_000);
    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'NoLastMod', adv_type: 2, last_advert: 1_799_990_000 },
    ]);

    await m.refreshContacts();

    expect(m.getContact(KEY)?.lastSeen).toBeUndefined();
  });

  it('does not stamp "now" when the device reported no time (#5341)', async () => {
    // A contact sync is a local read of the device's saved contact list, not
    // evidence the node was just heard. Stamping Date.now() — which the
    // forward-only guard in upsertNode() always sees as newer — made an
    // offline favorite's Last Heard advance on every refreshContacts().
    const fixedNow = 1_800_000_050_000;
    vi.setSystemTime(fixedNow);

    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'NoTime', adv_type: 1, last_advert: 0, last_mod: 0 },
    ]);

    await m.refreshContacts();

    expect(m.getContact(KEY)?.lastSeen).toBeUndefined();
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: KEY, lastHeard: null }),
      'src-a',
    );
  });

  it('keeps the previously known lastSeen across a refresh when the device reports no time', async () => {
    const lastModSec = 1_700_000_000;
    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'Stable', adv_type: 2, last_mod: lastModSec },
    ]);

    vi.setSystemTime(1_800_000_000_000);
    await m.refreshContacts();
    expect(m.getContact(KEY)?.lastSeen).toBe(lastModSec * 1000);

    const later = makeCompanionManager([
      { public_key: KEY, adv_name: 'Stable', adv_type: 2, last_mod: 0 },
    ]);
    (later as any).contacts = (m as any).contacts;
    vi.setSystemTime(1_800_000_500_000);
    await later.refreshContacts();

    expect(later.getContact(KEY)?.lastSeen).toBe(lastModSec * 1000);
  });

  it('ignores an implausible last_mod (companion clock never synced, far past or future)', async () => {
    const fixedNow = 1_800_000_000_000;
    vi.setSystemTime(fixedNow);

    for (const badSec of [946_684_800 /* 2000 */, 3_700_000_000 /* ~2087 */]) {
      upsertNode.mockClear();
      const m = makeCompanionManager([
        { public_key: KEY, adv_name: 'Drifted', adv_type: 1, last_mod: badSec },
      ]);
      await m.refreshContacts();
      expect(m.getContact(KEY)?.lastSeen).toBeUndefined();
      expect(upsertNode).not.toHaveBeenCalledWith(
        expect.objectContaining({ lastHeard: badSec * 1000 }),
        'src-a',
      );
    }
  });

  it('clamps a last_mod slightly ahead of the server clock to now', async () => {
    const fixedNow = 1_800_000_000_000;
    vi.setSystemTime(fixedNow);
    const aheadSec = Math.floor(fixedNow / 1000) + 3600; // companion 1h fast

    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'Fast', adv_type: 1, last_mod: aheadSec },
    ]);

    await m.refreshContacts();

    expect(m.getContact(KEY)?.lastSeen).toBe(fixedNow);
  });

  it('is stable across repeated refreshes (does not advance to each reconnect time)', async () => {
    const lastModSec = 1_700_000_000;
    const m = makeCompanionManager([
      { public_key: KEY, adv_name: 'Stable', adv_type: 2, last_mod: lastModSec },
    ]);

    vi.setSystemTime(1_800_000_000_000);
    await m.refreshContacts();
    const first = m.getContact(KEY)?.lastSeen;

    vi.setSystemTime(1_800_000_500_000);
    await m.refreshContacts();
    const second = m.getContact(KEY)?.lastSeen;

    expect(first).toBe(lastModSec * 1000);
    expect(second).toBe(first);
  });
});

describe('MeshCoreManager — local path writes do not count as "heard" (#5341)', () => {
  const HEARD_AT = 1_700_000_000_000;

  function connectedWithContact(): MeshCoreManager {
    const m = new MeshCoreManager('src-a');
    (m as any).deviceType = MeshCoreDeviceType.COMPANION;
    (m as any).connected = true;
    (m as any).contacts.set(KEY, {
      publicKey: KEY,
      advType: MeshCoreDeviceType.COMPANION,
      lastSeen: HEARD_AT,
      outPath: 'a3',
      pathLen: 1,
    });
    (m as any).sendBridgeCommand = async () => ({ id: '1', success: true, data: {} });
    return m;
  }

  beforeEach(() => { upsertNode.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('resetContactPath keeps the known lastSeen (the DM-ack-timeout retry calls it on a silent node)', async () => {
    vi.setSystemTime(1_800_000_000_000);
    const m = connectedWithContact();

    expect(await m.resetContactPath(KEY)).toBe(true);

    const contact = m.getContact(KEY);
    expect(contact?.outPath).toBeNull();
    expect(contact?.lastSeen).toBe(HEARD_AT);
    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: KEY, lastHeard: HEARD_AT }),
      'src-a',
    );
  });

  it('setContactOutPath keeps the known lastSeen', async () => {
    vi.setSystemTime(1_800_000_000_000);
    const m = connectedWithContact();

    const result = await m.setContactOutPath(KEY, Uint8Array.from([0x7f]));

    expect(result.applied).toBe(true);
    const contact = m.getContact(KEY);
    expect(contact?.outPath).toBe('7f');
    expect(contact?.lastSeen).toBe(HEARD_AT);
  });
});
