/**
 * MeshCore virtual channels in the channel database (#5552).
 *
 * Real middleware + real SQL via the route harness. Covers: create with
 * MeshCore secret rules (never the Meshtastic PSK rules), dedupe by secret,
 * the opt-in "import from device", default-deny on new rows, the protocol
 * filter that keeps MeshCore rows away from every Meshtastic list consumer,
 * and that a virtual-channel grant is what opens traffic decrypted with it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

const processForChannel = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/channelDecryptionService.js', () => ({
  channelDecryptionService: { invalidateCache: vi.fn() },
}));
vi.mock('../services/retroactiveDecryptionService.js', () => ({
  retroactiveDecryptionService: {
    processForChannel: (...a: unknown[]) => processForChannel(...a),
    getProgress: vi.fn().mockReturnValue(null),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

import channelDatabaseRoutes from './channelDatabaseRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { channelKeyFingerprint, decryptGroupTextFrame, keyedChannelIndex } from '../services/meshcoreFrameIngest.js';
import { resolveMeshcoreKeyAccess } from '../utils/meshcoreKeyAccess.js';
import { listKeyedChannelsForViewer } from '../utils/meshcoreKeyedChannels.js';
import { decodeMeshCorePacket } from '../../utils/meshcorePacketDecode.js';
import { buildGrpTxtFrame } from '../test-helpers/meshcoreFrames.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const SECRET_B64 = Buffer.from(SECRET, 'hex').toString('base64');
const OTHER = 'fedcba9876543210fedcba9876543210';
const hashtagSecret = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, 32);

describe('MeshCore virtual channels (#5552)', () => {
  let harness: RouteTestHarness;

  const clearChannelDb = async () => {
    for (const row of await databaseService.channelDatabase.getAllAsync('all')) {
      await databaseService.channelDatabase.deleteAsync(row.id!);
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/channel-database', channelDatabaseRoutes) });
    await clearChannelDb();
    processForChannel.mockClear();
  });
  afterEach(async () => {
    await clearChannelDb();
    await harness.cleanup();
  });

  describe('create', () => {
    it('stores a hex secret as a meshcore row and runs no Meshtastic retroactive decrypt', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/channel-database').send({ name: 'ops', psk: SECRET, protocol: 'meshcore' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ name: 'ops', protocol: 'meshcore', pskLength: 16, psk: SECRET_B64 });
      expect(processForChannel).not.toHaveBeenCalled();
    });

    it('accepts Base64 too', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/channel-database').send({ name: 'ops', psk: SECRET_B64, protocol: 'meshcore' });
      expect(res.status).toBe(201);
      expect(res.body.data.psk).toBe(SECRET_B64);
    });

    it('derives a #hashtag secret from the name when none is given', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/channel-database').send({ name: '#general', protocol: 'meshcore' });
      expect(res.status).toBe(201);
      expect(Buffer.from(res.body.data.psk, 'base64').toString('hex')).toBe(hashtagSecret('#general'));
    });

    it.each([
      ['a Meshtastic 1-byte shorthand', 'AQ=='],
      ['a 32-byte key', Buffer.alloc(32, 1).toString('base64')],
      ['an all-zero secret', '00'.repeat(16)],
      ['a short hex string', 'abcd'],
    ])('rejects %s', async (_label, psk) => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/channel-database').send({ name: 'bad', psk, protocol: 'meshcore' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SECRET');
    });

    it('rejects a missing secret on a non-hashtag name', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/channel-database').send({ name: 'plain', protocol: 'meshcore' });
      expect(res.status).toBe(400);
    });

    it('dedupes by secret: a second row with the same key is refused, whatever its name', async () => {
      const admin = await harness.loginAs(harness.admin);
      const first = await admin.post('/channel-database').send({ name: 'ops', psk: SECRET, protocol: 'meshcore' });
      const second = await admin.post('/channel-database').send({ name: 'ops again', psk: SECRET_B64, protocol: 'meshcore' });
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'DUPLICATE_SECRET', existingId: first.body.data.id });
      // The same #room twice is the same derived secret.
      await admin.post('/channel-database').send({ name: '#general', protocol: 'meshcore' });
      const dupRoom = await admin.post('/channel-database').send({ name: '#general', psk: hashtagSecret('#general'), protocol: 'meshcore' });
      expect(dupRoom.status).toBe(409);
    });

    it('leaves Meshtastic creation untouched: shorthand PSK allowed, retroactive decrypt started', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/channel-database').send({ name: 'LongFast', psk: 'AQ==' });
      expect(res.status).toBe(201);
      expect(res.body.data.protocol).toBe('meshtastic');
      expect(processForChannel).toHaveBeenCalledTimes(1);
      // The same bytes as a MeshCore secret are a different thing, not a duplicate.
      const mt16 = await admin.post('/channel-database').send({ name: 'mt16', psk: SECRET_B64 });
      const mc16 = await admin.post('/channel-database').send({ name: 'mc16', psk: SECRET_B64, protocol: 'meshcore' });
      expect(mt16.status).toBe(201);
      expect(mc16.status).toBe(201);
    });

    it('needs channel_database:write', async () => {
      const limited = await harness.loginAs(harness.limited);
      const res = await limited.post('/channel-database').send({ name: 'ops', psk: SECRET, protocol: 'meshcore' });
      expect(res.status).toBe(403);
    });
  });

  describe('list', () => {
    it('hides MeshCore rows unless asked, so Meshtastic consumers never see them', async () => {
      const admin = await harness.loginAs(harness.admin);
      await admin.post('/channel-database').send({ name: 'LongFast', psk: 'AQ==' });
      await admin.post('/channel-database').send({ name: 'ops', psk: SECRET, protocol: 'meshcore' });

      const names = async (q: string) =>
        (await admin.get(`/channel-database${q}`)).body.data.map((c: { name: string }) => c.name).sort();
      expect(await names('')).toEqual(['LongFast']);
      expect(await names('?protocol=meshcore')).toEqual(['ops']);
      expect(await names('?protocol=all')).toEqual(['LongFast', 'ops']);
      expect((await admin.get('/channel-database?protocol=bogus')).status).toBe(400);
    });

    it('masks the secret for a reader and shows it only to writers', async () => {
      const admin = await harness.loginAs(harness.admin);
      const created = await admin.post('/channel-database').send({ name: 'ops', psk: SECRET, protocol: 'meshcore' });
      await databaseService.channelDatabase.setPermissionAsync({
        userId: harness.limited.id, channelDatabaseId: created.body.data.id, canViewOnMap: false, canRead: true,
      });
      const limited = await harness.loginAs(harness.limited);
      const res = await limited.get('/channel-database?protocol=meshcore');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].psk).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(SECRET_B64);
    });
  });

  describe('update / retroactive decrypt', () => {
    it('keeps MeshCore secret rules and the one-row-per-secret rule on edit', async () => {
      const admin = await harness.loginAs(harness.admin);
      const a = await admin.post('/channel-database').send({ name: 'a', psk: SECRET, protocol: 'meshcore' });
      const b = await admin.post('/channel-database').send({ name: 'b', psk: OTHER, protocol: 'meshcore' });

      expect((await admin.put(`/channel-database/${b.body.data.id}`).send({ psk: 'AQ==' })).status).toBe(400);
      const clash = await admin.put(`/channel-database/${b.body.data.id}`).send({ psk: SECRET });
      expect(clash.status).toBe(409);
      // Re-saving a row's own secret is not a clash.
      expect((await admin.put(`/channel-database/${a.body.data.id}`).send({ name: 'renamed', psk: SECRET_B64 })).status).toBe(200);
      expect(processForChannel).not.toHaveBeenCalled();
    });

    it('refuses retroactive decrypt for a MeshCore row', async () => {
      const admin = await harness.loginAs(harness.admin);
      const a = await admin.post('/channel-database').send({ name: 'a', psk: SECRET, protocol: 'meshcore' });
      const res = await admin.post(`/channel-database/${a.body.data.id}/retroactive-decrypt`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NOT_MESHTASTIC');
    });
  });

  describe('import from device', () => {
    const MC = 'rt-mc-device';
    beforeEach(async () => {
      await databaseService.sources.deleteSource(MC).catch(() => undefined);
      await databaseService.sources.createSource({ id: MC, name: 'Companion', type: 'meshcore', config: {}, enabled: true });
      await databaseService.channels.upsertChannel({ id: 0, name: 'Public', psk: SECRET_B64, role: 1 }, MC);
      await databaseService.channels.upsertChannel({ id: 1, name: '#general', psk: hashtagSecret('#general'), role: 2 }, MC);
      // Same key in a second slot: one row per secret.
      await databaseService.channels.upsertChannel({ id: 2, name: 'Public copy', psk: SECRET, role: 2 }, MC);
    });
    afterEach(async () => {
      for (const id of [0, 1, 2]) await databaseService.channels.deleteChannel(id, MC);
      await databaseService.sources.deleteSource(MC).catch(() => undefined);
    });

    it("copies the device's channels as meshcore rows, deduped by secret, and returns no key", async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/channel-database/import-meshcore').send({ sourceId: MC });
      expect(res.status).toBe(200);
      expect(res.body.data.imported.map((c: { name: string }) => c.name).sort()).toEqual(['#general', 'Public']);
      expect(res.body.data.skipped).toEqual([{ name: 'Public copy', reason: 'duplicate' }]);
      expect(JSON.stringify(res.body)).not.toContain(SECRET_B64);

      const rows = await databaseService.channelDatabase.getAllAsync('meshcore');
      expect(rows.map((r) => r.protocol)).toEqual(['meshcore', 'meshcore']);
      // Meshtastic readers still see nothing.
      expect(await databaseService.channelDatabase.getEnabledAsync()).toEqual([]);

      // A second import adds nothing.
      const again = await admin.post('/channel-database/import-meshcore').send({ sourceId: MC });
      expect(again.body.data.imported).toEqual([]);
      expect(again.body.data.skipped).toHaveLength(3);
    });

    it('is default-deny: imported rows carry no user grants', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/channel-database/import-meshcore').send({ sourceId: MC });
      for (const row of res.body.data.imported as Array<{ id: number }>) {
        expect(await databaseService.channelDatabase.getPermissionsForChannelAsync(row.id)).toEqual([]);
      }
      expect(await resolveMeshcoreKeyAccess({ id: harness.limited.id, isAdmin: false })).toEqual([]);
    });

    it('does not mirror: a later device change leaves the database alone', async () => {
      const admin = await harness.loginAs(harness.admin);
      await admin.post('/channel-database/import-meshcore').send({ sourceId: MC });
      await databaseService.channels.deleteChannel(1, MC);
      await databaseService.channels.upsertChannel({ id: 5, name: 'late', psk: OTHER, role: 2 }, MC);
      const names = (await databaseService.channelDatabase.getAllAsync('meshcore')).map((r) => r.name).sort();
      expect(names).toEqual(['#general', 'Public']);
      await databaseService.channels.deleteChannel(5, MC);
    });

    it('refuses a non-MeshCore source, an unknown source and a caller without write', async () => {
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.post('/channel-database/import-meshcore').send({ sourceId: harness.sourceA })).status).toBe(400);
      expect((await admin.post('/channel-database/import-meshcore').send({ sourceId: 'nope' })).status).toBe(404);
      expect((await admin.post('/channel-database/import-meshcore').send({})).status).toBe(400);
      const limited = await harness.loginAs(harness.limited);
      expect((await limited.post('/channel-database/import-meshcore').send({ sourceId: MC })).status).toBe(403);
    });
  });

  describe('decrypt and read gate', () => {
    it('a virtual channel key decrypts GRP_TXT, and only a granted user may read the result', async () => {
      const admin = await harness.loginAs(harness.admin);
      const created = await admin.post('/channel-database').send({ name: 'vc', psk: SECRET, protocol: 'meshcore' });
      const id = created.body.data.id as number;

      const group = decodeMeshCorePacket(buildGrpTxtFrame(1_700_000_000, 'Alice: via virtual', SECRET))!.payload.groupText!;
      const plain = await decryptGroupTextFrame(group);
      expect(plain).toMatchObject({
        text: 'via virtual',
        key: { sourceId: null, channelIdx: null, channelDbId: id, name: 'vc' },
      });

      // Store it the way the repeater path does, on source A.
      const A = harness.sourceA;
      await databaseService.sources.deleteSource(A);
      await databaseService.sources.createSource({ id: A, name: 'Repeater', type: 'meshcore', config: {}, enabled: true });
      await databaseService.meshcore.insertMessage({
        id: 'vc_msg_1', fromPublicKey: `channel-${keyedChannelIndex(SECRET)}`, text: 'via virtual',
        timestamp: 1, keyFingerprint: channelKeyFingerprint(SECRET), createdAt: 1,
      }, A);
      await harness.grant(harness.limited.id, 'messages', 'read', A);
      const limited = { id: harness.limited.id, isAdmin: false };

      // Default-deny: access to the repeater source alone opens nothing.
      expect(await resolveMeshcoreKeyAccess(limited)).toEqual([]);
      expect(await listKeyedChannelsForViewer(limited, A)).toEqual([]);

      await databaseService.channelDatabase.setPermissionAsync({
        userId: harness.limited.id, channelDatabaseId: id, canViewOnMap: false, canRead: true,
      });
      expect(await resolveMeshcoreKeyAccess(limited)).toEqual([channelKeyFingerprint(SECRET)]);
      expect(await listKeyedChannelsForViewer(limited, A)).toEqual([
        { id: keyedChannelIndex(SECRET), name: 'vc', keyFingerprint: channelKeyFingerprint(SECRET) },
      ]);

      // A disabled row stops decrypting new traffic.
      await admin.put(`/channel-database/${id}`).send({ isEnabled: false });
      expect(await decryptGroupTextFrame(group)).toBeNull();

      await databaseService.meshcore.deleteAllMessagesForSource(A);
    });

    it('a Meshtastic row with the same bytes never decrypts MeshCore traffic', async () => {
      const admin = await harness.loginAs(harness.admin);
      await admin.post('/channel-database').send({ name: 'mt', psk: SECRET_B64 });
      const group = decodeMeshCorePacket(buildGrpTxtFrame(1_700_000_000, 'Alice: nope', SECRET))!.payload.groupText!;
      expect(await decryptGroupTextFrame(group)).toBeNull();
    });
  });
});
