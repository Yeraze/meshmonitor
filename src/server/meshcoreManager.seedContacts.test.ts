/**
 * Tests for MeshCoreManager.seedContactsFromDb().
 *
 * Regression: the DM contact list is sourced from getContacts() (in-memory
 * this.contacts), which is only populated by the live device get_contacts.
 * On a flaky/slow companion that returns empty (or times out), the in-memory
 * list stayed nearly empty — so the DM list showed a handful of unnamed
 * entries while the node/map view (DB-backed getAllNodes) showed the full set.
 * seedContactsFromDb pre-fills this.contacts from the persisted node list so
 * the two stay consistent when the live sync degrades.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getNodesBySource = vi.fn();
vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      getNodesBySource: (...args: unknown[]) => getNodesBySource(...args),
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

const dbNode = (publicKey: string, name: string | null, advType = MeshCoreDeviceType.REPEATER, extra: Record<string, unknown> = {}) => ({
  publicKey,
  name,
  advType,
  isLocalNode: false,
  rssi: null,
  snr: null,
  latitude: null,
  longitude: null,
  lastHeard: 1_700_000_000,
  outPath: null,
  pathLen: null,
  ...extra,
});

// seedContactsFromDb is private; invoke it directly to exercise the seed path
// without standing up the native backend.
const seed = (m: MeshCoreManager) => (m as unknown as { seedContactsFromDb(): Promise<void> }).seedContactsFromDb();
const setCompanion = (m: MeshCoreManager) => { (m as unknown as { deviceType: MeshCoreDeviceType }).deviceType = MeshCoreDeviceType.COMPANION; };

describe('MeshCoreManager.seedContactsFromDb', () => {
  beforeEach(() => getNodesBySource.mockReset());

  it('seeds named contacts from the DB into getContacts()', async () => {
    getNodesBySource.mockResolvedValue([
      dbNode('b1'.repeat(32), 'North Repeater'),
      dbNode('7f'.repeat(32), 'East Repeater', MeshCoreDeviceType.COMPANION),
    ]);
    const m = new MeshCoreManager('src-a');
    setCompanion(m);
    await seed(m);

    const contacts = m.getContacts();
    expect(contacts).toHaveLength(2);
    const north = contacts.find((c) => c.publicKey === 'b1'.repeat(32))!;
    expect(north.advName).toBe('North Repeater');
    expect(north.advType).toBe(MeshCoreDeviceType.REPEATER);
  });

  it('skips the local node', async () => {
    getNodesBySource.mockResolvedValue([
      dbNode('aa'.repeat(32), 'Me', MeshCoreDeviceType.COMPANION, { isLocalNode: true }),
      dbNode('b1'.repeat(32), 'North Repeater'),
    ]);
    const m = new MeshCoreManager('src-a');
    setCompanion(m);
    await seed(m);
    expect(m.getContacts().map((c) => c.publicKey)).toEqual(['b1'.repeat(32)]);
  });

  it('does not clobber an existing in-memory contact (e.g. a live advert)', async () => {
    getNodesBySource.mockResolvedValue([dbNode('b1'.repeat(32), 'Stale DB Name')]);
    const m = new MeshCoreManager('src-a');
    setCompanion(m);
    (m as unknown as { contacts: Map<string, unknown> }).contacts.set('b1'.repeat(32), {
      publicKey: 'b1'.repeat(32),
      advName: 'Fresh Advert Name',
    });
    await seed(m);
    expect(m.getContacts().find((c) => c.publicKey === 'b1'.repeat(32))!.advName).toBe('Fresh Advert Name');
  });

  it('is a no-op for repeater sources', async () => {
    getNodesBySource.mockResolvedValue([dbNode('b1'.repeat(32), 'North Repeater')]);
    const m = new MeshCoreManager('src-a');
    (m as unknown as { deviceType: MeshCoreDeviceType }).deviceType = MeshCoreDeviceType.REPEATER;
    await seed(m);
    expect(m.getContacts()).toHaveLength(0);
    expect(getNodesBySource).not.toHaveBeenCalled();
  });
});
