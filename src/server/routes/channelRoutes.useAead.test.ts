/**
 * Channel edits and ChannelSettings.use_aead (#5248).
 *
 * Phase 1: set_channel replaces the whole ChannelSettings on the device, so a
 * save that omits the flag must send the stored one back, or it silently turns
 * AES-CCM off. Phase 2b: the body may set it; turning it on needs firmware
 * 2.8.1+ and a key.
 *
 * Real-middleware harness against real SQLite. The device manager is the only
 * mock, and its setChannelConfig runs the REAL DeviceAdminService, so the
 * assertion reads the actual set_channel bytes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const holder: { setChannelConfig: (i: number, c: any) => Promise<void>; aead: boolean } = {
  setChannelConfig: async () => {},
  aead: true,
};
const fakeManager = () => ({
  setChannelConfig: (i: number, c: any) => holder.setChannelConfig(i, c),
  supportsAeadChannels: () => holder.aead,
});
vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: () => fakeManager(),
  resolveOwnMeshtasticManager: () => fakeManager(),
}));

import channelRoutes from './channelRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { DeviceAdminService } from '../services/deviceAdminService.js';
import protobufService from '../protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from '../protobufLoader.js';

const KEY = Buffer.alloc(16, 5).toString('base64');

describe('channel edits preserve use_aead (#5248)', () => {
  let harness: RouteTestHarness;
  let sent: Uint8Array[];

  const decodeSettings = (bytes: Uint8Array) => {
    const AdminMessage = getProtobufRoot()!.lookupType('meshtastic.AdminMessage');
    return (AdminMessage.toObject(AdminMessage.decode(bytes), { defaults: true, oneofs: true }) as any).setChannel.settings;
  };

  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', channelRoutes) });
    sent = [];
    holder.aead = true;
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
    // Device ingest stored AEAD on for source A's slot 2; source B's same slot is plain.
    await harness.db.channels.upsertChannel({ id: 2, name: 'Secure', psk: KEY, role: 2, useAead: true }, harness.sourceA);
    await harness.db.channels.upsertChannel({ id: 2, name: 'Secure', psk: KEY, role: 2, useAead: false }, harness.sourceB);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  it('a Channels-tab save (no useAead in the body) sends use_aead=true back to the device', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put('/2').send({ sourceId: harness.sourceA, name: 'Renamed', psk: KEY, role: 2 });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const settings = decodeSettings(sent[0]);
    expect(settings.name).toBe('Renamed');
    expect(settings.useAead).toBe(true);

    expect((await harness.db.channels.getChannelById(2, harness.sourceA))!.useAead).toBe(true);
    expect((await harness.db.channels.getChannelById(2, harness.sourceB))!.useAead).toBe(false);
  });

  it('a second edit still keeps it (save -> edit -> edit)', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.put('/2').send({ sourceId: harness.sourceA, name: 'One', psk: KEY, role: 2 });
    await agent.put('/2').send({ sourceId: harness.sourceA, name: 'Two', psk: KEY, role: 2, uplinkEnabled: true });
    expect(sent).toHaveLength(2);
    expect(decodeSettings(sent[1]).useAead).toBe(true);
    expect(decodeSettings(sent[1]).uplinkEnabled).toBe(true);
  });

  it('the body can turn it off (Phase 2b), on any firmware', async () => {
    holder.aead = false;
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put('/2').send({ sourceId: harness.sourceA, name: 'Secure', psk: KEY, role: 2, useAead: false });
    expect(res.status).toBe(200);
    expect(decodeSettings(sent[0]).useAead).toBe(false);
    expect((await harness.db.channels.getChannelById(2, harness.sourceA))!.useAead).toBe(false);
  });

  it('the body can turn it on when the node runs 2.8.1+ and the channel has a key', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put('/2').send({ sourceId: harness.sourceB, name: 'Secure', psk: KEY, role: 2, useAead: true });
    expect(res.status).toBe(200);
    expect(decodeSettings(sent[0]).useAead).toBe(true);
    expect((await harness.db.channels.getChannelById(2, harness.sourceB))!.useAead).toBe(true);
  });

  it('refuses to turn it on before firmware 2.8.1, and sends nothing', async () => {
    holder.aead = false;
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put('/2').send({ sourceId: harness.sourceB, name: 'Secure', psk: KEY, role: 2, useAead: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AEAD_UNSUPPORTED');
    expect(sent).toHaveLength(0);
    expect((await harness.db.channels.getChannelById(2, harness.sourceB))!.useAead).toBe(false);
  });

  it('refuses to turn it on for a channel with no key', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put('/2').send({ sourceId: harness.sourceB, name: 'Secure', psk: '', role: 2, useAead: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AEAD_NEEDS_KEY');
    expect(sent).toHaveLength(0);
  });

  it('single-channel export includes useAead, and importing it into another slot sends it', async () => {
    const agent = await harness.loginAs(harness.admin);
    const exp = await agent.get('/2/export').query({ sourceId: harness.sourceA });
    expect(exp.status).toBe(200);
    const exported = JSON.parse(exp.text);
    expect(exported.channel.useAead).toBe(true);

    const imp = await agent.post('/4/import').send({ sourceId: harness.sourceA, channel: { ...exported.channel, id: undefined } });
    expect(imp.status).toBe(200);
    expect(decodeSettings(sent[0]).useAead).toBe(true);
    expect((await harness.db.channels.getChannelById(4, harness.sourceA))!.useAead).toBe(true);
  });

  it('an older export without useAead keeps the target slot\'s stored flag', async () => {
    const agent = await harness.loginAs(harness.admin);
    const imp = await agent.post('/2/import').send({
      sourceId: harness.sourceA,
      channel: { name: 'OldFile', psk: KEY, role: 2, uplinkEnabled: false, downlinkEnabled: false },
    });
    expect(imp.status).toBe(200);
    expect(decodeSettings(sent[0]).useAead).toBe(true);
    expect((await harness.db.channels.getChannelById(2, harness.sourceA))!.useAead).toBe(true);
  });
});
