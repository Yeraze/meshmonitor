/**
 * MeshCore channel share / import over the shared channel routes (#6257 P8a WP3).
 * Real session + auth + permission rows (createRouteTestApp); only the manager
 * lookup is stubbed (no radio).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import channelRoutes from './channelRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import databaseService from '../../services/database.js';
import { decodeMeshcoreChannelUrl } from '../../utils/meshcoreChannelUrl.js';

const SECRET_A = '00112233445566778899aabbccddeeff';
const SECRET_B = 'ffeeddccbbaa99887766554433221100';
const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

// MeshCoreDeviceType: COMPANION = 1, REPEATER = 2 (see meshcoreManager.ts)
const COMPANION = 1;
const REPEATER = 2;

let harness: RouteTestHarness;
let mc: ReturnType<typeof makeMc>;

function makeMc(sourceId: string, opts: { connected?: boolean; deviceType?: number; maxChannels?: number } = {}) {
  return {
    sourceId,
    sourceType: 'meshcore' as const,
    setChannel: vi.fn().mockResolvedValue(undefined),
    getConnectionStatus: () => ({ connected: opts.connected ?? true, deviceType: opts.deviceType ?? COMPANION }),
    getLocalNode: () => ({ maxChannels: opts.maxChannels ?? 8 }),
    isReceiveOnly: () => false,
    canTransmit: () => true,
  };
}

async function seedChannel(id: number, name: string, secretHex: string, scope?: string) {
  await databaseService.channels.upsertChannel(
    { id, name, psk: b64(secretHex), role: 2, ...(scope ? { scope } : {}) } as never,
    harness.sourceA,
  );
}

async function clearChannels() {
  for (let i = 0; i < 10; i++) await databaseService.channels.deleteChannel(i, 'rt-source-a').catch(() => undefined);
}

function useMc(m: ReturnType<typeof makeMc> | null) {
  vi.spyOn(sourceManagerRegistry, 'getManager').mockImplementation(((id: string) =>
    id === 'rt-source-a' && m ? m : undefined) as never);
}

beforeEach(async () => {
  harness = await createRouteTestApp({ mount: (app) => app.use('/channels', channelRoutes) });
  await clearChannels();
  mc = makeMc('rt-source-a');
  useMc(mc);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearChannels();
  await harness.cleanup();
});

describe('POST /channels/encode-url (MeshCore)', () => {
  it('needs configuration:write on THAT source (403 for another source grant, and for read-only)', async () => {
    await seedChannel(1, 'Alpha', SECRET_A);
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/channels/encode-url').send({ sourceId: harness.sourceA, channelIds: [1] });
    expect(res.status).toBe(403);
  });

  it('returns a share URL for a write holder, with region_scope when set', async () => {
    await seedChannel(1, 'Alpha', SECRET_A, 'bayern');
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/channels/encode-url').send({ sourceId: harness.sourceA, channelIds: [1] });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(`meshcore://channel/add?name=Alpha&secret=${SECRET_A}&region_scope=bayern`);
    const back = await decodeMeshcoreChannelUrl(res.body.url);
    expect(back.ok && back.channel.regionScope).toBe('bayern');
  });

  it('omits region_scope when the channel has none', async () => {
    await seedChannel(2, '#general', SECRET_B);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/encode-url').send({ sourceId: harness.sourceA, channelIds: [2] });
    expect(res.body.url).toBe(`meshcore://channel/add?name=%23general&secret=${SECRET_B}`);
  });

  it('400 for more than one channel, 404 for an unknown one', async () => {
    await seedChannel(1, 'Alpha', SECRET_A);
    const agent = await harness.loginAs(harness.admin);
    const multi = await agent.post('/channels/encode-url').send({ sourceId: harness.sourceA, channelIds: [1, 2] });
    expect(multi.status).toBe(400);
    expect(multi.body.code).toBe('MESHCORE_SINGLE_CHANNEL');
    const missing = await agent.post('/channels/encode-url').send({ sourceId: harness.sourceA, channelIds: [5] });
    expect(missing.status).toBe(404);
  });

  it('409 when the source is disconnected, 400 for a Repeater', async () => {
    const agent = await harness.loginAs(harness.admin);
    useMc(makeMc('rt-source-a', { connected: false }));
    const down = await agent.post('/channels/encode-url').send({ sourceId: harness.sourceA, channelIds: [1] });
    expect(down.status).toBe(409);
    expect(down.body.code).toBe('SOURCE_NOT_CONNECTED');
    useMc(makeMc('rt-source-a', { deviceType: REPEATER }));
    const rep = await agent.post('/channels/encode-url').send({ sourceId: harness.sourceA, channelIds: [1] });
    expect(rep.status).toBe(400);
    expect(rep.body.code).toBe('SOURCE_NOT_COMPANION');
  });
});

describe('POST /channels/decode-url (MeshCore)', () => {
  it('returns the decoded fields, and a target preview for a write holder', async () => {
    await seedChannel(1, 'Alpha', SECRET_A);
    const agent = await harness.loginAs(harness.admin);
    const url = `meshcore://channel/add?name=Beta&secret=${SECRET_B}&region_scope=ost`;
    const res = await agent.post('/channels/decode-url').send({ url, sourceId: harness.sourceA });
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe('meshcore');
    expect(res.body.channels[0]).toMatchObject({ name: 'Beta', secretHex: SECRET_B, regionScope: 'ost' });
    expect(res.body.target).toEqual({ kind: 'new', slot: 2 });
  });

  it('gives no target to a caller without configuration:write on the source', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/channels/decode-url').send({
      url: `meshcore://channel/add?name=Beta&secret=${SECRET_B}`, sourceId: harness.sourceA,
    });
    expect(res.status).toBe(200);
    expect(res.body.target).toBeUndefined();
  });

  it('400 with a code for a bad secret', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/decode-url').send({ url: `meshcore://channel/add?name=a&secret=${'0'.repeat(32)}` });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MESHCORE_URL_SECRET_ALL_ZERO');
  });
});

describe('POST /channels/import-config (MeshCore)', () => {
  const urlFor = (name: string, secret: string, scope?: string) =>
    `meshcore://channel/add?name=${encodeURIComponent(name)}&secret=${secret}${scope ? `&region_scope=${scope}` : ''}`;

  it('imports into the lowest free slot >= 1 and passes the scope', async () => {
    await seedChannel(1, 'Alpha', SECRET_A);
    await seedChannel(3, 'Gamma', 'ab'.repeat(16));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Beta', SECRET_B, 'ost') });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, slot: 2, alreadyPresent: false, requiresReboot: false });
    expect(mc.setChannel).toHaveBeenCalledWith(2, 'Beta', SECRET_B, 'ost');
  });

  it('never targets slot 0 (empty table -> slot 1) and clears scope when the URL has none', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Beta', SECRET_B) });
    expect(res.body.slot).toBe(1);
    expect(mc.setChannel).toHaveBeenCalledWith(1, 'Beta', SECRET_B, null);
  });

  it('reports the existing slot for an equal secret and writes nothing', async () => {
    await seedChannel(4, 'Same', SECRET_B);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Other name', SECRET_B) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alreadyPresent: true, slot: 4 });
    expect(mc.setChannel).not.toHaveBeenCalled();
  });

  it('409 NO_FREE_CHANNEL_SLOT when slots 1..maxChannels-1 are full', async () => {
    useMc(makeMc('rt-source-a', { maxChannels: 4 }));
    await seedChannel(1, 'a', '01'.repeat(16));
    await seedChannel(2, 'b', '02'.repeat(16));
    await seedChannel(3, 'c', '03'.repeat(16));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Beta', SECRET_B) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_FREE_CHANNEL_SLOT');
  });

  it('uses the device maxChannels, not a 255 fallback', async () => {
    useMc(makeMc('rt-source-a', { maxChannels: 2 }));
    await seedChannel(1, 'a', '01'.repeat(16));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Beta', SECRET_B) });
    expect(res.status).toBe(409);
  });

  it('needs configuration:write on the source, plus channel_N:write for the target slot', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const denied = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Beta', SECRET_B) });
    expect(denied.status).toBe(403);
    expect(denied.body.required).toEqual({ resource: 'channel_1', action: 'write' });
    expect(mc.setChannel).not.toHaveBeenCalled();
    await harness.grant(harness.limited.id, 'channel_1', 'write', harness.sourceA);
    const ok = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Beta', SECRET_B) });
    expect(ok.status).toBe(200);
  });

  it('403 for a write grant on a different source', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Beta', SECRET_B) });
    expect(res.status).toBe(403);
  });

  it('502 when the device write fails', async () => {
    mc.setChannel.mockRejectedValueOnce(new Error('boom'));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Beta', SECRET_B) });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('DEVICE_WRITE_FAILED');
  });

  it('400 PROTOCOL_MISMATCH for a Meshtastic URL on a MeshCore source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: 'https://meshtastic.org/e/#CgMSAQE' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROTOCOL_MISMATCH');
  });

  it('400 for a malformed MeshCore URL', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/import-config').send({ sourceId: harness.sourceA, url: urlFor('Beta', 'ab'.repeat(32)) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MESHCORE_URL_SECRET_WRONG_LENGTH');
  });
});

describe('device-source gate default stays Meshtastic-only', () => {
  it('a Meshtastic-only route (default accept) still refuses a MeshCore source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/channels/refresh').send({ sourceId: harness.sourceA });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
  });
});
