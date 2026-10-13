/**
 * Route tests (#5777) — GET/POST /config/autoadd-config and
 * POST /contacts/remove-non-favorites. Real-middleware harness; only the
 * source-manager registry is stubbed (per-source spies).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const h = vi.hoisted(() => ({
  stubs: new Map<string, Record<string, any>>(),
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => h.stubs.get(id),
    getAllManagers: () => Array.from(h.stubs.values()),
  },
}));

const CONFIG = {
  supported: true,
  overwriteOldest: true,
  types: { chat: true, repeater: false, room: false, sensor: false },
  maxHops: 3,
};

function stub(sourceId: string) {
  return {
    sourceId,
    sourceType: 'meshcore' as const,
    isReceiveOnly: () => false,
    canTransmit: () => true,
    getAutoAddConfig: vi.fn().mockResolvedValue({ ok: true, config: CONFIG }),
    setAutoAddConfig: vi.fn().mockResolvedValue({ ok: true, config: CONFIG }),
    removeNonFavoriteContacts: vi.fn().mockResolvedValue({ status: 'done', removed: 2, kept: 1, failed: 0, total: 3 }),
  };
}

describe('MeshCore auto-add routes (#5777)', () => {
  let harness: RouteTestHarness;
  const cfg = (sid: string) => `/sources/${sid}/meshcore/config/autoadd-config`;
  const rm = (sid: string) => `/sources/${sid}/meshcore/contacts/remove-non-favorites`;

  beforeEach(async () => {
    h.stubs.clear();
    h.stubs.set('rt-source-a', stub('rt-source-a'));
    h.stubs.set('rt-source-b', stub('rt-source-b'));
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const a = () => h.stubs.get(harness.sourceA)!;
  const b = () => h.stubs.get(harness.sourceB)!;

  describe('GET /config/autoadd-config', () => {
    it('needs nodes:read on this source', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(cfg(harness.sourceA))).status).toBe(403);
      expect(a().getAutoAddConfig).not.toHaveBeenCalled();
    });

    it('returns the config in the envelope', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(cfg(harness.sourceA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: CONFIG });
      expect(b().getAutoAddConfig).not.toHaveBeenCalled();
    });

    it('answers supported:false as a normal 200', async () => {
      a().getAutoAddConfig.mockResolvedValue({ ok: true, config: { ...CONFIG, supported: false } });
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).get(cfg(harness.sourceA));
      expect(res.status).toBe(200);
      expect(res.body.data.supported).toBe(false);
    });

    it('409 SOURCE_NOT_CONNECTED when the source is down', async () => {
      a().getAutoAddConfig.mockResolvedValue({ ok: false, error: 'Auto-add options need a connected Companion radio' });
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).get(cfg(harness.sourceA));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
    });
  });

  describe('POST /config/autoadd-config', () => {
    it('rejects anonymous callers', async () => {
      const anon = await harness.loginAs(null);
      expect((await anon.post(cfg(harness.sourceA)).send({ maxHops: 1 })).status).toBe(401);
    });

    it('needs configuration:write on THIS source', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(cfg(harness.sourceA)).send({ maxHops: 1 })).status).toBe(403);
      expect(a().setAutoAddConfig).not.toHaveBeenCalled();
      expect(b().setAutoAddConfig).not.toHaveBeenCalled();
    });

    it('passes the patch to this source only', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post(cfg(harness.sourceA))
        .send({ overwriteOldest: true, types: { room: true }, maxHops: 64 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: CONFIG });
      expect(a().setAutoAddConfig).toHaveBeenCalledWith({ overwriteOldest: true, types: { room: true }, maxHops: 64 });
      expect(b().setAutoAddConfig).not.toHaveBeenCalled();
    });

    it.each([
      [{ maxHops: 65 }],
      [{ maxHops: -1 }],
      [{ maxHops: 1.5 }],
      [{ maxHops: '2' }],
      [{ overwriteOldest: 'yes' }],
      [{ types: { chat: 1 } }],
      [{ types: { bogus: true } }],
      [{ types: [true] }],
      [{}],
    ])('400 INVALID_INPUT for %j', async (body) => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(cfg(harness.sourceA)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
      expect(a().setAutoAddConfig).not.toHaveBeenCalled();
    });

    it('409 AUTOADD_UNSUPPORTED when the firmware lacks the commands', async () => {
      a().setAutoAddConfig.mockResolvedValue({ ok: true, config: { ...CONFIG, supported: false } });
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(cfg(harness.sourceA)).send({ maxHops: 1 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AUTOADD_UNSUPPORTED');
    });

    it('409 SOURCE_NOT_CONNECTED, and 502 when the radio refuses', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      a().setAutoAddConfig.mockResolvedValueOnce({ ok: false, error: 'Auto-add options need a connected Companion radio' });
      const down = await agent.post(cfg(harness.sourceA)).send({ maxHops: 1 });
      expect(down.status).toBe(409);
      expect(down.body.code).toBe('SOURCE_NOT_CONNECTED');
      a().setAutoAddConfig.mockResolvedValueOnce({ ok: false, error: 'Device rejected the auto-add options' });
      const refused = await agent.post(cfg(harness.sourceA)).send({ maxHops: 1 });
      expect(refused.status).toBe(502);
      expect(refused.body.code).toBe('AUTOADD_UPDATE_FAILED');
    });
  });

  describe('POST /contacts/remove-non-favorites', () => {
    it('rejects anonymous callers', async () => {
      const anon = await harness.loginAs(null);
      expect((await anon.post(rm(harness.sourceA)).send({})).status).toBe(401);
    });

    it('needs nodes:write on THIS source', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(rm(harness.sourceA)).send({})).status).toBe(403);
      expect(a().removeNonFavoriteContacts).not.toHaveBeenCalled();
      expect(b().removeNonFavoriteContacts).not.toHaveBeenCalled();
    });

    it('runs on this source only and returns the counts', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(rm(harness.sourceA)).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { removed: 2, kept: 1, failed: 0, total: 3 } });
      expect(a().removeNonFavoriteContacts).toHaveBeenCalledTimes(1);
      expect(b().removeNonFavoriteContacts).not.toHaveBeenCalled();
    });

    it('409 BULK_REMOVE_RUNNING while one runs', async () => {
      a().removeNonFavoriteContacts.mockResolvedValue({ status: 'busy' });
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const res = await (await harness.loginAs(harness.limited)).post(rm(harness.sourceA)).send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BULK_REMOVE_RUNNING');
    });

    it('409 SOURCE_NOT_CONNECTED and 502 BULK_REMOVE_FAILED', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      a().removeNonFavoriteContacts.mockResolvedValueOnce({ status: 'unavailable' });
      const down = await agent.post(rm(harness.sourceA)).send({});
      expect(down.status).toBe(409);
      expect(down.body.code).toBe('SOURCE_NOT_CONNECTED');
      a().removeNonFavoriteContacts.mockResolvedValueOnce({ status: 'failed', error: 'Could not read the radio contact list' });
      const failed = await agent.post(rm(harness.sourceA)).send({});
      expect(failed.status).toBe(502);
      expect(failed.body.code).toBe('BULK_REMOVE_FAILED');
    });
  });
});
