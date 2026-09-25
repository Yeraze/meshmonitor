/**
 * #5349 — MeshCoreManager and the companion's own contact table.
 *
 *  - onDevice tagging: 0x80 Advert (firmware stored it) vs 0x8A NewAdvert
 *    (firmware did NOT store it) vs 0x8F CONTACT_DELETED (evicted).
 *  - login outcome `not_on_device` when the radio can't address the target.
 *  - addContactToDevice full-table policy: confirm first, and never let a
 *    favourite be evicted (block when a favourite lacks the device bit).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import {
  MESHCORE_CONTACT_NOT_ON_DEVICE,
  MESHCORE_DEVICE_TABLE_FULL,
} from './meshcoreDeviceContactErrors.js';

const TARGET = '5708bb' + '22'.repeat(29); // off-device repeater
const FAV = '5708aa' + '11'.repeat(29); // favourite, on the device
const OTHER = '5710cc' + '33'.repeat(29); // non-favourite, on the device

type DeviceRow = { public_key: string; adv_type: number; favorite?: boolean; flags?: number };

interface Harness {
  manager: MeshCoreManager;
  calls: Array<{ cmd: string; params: Record<string, unknown> }>;
  device: { rows: DeviceRow[]; maxContacts: number | undefined; addResult?: 'store' | 'full'; setFavoriteWorks: boolean };
  emitted: any[];
}

function makeHarness(dbNodes: Array<{ publicKey: string; advType: number | null; isFavorite?: boolean; name?: string }>): Harness {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: 'ee'.repeat(32) };

  const device: Harness['device'] = {
    rows: [
      { public_key: FAV, adv_type: 2, favorite: true, flags: 1 },
      { public_key: OTHER, adv_type: 1, favorite: false, flags: 0 },
    ],
    maxContacts: 100,
    addResult: 'store',
    setFavoriteWorks: true,
  };
  const calls: Harness['calls'] = [];

  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    switch (cmd) {
      case 'get_contacts':
        return { id: '1', success: true, data: device.rows.map((r) => ({ ...r, adv_name: r.public_key.slice(0, 6) })) };
      case 'has_contact':
        return {
          id: '1',
          success: true,
          data: { on_device: device.rows.some((r) => r.public_key === params.public_key), count: device.rows.length },
        };
      case 'device_query':
        return { id: '1', success: true, data: { max_contacts: device.maxContacts } };
      case 'set_contacts_favorite': {
        if (device.setFavoriteWorks) {
          for (const f of params.favorites as Array<{ public_key: string }>) {
            const row = device.rows.find((r) => r.public_key === f.public_key);
            if (row) { row.favorite = true; row.flags = 1; }
          }
        }
        return { id: '1', success: true, data: { ok: true, updated: 1, missing: [] } };
      }
      case 'add_contact':
        if (device.addResult === 'full') return { id: '1', success: false, error: MESHCORE_DEVICE_TABLE_FULL };
        device.rows.push({ public_key: params.public_key as string, adv_type: params.adv_type as number });
        return { id: '1', success: true, data: { added: true, already: false, count: device.rows.length, evicted: [] } };
      default:
        return { id: '1', success: true, data: {} };
    }
  };

  vi.spyOn(databaseService.meshcore, 'getNodesBySource').mockResolvedValue(
    dbNodes.map((n) => ({ ...n, sourceId: 'test-source' })) as any,
  );
  vi.spyOn(databaseService.meshcore, 'getNodeByPublicKeyAndSource').mockImplementation(
    async (pk: string) => (dbNodes.find((n) => n.publicKey === pk) ?? null) as any,
  );
  vi.spyOn(databaseService.meshcore, 'upsertNode').mockResolvedValue(undefined as any);
  vi.spyOn(databaseService.meshcore, 'setNodeFavorite').mockResolvedValue(undefined as any);

  const emitted: any[] = [];
  m.on('contacts_updated', (e: any) => emitted.push(e.contact));
  return { manager: m, calls, device, emitted };
}

const DB = [
  { publicKey: TARGET, advType: 2, name: 'Rpt B' },
  { publicKey: FAV, advType: 2, isFavorite: true, name: 'Fav A' },
  { publicKey: OTHER, advType: 1, name: 'Chat C' },
];

describe('MeshCoreManager — contact table (#5349)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('onDevice tagging', () => {
    it('0x8A NewAdvert (contact_added) marks the contact NOT on the device', () => {
      const { manager } = makeHarness(DB);
      (manager as any).handleBridgeEvent({
        event_type: 'contact_added',
        data: { public_key: TARGET, adv_name: 'Rpt B', adv_type: 2 },
      });
      expect(manager.getContact(TARGET)?.onDevice).toBe(false);
    });

    it('0x80 Advert (contact_advertised) marks the contact on the device', () => {
      const { manager } = makeHarness(DB);
      (manager as any).handleBridgeEvent({ event_type: 'contact_advertised', data: { public_key: TARGET } });
      expect(manager.getContact(TARGET)?.onDevice).toBe(true);
    });

    it('0x8F CONTACT_DELETED keeps the contact but marks it off the device', () => {
      const { manager, emitted } = makeHarness(DB);
      (manager as any).contacts.set(OTHER, { publicKey: OTHER, advName: 'Chat C', onDevice: true });
      (manager as any).handleBridgeEvent({ event_type: 'contact_deleted', data: { public_key: OTHER } });
      expect(manager.getContact(OTHER)?.onDevice).toBe(false);
      expect(emitted.at(-1)).toMatchObject({ publicKey: OTHER, onDevice: false });
    });

    it('refreshContacts marks every device row onDevice=true', async () => {
      const { manager } = makeHarness(DB);
      await manager.refreshContacts();
      expect(manager.getContact(FAV)?.onDevice).toBe(true);
      expect(manager.getContact(OTHER)?.onDevice).toBe(true);
    });
  });

  describe('login outcome', () => {
    it('reports not_on_device when the radio does not hold the target', async () => {
      const { manager } = makeHarness(DB);
      (manager as any).sendBridgeCommand = async (cmd: string) =>
        cmd === 'login'
          ? { id: '1', success: false, error: MESHCORE_CONTACT_NOT_ON_DEVICE }
          : { id: '1', success: true, data: {} };
      const r = await manager.loginToNodeDetailed(TARGET, 'pw');
      expect(r).toEqual({ result: null, outcome: 'not_on_device' });
    });

    it('does not retry a room login the radio cannot send', async () => {
      const { manager } = makeHarness(DB);
      let sends = 0;
      (manager as any).sendBridgeCommand = async (cmd: string) => {
        if (cmd !== 'login') return { id: '1', success: true, data: {} };
        sends++;
        return { id: '1', success: false, error: MESHCORE_CONTACT_NOT_ON_DEVICE };
      };
      expect(await manager.loginToRoomWithOutcome(TARGET, 'pw')).toBe('not_on_device');
      expect(sends).toBe(1);
    });
  });

  describe('addContactToDevice', () => {
    it('adds straight away when the table has room, carrying the favourite bit', async () => {
      const { manager, calls } = makeHarness([{ ...DB[0], isFavorite: true }, DB[1], DB[2]]);
      const r = await manager.addContactToDevice(TARGET);
      expect(r).toMatchObject({ status: 'added', evicted: [] });
      const add = calls.find((c) => c.cmd === 'add_contact');
      expect(add?.params).toMatchObject({ public_key: TARGET, adv_type: 2, name: 'Rpt B', favorite: true });
      expect(manager.getContact(TARGET)?.onDevice).toBe(true);
    });

    it('asks for confirmation when the table is full, without writing', async () => {
      const { manager, calls, device } = makeHarness(DB);
      device.maxContacts = 2;
      const r = await manager.addContactToDevice(TARGET);
      expect(r).toEqual({ status: 'confirm_full', count: 2, maxContacts: 2 });
      expect(calls.some((c) => c.cmd === 'add_contact')).toBe(false);
    });

    it('treats an unreadable capacity as full (asks first)', async () => {
      const { manager, device } = makeHarness(DB);
      device.maxContacts = undefined;
      const r = await manager.addContactToDevice(TARGET);
      expect(r).toMatchObject({ status: 'confirm_full', maxContacts: null });
    });

    it('when confirmed, re-asserts favourites and adds once every favourite is protected', async () => {
      const { manager, calls, device } = makeHarness(DB);
      device.maxContacts = 2;
      device.rows[0].favorite = false; // app favourite missing its device bit
      device.rows[0].flags = 0;
      const r = await manager.addContactToDevice(TARGET, { confirmFull: true });
      expect(calls.some((c) => c.cmd === 'set_contacts_favorite')).toBe(true);
      expect(r.status).toBe('added');
    });

    it('BLOCKS the add when a favourite could not be protected on the device', async () => {
      const { manager, calls, device } = makeHarness(DB);
      device.maxContacts = 2;
      device.rows[0].favorite = false;
      device.rows[0].flags = 0;
      device.setFavoriteWorks = false;
      const r = await manager.addContactToDevice(TARGET, { confirmFull: true });
      expect(r).toEqual({ status: 'favorites_unprotected', unprotected: [FAV] });
      expect(calls.some((c) => c.cmd === 'add_contact')).toBe(false);
    });

    it('reports table_full when the firmware refuses', async () => {
      const { manager, device } = makeHarness(DB);
      device.maxContacts = 2;
      device.addResult = 'full';
      const r = await manager.addContactToDevice(TARGET, { confirmFull: true });
      expect(r).toMatchObject({ status: 'table_full' });
    });

    it('refuses a node whose type is unknown (no ADV_TYPE_NONE adds)', async () => {
      const { manager, calls } = makeHarness([{ publicKey: TARGET, advType: null }]);
      expect(await manager.addContactToDevice(TARGET)).toEqual({ status: 'unknown_type' });
      expect(calls.some((c) => c.cmd === 'add_contact')).toBe(false);
    });

    it('is a no-op for a contact already on the radio', async () => {
      const { manager, calls } = makeHarness(DB);
      expect(await manager.addContactToDevice(OTHER)).toEqual({ status: 'already_on_device' });
      expect(calls.some((c) => c.cmd === 'add_contact')).toBe(false);
    });

    it('returns not_found for an unknown key', async () => {
      const { manager } = makeHarness(DB);
      expect(await manager.addContactToDevice('ff'.repeat(32))).toEqual({ status: 'not_found' });
    });

    it('returns unavailable when not a connected companion', async () => {
      const { manager } = makeHarness(DB);
      (manager as any).connected = false;
      expect(await manager.addContactToDevice(TARGET)).toEqual({ status: 'unavailable' });
    });
  });
});
