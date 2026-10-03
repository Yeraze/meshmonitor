/**
 * POST /:id/meshcore/packets/decode — decrypt-on-read for the Packet Monitor
 * decode modal (#5567, #5568).
 *
 * Source A is the one being viewed. Keys live on A, on another source (B), or
 * in the MeshCore virtual-channel database. Frames are really encrypted, and
 * the harness runs real middleware and real SQL, so the access rule under test
 * is the shipping one. Only the manager registry is stubbed.
 *
 * The rule that matters most: a viewer who may not read the key gets the same
 * body as when the server holds no such key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChannelCrypto } from '@michaelhart/meshcore-decoder';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { buildGrpTxtFrame, buildGrpDataFrame, buildAdvertFrame } from '../test-helpers/meshcoreFrames.js';
import type { MeshCoreManager as MeshCoreManagerType } from '../meshcoreManager.js';

const managers = new Map<string, MeshCoreManagerType>();
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn((id: string) => managers.get(id)),
    getAllManagers: vi.fn(() => [...managers.values()]),
  },
}));
vi.mock('../sourceManagerTypes.js', () => ({
  isMeshCoreManager: (m: unknown) => !!m,
  isAnyMeshCoreManager: (m: unknown) => !!m,
  isMeshCoreMqttManager: () => false,
  isMeshtasticManager: () => false,
  getPrimaryMeshtasticManager: () => null,
}));

const { MeshCoreManager } = await import('../meshcoreManager.js');
const { default: meshcoreRoutes } = await import('./meshcoreRoutes.js');
const { MESHCORE_DECODE_MAX_HEX_CHARS } = await import('./meshcorePacketRoutes.js');

const SECRET = '0123456789abcdef0123456789abcdef';
const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const HASH = ChannelCrypto.calculateChannelHash(SECRET);

/** A different 16-byte secret with the SAME 1-byte channel hash as SECRET. */
const COLLIDING = (() => {
  for (let i = 1; i < 100_000; i++) {
    const hex = i.toString(16).padStart(32, '0');
    if (hex !== SECRET && ChannelCrypto.calculateChannelHash(hex) === HASH) return hex;
  }
  throw new Error('no colliding secret found');
})();

const TS = 1_700_000_000;
const FRAME = buildGrpTxtFrame(TS, 'Alice: hello mesh', SECRET);
const UNKNOWN = { decrypted: false, payloadType: 5, channelHash: HASH };

