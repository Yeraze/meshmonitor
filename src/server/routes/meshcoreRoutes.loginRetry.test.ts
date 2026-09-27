/**
 * Route tests — MeshCore remote login retry, progress and cancel (#5400).
 *
 *  - POST /admin/login and /admin/login-with-saved go through the shared
 *    retry helper (loginToNodeWithRetry) and pass it the tracked signal and
 *    progress callback when the client sends a `requestId`.
 *  - GET /admin/login-progress/:requestId reports attempt n of N and the
 *    time left in the current wait, to the owner on the same source only.
 *  - POST /admin/login-cancel aborts the login: the POST answers 409
 *    LOGIN_CANCELLED and nothing is saved.
 *
 * Real-middleware harness (createRouteTestApp); only the source-manager
 * registry and the credential store are mocked (non-DB).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { getMeshCoreLoginProgressRegistry } from '../services/meshcoreLoginProgress.js';
import type { MeshCoreLoginOptions } from '../meshcoreManager.js';

const { retryMock, storeMock, loadMock } = vi.hoisted(() => ({
  retryMock: vi.fn(),
  storeMock: vi.fn(),
  loadMock: vi.fn(),
}));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    loginToNodeWithRetry: retryMock,
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
    store: storeMock,
    load: loadMock,
  }),
}));

const PK = '5708aa' + '11'.repeat(29);
const REQ = 'req-5400-abcdef';

/** A login the test drives by hand: resolves when `settle` is called or the signal aborts. */
function controllableLogin() {
  let opts: MeshCoreLoginOptions = {};
  let settle: (v: { result: unknown; outcome: string; attempts: number }) => void = () => {};
  const started = new Promise<void>((resolveStarted) => {
    retryMock.mockImplementationOnce((_pk: string, _pw: string, o: MeshCoreLoginOptions) => {
      opts = o ?? {};
      resolveStarted();
      return new Promise((resolve) => {
        settle = resolve;
        opts.signal?.addEventListener('abort', () => resolve({ result: null, outcome: 'cancelled', attempts: 1 }));
      });
    });
  });
  return { started, opts: () => opts, settle: (v: { result: unknown; outcome: string; attempts: number }) => settle(v) };
}

