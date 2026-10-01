/**
 * Route tests — radio contact table sync (#5502).
 *
 *  - POST /contacts/push-to-device: nodes:write, per-source scoped, limit
 *    validation, result in the ok() envelope, busy / not-connected mapping.
 *  - GET /contacts/device-sync: nodes:read.
 *  - POST /config/auto-add-contacts: configuration:write, boolean body.
 *
 * Real-middleware harness (createRouteTestApp); only the source-manager
 * registry is mocked (non-DB).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const { pushMock, syncMock, autoAddMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  syncMock: vi.fn(),
  autoAddMock: vi.fn(),
}));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    pushContactsToDevice: pushMock,
    getDeviceContactSyncStatus: syncMock,
    setAutoAddContacts: autoAddMock,
    isReceiveOnly: () => false,
    canTransmit: () => true,
  });
  const managers = new Map([
    ['rt-source-a', stubFor('rt-source-a')],
    ['rt-source-b', stubFor('rt-source-b')],
  ]);
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => managers.get(sourceId),
      getAllManagers: () => Array.from(managers.values()),
    },
  };
});

const DONE = {
  status: 'done',
  added: [{ publicKey: 'aa'.repeat(32), name: 'Rpt' }],
  alreadyOnDevice: 4,
  skipped: [],
  notAddedNoRoom: 0,
  evicted: [],
  capacityKnown: true,
  maxContacts: 100,
  freeSlotsBefore: 10,
  freeSlotsAfter: 9,
};

describe('meshcoreRoutes — contact table sync (#5502)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    for (const m of [pushMock, syncMock, autoAddMock]) m.mockReset();
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('POST /contacts/push-to-device', () => {
    const urlFor = (sourceId: string) => `/sources/${sourceId}/meshcore/contacts/push-to-device`;

    it('returns 401 when unauthenticated', async () => {
      const agent = await harness.loginAs(null);
      expect((await agent.post(urlFor(harness.sourceA))).status).toBe(401);
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('returns 403 with only nodes:read', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(urlFor(harness.sourceA))).status).toBe(403);
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('per-source scoping: nodes:write on sourceA does not authorize sourceB', async () => {
      pushMock.mockResolvedValue(DONE);
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(urlFor(harness.sourceA))).status).toBe(200);
      expect((await agent.post(urlFor(harness.sourceB))).status).toBe(403);
    });

    it('returns the result in the ok() envelope and passes the limit', async () => {
      pushMock.mockResolvedValue(DONE);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA)).send({ limit: 5 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: DONE });
      expect(pushMock).toHaveBeenCalledWith({ limit: 5 });
    });

    it('treats an empty body as no limit', async () => {
      pushMock.mockResolvedValue(DONE);
      const agent = await harness.loginAs(harness.admin);
      await agent.post(urlFor(harness.sourceA));
      expect(pushMock).toHaveBeenCalledWith({ limit: undefined });
    });

    it.each([0, -1, 1.5, 'ten'])('rejects limit=%s with 400 INVALID_LIMIT', async (limit) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA)).send({ limit });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_LIMIT');
      expect(pushMock).not.toHaveBeenCalled();
    });

    it('maps busy and unavailable to 409', async () => {
      const agent = await harness.loginAs(harness.admin);
      pushMock.mockResolvedValueOnce({ status: 'busy' });
      const busy = await agent.post(urlFor(harness.sourceA));
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('PUSH_IN_PROGRESS');
      pushMock.mockResolvedValueOnce({ status: 'unavailable' });
      const off = await agent.post(urlFor(harness.sourceA));
      expect(off.status).toBe(409);
      expect(off.body.code).toBe('COMPANION_NOT_CONNECTED');
    });

    it('maps a failure to 502', async () => {
      pushMock.mockResolvedValue({ status: 'failed', error: 'no answer' });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA));
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ success: false, code: 'PUSH_TO_DEVICE_FAILED', error: 'no answer' });
    });
  });

  describe('GET /contacts/device-sync', () => {
    const urlFor = (sourceId: string) => `/sources/${sourceId}/meshcore/contacts/device-sync`;
    const STATUS = {
      available: true,
      manualAddContacts: 1,
      autoAddEnabled: false,
      missingFavorites: [{ publicKey: 'bb'.repeat(32), name: 'Fav' }],
      deviceContactCount: 3,
    };

    it('needs nodes:read on the source', async () => {
      syncMock.mockResolvedValue(STATUS);
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(urlFor(harness.sourceA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: STATUS });
      expect((await agent.get(urlFor(harness.sourceB))).status).toBe(403);
    });
  });

  describe('POST /config/auto-add-contacts', () => {
    const urlFor = (sourceId: string) => `/sources/${sourceId}/meshcore/config/auto-add-contacts`;

    it('returns 403 with only nodes:write', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(urlFor(harness.sourceA)).send({ enabled: true })).status).toBe(403);
      expect(autoAddMock).not.toHaveBeenCalled();
    });

    it('configuration:write on sourceA allows sourceA only', async () => {
      autoAddMock.mockResolvedValue({ ok: true, manualAddContacts: 0, autoAddEnabled: true });
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(urlFor(harness.sourceA)).send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { autoAddEnabled: true, manualAddContacts: 0 } });
      expect(autoAddMock).toHaveBeenCalledWith(true);
      expect((await agent.post(urlFor(harness.sourceB)).send({ enabled: true })).status).toBe(403);
    });

    it('rejects a non-boolean body', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA)).send({ enabled: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ENABLED');
      expect(autoAddMock).not.toHaveBeenCalled();
    });

    it('maps a device failure to 502', async () => {
      autoAddMock.mockResolvedValue({ ok: false, error: 'rejected' });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(urlFor(harness.sourceA)).send({ enabled: false });
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: 'AUTO_ADD_UPDATE_FAILED', error: 'rejected' });
    });
  });
});