describe('POST /meshcore/packets/decode (#5567, #5568)', () => {
  let harness: RouteTestHarness;
  let A: string;
  let B: string;

  const clearChannelDb = async () => {
    for (const row of await databaseService.channelDatabase.getAllAsync('all')) {
      await databaseService.channelDatabase.deleteAsync(row.id!);
    }
  };
  const clearChannels = async () => {
    for (const src of [A, B]) {
      for (const ch of await databaseService.channels.getAllChannels(src)) {
        await databaseService.channels.deleteChannel(Number(ch.id), src);
      }
    }
  };
  const addVirtual = (name: string, secretHex: string, isEnabled = true) =>
    databaseService.channelDatabase.createAsync({
      name, psk: b64(secretHex), pskLength: 16, protocol: 'meshcore', isEnabled,
    });
  const url = () => `/${A}/meshcore/packets/decode`;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/:id/meshcore', meshcoreRoutes) });
    A = harness.sourceA;
    B = harness.sourceB;
    // The harness seeds Meshtastic sources; these two are MeshCore.
    for (const [id, name] of [[A, 'Repeater'], [B, 'Companion']] as const) {
      await databaseService.sources.deleteSource(id);
      await databaseService.sources.createSource({ id, name, type: 'meshcore', config: {}, enabled: true });
    }
    await clearChannelDb();
    await clearChannels();
    managers.clear();
    managers.set(A, new MeshCoreManager(A));
    managers.set(B, new MeshCoreManager(B));
  });

  afterEach(async () => {
    await clearChannelDb();
    await clearChannels();
    await harness.cleanup();
  });

  describe('key on another source (B)', () => {
    beforeEach(async () => {
      await databaseService.channels.upsertChannel({ id: 3, name: 'ops', psk: b64(SECRET), role: 2 }, B);
    });

    it('admin gets plaintext, the channel name and the key origin, and no secret', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post(url()).send({ rawHex: FRAME });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        data: {
          decrypted: true,
          payloadType: 5,
          channelHash: HASH,
          channelName: 'ops',
          keyOrigin: { kind: 'source', sourceName: 'Companion', currentSource: false },
          text: { sender: 'Alice', timestampSec: TS, text: 'hello mesh' },
        },
      });
      const wire = JSON.stringify(res.body).toLowerCase();
      expect(wire).not.toContain(SECRET);
      expect(wire).not.toContain(b64(SECRET).toLowerCase());
      expect(wire).not.toContain('psk');
    });

    it('a key holder with packetmonitor:read on A gets plaintext', async () => {
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', A);
      await harness.grant(harness.limited.id, 'channel_3', 'read', B);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(url()).send({ rawHex: FRAME });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ decrypted: true, channelName: 'ops', text: { text: 'hello mesh' } });
    });

    it('messages:read on the key source counts as holding the key', async () => {
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', A);
      await harness.grant(harness.limited.id, 'messages', 'read', B);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(url()).send({ rawHex: FRAME });
      expect(res.body.data.decrypted).toBe(true);
    });

    it('a packetmonitor-only viewer gets the SAME body as when no key exists', async () => {
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', A);
      // messages:read on A is not key access: the key lives on B.
      await harness.grant(harness.limited.id, 'messages', 'read', A);
      const agent = await harness.loginAs(harness.limited);

      const noAccess = await agent.post(url()).send({ rawHex: FRAME });
      expect(noAccess.status).toBe(200);
      expect(noAccess.body).toEqual({ success: true, data: UNKNOWN });

      await databaseService.channels.deleteChannel(3, B);
      const noKey = await agent.post(url()).send({ rawHex: FRAME });
      expect(noKey.status).toBe(200);
      expect(noKey.text).toBe(noAccess.text);

      // And the admin, with the key gone, gets that same body too.
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.post(url()).send({ rawHex: FRAME })).text).toBe(noAccess.text);
    });

    it('anonymous never gets plaintext, even with grants that would open it for a user', async () => {
      await harness.grant(harness.anonymous.id, 'packetmonitor', 'read', A);
      await harness.grant(harness.anonymous.id, 'messages', 'read', B);
      await harness.grant(harness.anonymous.id, 'channel_3', 'read', B);
      const anon = await harness.loginAs(null);
      const res = await anon.post(url()).send({ rawHex: FRAME });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: UNKNOWN });
    });

    it('needs packetmonitor:read on the viewed source', async () => {
      await harness.grant(harness.limited.id, 'channel_3', 'read', B);
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', B);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(url()).send({ rawHex: FRAME })).status).toBe(403);
      // The seeded anonymous row may carry default read grants; drop them.
      await harness.revokeAll(harness.anonymous.id);
      const anon = await harness.loginAs(null);
      expect([401, 403]).toContain((await anon.post(url()).send({ rawHex: FRAME })).status);
    });
  });

  describe('channel name and key origin', () => {
    it("prefers this source's slot, then a virtual channel, then another source", async () => {
      await databaseService.channels.upsertChannel({ id: 2, name: 'here', psk: b64(SECRET), role: 2 }, A);
      await databaseService.channels.upsertChannel({ id: 3, name: 'there', psk: b64(SECRET), role: 2 }, B);
      await addVirtual('virtual-ops', SECRET);
      const admin = await harness.loginAs(harness.admin);

      let res = await admin.post(url()).send({ rawHex: FRAME });
      expect(res.body.data).toMatchObject({
        channelName: 'here',
        keyOrigin: { kind: 'source', sourceName: 'Repeater', currentSource: true },
      });

      await databaseService.channels.deleteChannel(2, A);
      res = await admin.post(url()).send({ rawHex: FRAME });
      expect(res.body.data).toMatchObject({ channelName: 'virtual-ops', keyOrigin: { kind: 'virtual' } });

      await clearChannelDb();
      res = await admin.post(url()).send({ rawHex: FRAME });
      expect(res.body.data).toMatchObject({
        channelName: 'there',
        keyOrigin: { kind: 'source', sourceName: 'Companion', currentSource: false },
      });
    });

    it('names only from rows the viewer can read', async () => {
      await databaseService.channels.upsertChannel({ id: 2, name: 'alpha-slot', psk: b64(SECRET), role: 2 }, A);
      await databaseService.channels.upsertChannel({ id: 3, name: 'there', psk: b64(SECRET), role: 2 }, B);
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', A);
      // Can read the key on B only: the name of A's slot must not leak.
      await harness.grant(harness.limited.id, 'channel_3', 'read', B);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(url()).send({ rawHex: FRAME });
      expect(res.body.data).toMatchObject({
        decrypted: true,
        channelName: 'there',
        keyOrigin: { kind: 'source', sourceName: 'Companion', currentSource: false },
      });
      expect(JSON.stringify(res.body)).not.toContain('alpha-slot');
    });
  });

  describe('virtual channel only', () => {
    let vcId: number;
    beforeEach(async () => {
      vcId = await addVirtual('virtual-ops', SECRET);
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', A);
    });

    it('decodes for a viewer with canRead on the entry', async () => {
      await databaseService.channelDatabase.setPermissionAsync({
        userId: harness.limited.id, channelDatabaseId: vcId, canViewOnMap: false, canRead: true,
      });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(url()).send({ rawHex: FRAME });
      expect(res.body.data).toMatchObject({
        decrypted: true,
        channelName: 'virtual-ops',
        keyOrigin: { kind: 'virtual' },
        text: { sender: 'Alice', text: 'hello mesh' },
      });
    });

    it('stays unknown without canRead, and with canRead false', async () => {
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(url()).send({ rawHex: FRAME })).body).toEqual({ success: true, data: UNKNOWN });
      await databaseService.channelDatabase.setPermissionAsync({
        userId: harness.limited.id, channelDatabaseId: vcId, canViewOnMap: true, canRead: false,
      });
      expect((await agent.post(url()).send({ rawHex: FRAME })).body).toEqual({ success: true, data: UNKNOWN });
    });

    it('decodes for an admin', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post(url()).send({ rawHex: FRAME });
      expect(res.body.data).toMatchObject({ decrypted: true, keyOrigin: { kind: 'virtual' } });
    });

    it('a disabled virtual channel does not decrypt', async () => {
      await clearChannelDb();
      await addVirtual('virtual-ops', SECRET, false);
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.post(url()).send({ rawHex: FRAME })).body).toEqual({ success: true, data: UNKNOWN });
    });
  });

  describe('two keys with the same channel hash', () => {
    const FRAME_2 = buildGrpTxtFrame(TS, 'Bob: second key', COLLIDING);

    beforeEach(async () => {
      expect(ChannelCrypto.calculateChannelHash(COLLIDING)).toBe(HASH);
      await databaseService.channels.upsertChannel({ id: 1, name: 'first', psk: b64(SECRET), role: 2 }, B);
      await databaseService.channels.upsertChannel({ id: 2, name: 'second', psk: b64(COLLIDING), role: 2 }, B);
    });

    it('admin opens each frame with the key whose MAC verifies', async () => {
      const admin = await harness.loginAs(harness.admin);
      const one = await admin.post(url()).send({ rawHex: FRAME });
      expect(one.body.data).toMatchObject({ channelName: 'first', text: { text: 'hello mesh' } });
      const two = await admin.post(url()).send({ rawHex: FRAME_2 });
      expect(two.body.data).toMatchObject({ channelName: 'second', text: { sender: 'Bob', text: 'second key' } });
    });

    it('a viewer holding only one of them opens only that one', async () => {
      await harness.grant(harness.limited.id, 'packetmonitor', 'read', A);
      await harness.grant(harness.limited.id, 'channel_2', 'read', B);
      const agent = await harness.loginAs(harness.limited);
      const two = await agent.post(url()).send({ rawHex: FRAME_2 });
      expect(two.body.data).toMatchObject({ decrypted: true, channelName: 'second' });
      const one = await agent.post(url()).send({ rawHex: FRAME });
      expect(one.body).toEqual({ success: true, data: UNKNOWN });
    });
  });

  describe('GRP_DATA', () => {
    it('verifies the MAC, decrypts, and returns the data type and body', async () => {
      await databaseService.channels.upsertChannel({ id: 3, name: 'ops', psk: b64(SECRET), role: 2 }, A);
      const body = Buffer.from('sensor=42;\x00\x01\xff', 'latin1');
      const frame = buildGrpDataFrame(0x1234, body, SECRET);
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post(url()).send({ rawHex: frame });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        decrypted: true,
        payloadType: 6,
        channelHash: HASH,
        channelName: 'ops',
        keyOrigin: { kind: 'source', sourceName: 'Repeater', currentSource: true },
        data: { dataType: 0x1234, dataHex: body.toString('hex') },
      });
    });

    it('is unknown without the key, in the same shape as GRP_TXT', async () => {
      const frame = buildGrpDataFrame(1, Buffer.from('x'), SECRET);
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post(url()).send({ rawHex: frame });
      expect(res.body).toEqual({ success: true, data: { decrypted: false, payloadType: 6, channelHash: HASH } });
    });
  });

  describe('input checks', () => {
    it('rejects an oversized rawHex with 413', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post(url()).send({ rawHex: 'ab'.repeat(MESHCORE_DECODE_MAX_HEX_CHARS / 2 + 1) });
      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({ success: false, code: 'PAYLOAD_TOO_LARGE' });
    });

    it('rejects a missing, odd-length or non-hex rawHex with 400', async () => {
      const admin = await harness.loginAs(harness.admin);
      for (const body of [{}, { rawHex: 5 }, { rawHex: '' }, { rawHex: 'abc' }, { rawHex: 'zz11' }]) {
        const res = await admin.post(url()).send(body);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ success: false, code: 'INVALID_RAW_HEX' });
      }
    });

    it('rejects a packet that is not GRP_TXT / GRP_DATA with 400', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post(url()).send({ rawHex: buildAdvertFrame({ publicKey: '11'.repeat(32), name: 'n' }) });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'NOT_GROUP_PACKET' });
      // Too short to carry a group header.
      const short = await admin.post(url()).send({ rawHex: '1500aa' });
      expect(short.status).toBe(400);
    });

    it('a tampered frame (bad MAC) stays unknown', async () => {
      await databaseService.channels.upsertChannel({ id: 3, name: 'ops', psk: b64(SECRET), role: 2 }, A);
      const tampered = FRAME.slice(0, -2) + (FRAME.endsWith('00') ? '01' : '00');
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.post(url()).send({ rawHex: tampered })).body).toEqual({ success: true, data: UNKNOWN });
    });
  });
});