describe('meshcoreRoutes — login retry / progress / cancel (#5400)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    for (const m of [retryMock, storeMock, loadMock]) m.mockReset();
    getMeshCoreLoginProgressRegistry().clear();
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    getMeshCoreLoginProgressRegistry().clear();
    await harness.cleanup();
  });

  const loginUrl = (s: string) => `/sources/${s}/meshcore/admin/login`;
  const savedUrl = (s: string) => `/sources/${s}/meshcore/admin/login-with-saved`;
  const progressUrl = (s: string, id = REQ) => `/sources/${s}/meshcore/admin/login-progress/${id}`;
  const cancelUrl = (s: string) => `/sources/${s}/meshcore/admin/login-cancel`;

  describe('POST /admin/login', () => {
    it('uses the retry helper and reports a success', async () => {
      retryMock.mockResolvedValue({ result: { isAdmin: true }, outcome: 'ok', attempts: 2 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(loginUrl(harness.sourceA)).send({ publicKey: PK, password: 'pw' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(retryMock).toHaveBeenCalledWith(PK, 'pw', {});
    });

    it('reports no_reply after every attempt as 401 with the reason and attempt count', async () => {
      retryMock.mockResolvedValue({ result: null, outcome: 'no_reply', attempts: 3 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(loginUrl(harness.sourceA)).send({ publicKey: PK, password: 'pw' });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, reason: 'no_reply', attempts: 3 });
    });

    it('reports a refusal as 401 rejected', async () => {
      retryMock.mockResolvedValue({ result: null, outcome: 'rejected', attempts: 1 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(loginUrl(harness.sourceA)).send({ publicKey: PK, password: 'bad' });
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('rejected');
    });

    it('rejects a malformed requestId with 400 and never logs in', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(loginUrl(harness.sourceA)).send({ publicKey: PK, password: 'pw', requestId: 'x/../y' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST_ID');
      expect(retryMock).not.toHaveBeenCalled();
    });

    it('exposes live progress to its owner, then cancels: 409 LOGIN_CANCELLED and no password saved', async () => {
      const login = controllableLogin();
      const agent = await harness.loginAs(harness.admin);
      const pending = agent
        .post(loginUrl(harness.sourceA))
        .send({ publicKey: PK, password: 'pw', rememberPassword: true, requestId: REQ })
        .then((r) => r);
      await login.started;

      login.opts().onProgress?.({ phase: 'waiting', attempt: 2, maxAttempts: 3, waitMs: 12_000 });
      const progress = await agent.get(progressUrl(harness.sourceA));
      expect(progress.status).toBe(200);
      expect(progress.body.data).toMatchObject({
        requestId: REQ,
        phase: 'waiting',
        attempt: 2,
        maxAttempts: 3,
        waitMs: 12_000,
        cancelRequested: false,
        outcome: null,
      });
      expect(progress.body.data.waitRemainingMs).toBeGreaterThan(0);
      expect(progress.body.data.waitRemainingMs).toBeLessThanOrEqual(12_000);
      // No password or key material in the progress payload.
      expect(JSON.stringify(progress.body)).not.toContain('pw"');
      expect(JSON.stringify(progress.body)).not.toContain(PK);

      const cancel = await agent.post(cancelUrl(harness.sourceA)).send({ requestId: REQ });
      expect(cancel.status).toBe(200);
      expect(login.opts().signal?.aborted).toBe(true);

      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'LOGIN_CANCELLED', cancelled: true });
      expect(storeMock).not.toHaveBeenCalled();

      const after = await agent.get(progressUrl(harness.sourceA));
      expect(after.body.data).toMatchObject({ phase: 'done', outcome: 'cancelled' });
    });

    it('keeps progress and cancel private to the user and source that started the login', async () => {
      const login = controllableLogin();
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
      const owner = await harness.loginAs(harness.admin);
      const other = await harness.loginAs(harness.limited);
      const pending = owner
        .post(loginUrl(harness.sourceA))
        .send({ publicKey: PK, password: 'pw', requestId: REQ })
        .then((r) => r);
      await login.started;

      expect((await other.get(progressUrl(harness.sourceA))).status).toBe(404);
      expect((await other.post(cancelUrl(harness.sourceA)).send({ requestId: REQ })).status).toBe(404);
      expect((await owner.get(progressUrl(harness.sourceB))).status).toBe(404);
      expect((await owner.post(cancelUrl(harness.sourceB)).send({ requestId: REQ })).status).toBe(404);
      expect(login.opts().signal?.aborted).toBe(false);

      login.settle({ result: {}, outcome: 'ok', attempts: 1 });
      expect((await pending).status).toBe(200);
    });

    it('refuses a requestId that is already in flight with 409', async () => {
      const login = controllableLogin();
      const agent = await harness.loginAs(harness.admin);
      const first = agent.post(loginUrl(harness.sourceA)).send({ publicKey: PK, password: 'pw', requestId: REQ }).then((r) => r);
      await login.started;
      const second = await agent.post(loginUrl(harness.sourceA)).send({ publicKey: PK, password: 'pw', requestId: REQ });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('LOGIN_REQUEST_ID_IN_USE');
      login.settle({ result: {}, outcome: 'ok', attempts: 1 });
      expect((await first).status).toBe(200);
    });

    it('cancelling one login leaves a concurrent one alone', async () => {
      const a = controllableLogin();
      const agent = await harness.loginAs(harness.admin);
      const pendingA = agent.post(loginUrl(harness.sourceA)).send({ publicKey: PK, password: 'pw', requestId: 'req-a-12345' }).then((r) => r);
      await a.started;
      const b = controllableLogin();
      const pendingB = agent.post(loginUrl(harness.sourceA)).send({ publicKey: PK, password: 'pw', requestId: 'req-b-12345' }).then((r) => r);
      await b.started;

      await agent.post(cancelUrl(harness.sourceA)).send({ requestId: 'req-a-12345' });
      expect(a.opts().signal?.aborted).toBe(true);
      expect(b.opts().signal?.aborted).toBe(false);

      b.settle({ result: {}, outcome: 'ok', attempts: 1 });
      expect((await pendingA).status).toBe(409);
      expect((await pendingB).status).toBe(200);
    });
  });

  describe('POST /admin/login-with-saved', () => {
    it('uses the retry helper with the saved password', async () => {
      loadMock.mockResolvedValue({ kind: 'ok', password: 'saved-pw' });
      retryMock.mockResolvedValue({ result: {}, outcome: 'ok', attempts: 3 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(savedUrl(harness.sourceA)).send({ publicKey: PK });
      expect(res.status).toBe(200);
      expect(retryMock).toHaveBeenCalledWith(PK, 'saved-pw', {});
    });

    it('does not call silence a rejected password: no_reply answers REMOTE_LOGIN_NO_REPLY', async () => {
      loadMock.mockResolvedValue({ kind: 'ok', password: 'saved-pw' });
      retryMock.mockResolvedValue({ result: null, outcome: 'no_reply', attempts: 3 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(savedUrl(harness.sourceA)).send({ publicKey: PK });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'REMOTE_LOGIN_NO_REPLY', reason: 'no_reply', attempts: 3 });
      expect(JSON.stringify(res.body)).not.toContain('saved-pw');
    });

    it('still reports a refusal as STORED_CREDENTIAL_REJECTED', async () => {
      loadMock.mockResolvedValue({ kind: 'ok', password: 'saved-pw' });
      retryMock.mockResolvedValue({ result: null, outcome: 'rejected', attempts: 1 });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(savedUrl(harness.sourceA)).send({ publicKey: PK });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('STORED_CREDENTIAL_REJECTED');
    });

    it('cancels through the same endpoints', async () => {
      loadMock.mockResolvedValue({ kind: 'ok', password: 'saved-pw' });
      const login = controllableLogin();
      const agent = await harness.loginAs(harness.admin);
      const pending = agent.post(savedUrl(harness.sourceA)).send({ publicKey: PK, requestId: REQ }).then((r) => r);
      await login.started;
      login.opts().onProgress?.({ phase: 'retrying', attempt: 1, maxAttempts: 3, pauseMs: 2000 });
      const progress = await agent.get(progressUrl(harness.sourceA));
      expect(progress.body.data).toMatchObject({ phase: 'retrying', attempt: 1, waitMs: 2000 });

      await agent.post(cancelUrl(harness.sourceA)).send({ requestId: REQ });
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LOGIN_CANCELLED');
    });
  });
});
