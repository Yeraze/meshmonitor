/**
 * Route tests — remembered MeshCore admin sessions (#5785).
 *
 *  - GET /admin/session/:publicKey reports the manager's view (DB only).
 *  - DELETE /admin/session/:publicKey ("Log out") drops the row for THIS
 *    source only and sends nothing.
 *  - A successful login records a session; a refused one, or forgetting the
 *    saved password, clears it.
 *  - Permissions are per-source: read for status, write for Log out.
 *
 * Real-middleware harness (createRouteTestApp) against the singleton's
 * :memory: database; only the source-manager registry and the credential
 * store are mocked (non-DB).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const { retryMock, getSessionMock, recordMock, clearMock, loadMock, credClearMock } = vi.hoisted(() => ({
  retryMock: vi.fn(),
  getSessionMock: vi.fn(),
  recordMock: vi.fn(),
  clearMock: vi.fn(),
  loadMock: vi.fn(),
  credClearMock: vi.fn(),
}));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    loginToNodeWithRetry: retryMock,
    getAdminSession: getSessionMock,
    recordAdminSession: recordMock,
    clearAdminSession: clearMock,
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

vi.mock('../services/meshcoreCredentialStore.js', () => ({
  getMeshCoreCredentialStore: () => ({
    capability: { canRemember: true },
    store: vi.fn(),
    load: loadMock,
    clear: credClearMock,
  }),
}));

const PK = '5785aa' + '22'.repeat(29);
const SELF = 'b'.repeat(64);

describe('meshcore admin routes — remembered sessions (#5785)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    for (const m of [retryMock, getSessionMock, recordMock, clearMock, loadMock, credClearMock]) m.mockReset();
    getSessionMock.mockResolvedValue({ active: true, loggedInAt: 1234, isAdmin: true });
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const sessionUrl = (s: string, pk = PK) => `/sources/${s}/meshcore/admin/session/${pk}`;

  describe('GET /admin/session/:publicKey', () => {
    it('returns the manager view in the ok() envelope, with no radio traffic', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(sessionUrl(harness.sourceA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { active: true, loggedInAt: 1234, isAdmin: true } });
      expect(getSessionMock).toHaveBeenCalledWith(PK);
      expect(retryMock).not.toHaveBeenCalled();
    });

    it('rejects a malformed key', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(sessionUrl(harness.sourceA, 'nothex'));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PUBLIC_KEY');
    });

    it('needs remote_admin:read on THIS source', async () => {
      await harness.grant(harness.limited.id, 'remote_admin', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(sessionUrl(harness.sourceA))).status).toBe(403);
      expect((await agent.get(sessionUrl(harness.sourceB))).status).toBe(200);
    });
  });

  describe('DELETE /admin/session/:publicKey (Log out)', () => {
    const seed = async () => {
      for (const sourceId of [harness.sourceA, harness.sourceB]) {
        await harness.db.meshcoreAdminSessions.record({
          sourceId, targetPublicKey: PK, selfPublicKey: SELF, loggedInAt: 1, isAdmin: true,
        });
      }
    };

    it('drops the row for this source only, and sends nothing', async () => {
      await seed();
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete(sessionUrl(harness.sourceA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(await harness.db.meshcoreAdminSessions.get(harness.sourceA, PK)).toBeNull();
      expect(await harness.db.meshcoreAdminSessions.get(harness.sourceB, PK)).not.toBeNull();
      expect(retryMock).not.toHaveBeenCalled();
    });

    it('needs remote_admin:write on THIS source (read is not enough)', async () => {
      await seed();
      await harness.grant(harness.limited.id, 'remote_admin', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.delete(sessionUrl(harness.sourceA))).status).toBe(403);
      expect(await harness.db.meshcoreAdminSessions.get(harness.sourceA, PK)).not.toBeNull();
      expect((await agent.delete(sessionUrl(harness.sourceB))).status).toBe(200);
    });
  });

  describe('logins record and clear the session', () => {
    it('/admin/login records it on success', async () => {
      retryMock.mockResolvedValue({ result: { isAdmin: true }, outcome: 'ok', attempts: 1 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(`/sources/${harness.sourceA}/meshcore/admin/login`).send({ publicKey: PK, password: 'pw' });
      expect(res.status).toBe(200);
      expect(recordMock).toHaveBeenCalledWith(PK, { isAdmin: true });
      expect(clearMock).not.toHaveBeenCalled();
    });

    it('/admin/login clears it when the node refuses the password', async () => {
      retryMock.mockResolvedValue({ result: null, outcome: 'rejected', attempts: 1 });
      const agent = await harness.loginAs(harness.admin);
      await agent.post(`/sources/${harness.sourceA}/meshcore/admin/login`).send({ publicKey: PK, password: 'bad' });
      expect(clearMock).toHaveBeenCalledWith(PK);
      expect(recordMock).not.toHaveBeenCalled();
    });

    it('/admin/login keeps it when there was only no reply', async () => {
      retryMock.mockResolvedValue({ result: null, outcome: 'no_reply', attempts: 3 });
      const agent = await harness.loginAs(harness.admin);
      await agent.post(`/sources/${harness.sourceA}/meshcore/admin/login`).send({ publicKey: PK, password: 'pw' });
      expect(clearMock).not.toHaveBeenCalled();
      expect(recordMock).not.toHaveBeenCalled();
    });

    it('/admin/login-with-saved records on success and clears on refusal', async () => {
      loadMock.mockResolvedValue({ kind: 'ok', password: 's3cret' });
      const agent = await harness.loginAs(harness.admin);
      const url = `/sources/${harness.sourceA}/meshcore/admin/login-with-saved`;

      retryMock.mockResolvedValueOnce({ result: { isAdmin: false }, outcome: 'ok', attempts: 1 });
      expect((await agent.post(url).send({ publicKey: PK })).status).toBe(200);
      expect(recordMock).toHaveBeenCalledWith(PK, { isAdmin: false });

      retryMock.mockResolvedValueOnce({ result: null, outcome: 'rejected', attempts: 1 });
      expect((await agent.post(url).send({ publicKey: PK })).status).toBe(401);
      expect(clearMock).toHaveBeenCalledWith(PK);
    });

    it('forgetting the saved password also forgets the session', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete(`/sources/${harness.sourceA}/meshcore/admin/credentials/${PK}`);
      expect(res.status).toBe(200);
      expect(credClearMock).toHaveBeenCalledWith(harness.sourceA, PK);
      expect(clearMock).toHaveBeenCalledWith(PK);
    });
  });
});
