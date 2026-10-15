/**
 * Channel PUT/DELETE fixes from #5826.
 *
 * 1. A user-cleared Meshtastic PSK (explicit `psk: ''`) turns encryption off.
 *    It reaches the device as the 1-byte `0x00` key, not a 0-byte key: the
 *    firmware gives a SECONDARY channel with a 0-byte key the primary's key.
 *    An absent or null `psk` still keeps the stored key.
 * 2. A `meshcore_mqtt` source has no device and no writable channel slots,
 *    so PUT and DELETE refuse it instead of taking the Meshtastic branch.
 *
 * Real-middleware harness against real SQLite. The device manager is the only
 * mock, and its setChannelConfig runs the REAL DeviceAdminService, so the
 * assertions read the actual set_channel bytes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const holder: { setChannelConfig: (i: number, c: any) => Promise<void>; calls: number } = {
  setChannelConfig: async () => {},
  calls: 0,
};
vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: () => ({ setChannelConfig: (i: number, c: any) => { holder.calls++; return holder.setChannelConfig(i, c); } }),
  resolveOwnMeshtasticManager: () => ({ setChannelConfig: (i: number, c: any) => { holder.calls++; return holder.setChannelConfig(i, c); } }),
}));

import channelRoutes from './channelRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { DeviceAdminService } from '../services/deviceAdminService.js';
import protobufService from '../protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';

const KEY = Buffer.alloc(16, 7).toString('base64');
const MC_MQTT = 'rt-5826-meshcore-mqtt';

describe('channel PUT/DELETE fixes (#5826)', () => {
  let harness: RouteTestHarness;
  let sent: Uint8Array[];

  const decodeSettings = (bytes: Uint8Array) => {
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return (AdminMessage.toObject(AdminMessage.decode(bytes), { defaults: true, oneofs: true }) as any).setChannel.settings;
  };
  const pskBytes = (settings: any) => Buffer.from(settings.psk ?? []);

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', channelRoutes) });
    sent = [];
    holder.calls = 0;
    const fakeMgr = {
      sourceId: harness.sourceA,
      isTransportReady: () => true,
      getLocalNodeInfo: () => ({ nodeNum: 111 }),
      sendLocalAdminPacket: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new DeviceAdminService(fakeMgr as any);
    holder.setChannelConfig = (i, c) => svc.setChannelConfig(i, c);
    const real = protobufService.createSetChannelMessage.bind(protobufService);
    vi.spyOn(protobufService, 'createSetChannelMessage').mockImplementation((...args) => {
      const out = real(...args);
      sent.push(out);
      return out;
    });
    await harness.db.channels.upsertChannel({ id: 2, name: 'Secret', psk: KEY, role: 2 }, harness.sourceA);
    await harness.db.channels.upsertChannel({ id: 0, name: 'Main', psk: KEY, role: 1 }, harness.sourceA);

    await harness.db.sources.deleteSource(MC_MQTT).catch(() => {});
    await harness.db.sources.createSource({
      id: MC_MQTT, name: 'MeshCore MQTT', type: 'meshcore_mqtt', config: {}, enabled: true,
    });
    // A row as if something had filed one under the ingest source.
    await harness.db.channels.upsertChannel({ id: 1, name: 'Keep', psk: KEY, role: 2 }, MC_MQTT);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.db.channels.deleteChannel(1, MC_MQTT).catch(() => {});
    await harness.db.sources.deleteSource(MC_MQTT).catch(() => {});
    await harness.cleanup();
  });

  describe('clearing a Meshtastic PSK', () => {
    it('an explicit empty psk turns encryption off: device gets 0x00, the row stores AA==', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put('/2').send({ sourceId: harness.sourceA, name: 'Open', psk: '', role: 2 });
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect([...pskBytes(decodeSettings(sent[0]))]).toEqual([0]);
      expect((await harness.db.channels.getChannelById(2, harness.sourceA))!.psk).toBe('AA==');
    });

    it('the cleared channel reads back as unencrypted', async () => {
      const agent = await harness.loginAs(harness.admin);
      await agent.put('/2').send({ sourceId: harness.sourceA, name: 'Open', psk: '', role: 2 });
      const list = await agent.get('/all').query({ sourceId: harness.sourceA });
      expect(list.status).toBe(200);
      const body = Array.isArray(list.body) ? list.body : list.body.data;
      const row = body.find((c: any) => c.id === 2);
      expect(row.encryptionStatus).toBe('none');
    });

    it('clearing the primary also sends 0x00', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put('/0').send({ sourceId: harness.sourceA, name: 'Main', psk: '', role: 1 });
      expect(res.status).toBe(200);
      expect([...pskBytes(decodeSettings(sent[0]))]).toEqual([0]);
    });

    it('an absent psk keeps the stored key on the device and in the row', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put('/2').send({ sourceId: harness.sourceA, name: 'Renamed', role: 2 });
      expect(res.status).toBe(200);
      expect(pskBytes(decodeSettings(sent[0])).toString('base64')).toBe(KEY);
      expect((await harness.db.channels.getChannelById(2, harness.sourceA))!.psk).toBe(KEY);
    });

    it('a null psk keeps the stored key too', async () => {
      const agent = await harness.loginAs(harness.admin);
      await agent.put('/2').send({ sourceId: harness.sourceA, name: 'Renamed', psk: null, role: 2 });
      expect(pskBytes(decodeSettings(sent[0])).toString('base64')).toBe(KEY);
      expect((await harness.db.channels.getChannelById(2, harness.sourceA))!.psk).toBe(KEY);
    });
  });

  describe('meshcore_mqtt sources', () => {
    it('PUT is refused and nothing reaches a device', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put('/1').send({ sourceId: MC_MQTT, name: 'Changed', psk: KEY });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_HAS_NO_DEVICE');
      expect(holder.calls).toBe(0);
      expect(sent).toHaveLength(0);
      expect((await harness.db.channels.getChannelById(1, MC_MQTT))!.name).toBe('Keep');
    });

    it('DELETE is refused and the row stays', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete('/1').query({ sourceId: MC_MQTT });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_HAS_NO_DEVICE');
      expect(await harness.db.channels.getChannelById(1, MC_MQTT)).not.toBeNull();
    });
  });
});
