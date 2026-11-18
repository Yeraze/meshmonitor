/**
 * Manual MeshCore actions take the next RF slot (#6493 WP2): the telemetry,
 * neighbours and time-sync routes, the v1 `request-telemetry` opt-in wait, the
 * paged-fetch page 1, and GET /tx-queue/:requestId.
 *
 * Real auth + permission rows (route harness, API tokens), the real routers
 * and the real ManualMeshTxQueue; only the manager's radio calls are stubs.
 * Time is injected: the queue's sleep parks until the test calls `advance()`,
 * so a 60 s floor costs no real time. No RF.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';

const registry = vi.hoisted(() => ({ managers: new Map<string, unknown>() }));
const scheduler = vi.hoisted(() => ({
  current: null as null | { requestTelemetryForNode: (...a: unknown[]) => Promise<unknown> },
}));
const history = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => registry.managers.get(id),
    getAllManagers: () => [...registry.managers.values()],
  },
}));
vi.mock('../meshtasticManager.js', () => ({ fallbackManager: {} }));
vi.mock('../messageQueueService.js', () => ({ messageQueueService: {} }));
vi.mock('../middleware/rateLimiters.js', async (orig) => {
  const actual = await orig<typeof import('../middleware/rateLimiters.js')>();
  return { ...actual, meshcoreDeviceLimiter: (_q: unknown, _r: unknown, next: () => void) => next() };
});
vi.mock('../services/meshcoreRemoteTelemetryScheduler.js', async (orig) => {
  const actual = await orig<typeof import('../services/meshcoreRemoteTelemetryScheduler.js')>();
  return { ...actual, getMeshCoreRemoteTelemetryScheduler: () => scheduler.current };
});
vi.mock('../services/meshcoreCliHistoryService.js', async (orig) => {
  const actual = await orig<typeof import('../services/meshcoreCliHistoryService.js')>();
  return { ...actual, recordMeshcoreCliHistory: history.fn };
});
vi.mock('./meshRequestRoutes.js', () => ({ default: {}, requestMeshtasticTelemetry: vi.fn() }));

import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import meshcoreRoutes from './meshcoreRoutes.js';
import actionsRouter from './v1/actions.js';
import { MeshCoreDeviceType } from '../meshcoreManager.js';
import { ManualMeshTxQueue } from '../services/meshcoreManualTxQueue.js';
import { fetchNeighbourPages } from '../services/meshcoreNeighboursPaging.js';
import { getMeshCoreNeighboursFetchRegistry } from '../services/meshcoreNeighboursFetchProgress.js';

const SRC_A = 'q6493-a';
const SRC_B = 'q6493-b';
const PK = 'cd'.repeat(32);
const RID1 = 'req-aaaaaaaa1';
const RID2 = 'req-bbbbbbbb2';

// ── Injected clock ────────────────────────────────────────────────────────────
const clock = { offset: 0, sleepers: [] as Array<(ok: boolean) => void> };
const now = () => Date.now() + clock.offset;
/** Move time forward and wake every parked queue waiter. */
const advance = (ms: number) => {
  clock.offset += ms;
  const parked = clock.sleepers.splice(0);
  for (const wake of parked) wake(true);
};
const parkedSleep = (_ms: number, signal?: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const wake = (ok: boolean) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => {
      const i = clock.sleepers.indexOf(wake);
      if (i >= 0) clock.sleepers.splice(i, 1);
      wake(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    clock.sleepers.push(wake);
  });

const makeStub = (opts: { maxWaitMs?: number } = {}) => {
  const s: Record<string, any> = {
    sourceType: 'meshcore',
    last: 0,
    receiveOnly: false,
    connected: true,
  };
  s.isReceiveOnly = vi.fn(() => s.receiveOnly);
  s.isConnected = vi.fn(() => s.connected);
  s.canTransmit = vi.fn(() => !s.receiveOnly);
  s.getConnectionStatus = vi.fn(() => ({ connected: true, deviceType: MeshCoreDeviceType.COMPANION, config: null }));
  s.getContact = vi.fn(() => ({ publicKey: PK }));
  s.getLastMeshTxAt = vi.fn(() => s.last as number);
  s.recordMeshTx = vi.fn((w?: number) => { s.last = w ?? now(); });
  s.pollNeighborsAndStore = vi.fn(async () => ({ total: 2, written: 2 }));
  s.syncNodeTime = vi.fn(async () => ({ status: 'ok', reply: 'OK', elapsedMs: 10 }));
  s.getNeighbours = vi.fn(async () => ({ total: 1, neighbours: [{ publicKeyPrefix: 'aa', heardSecondsAgo: 1, snr: 1 }] }));
  const q = new ManualMeshTxQueue(
    { getLastMeshTxAt: () => s.getLastMeshTxAt(), recordMeshTx: (w) => s.recordMeshTx(w) },
    { now, sleep: parkedSleep, maxWaitMs: opts.maxWaitMs },
  );
  s.waitForManualMeshTxSlot = (o: Parameters<ManualMeshTxQueue['waitForSlot']>[0]) => q.waitForSlot(o);
  s.tryClaimMeshTxSlot = (n?: number, f?: number) => q.tryClaim(n, f);
  s.getManualMeshTxStatus = (k: string, r: string) => q.status(k, r);
  s.hasManualMeshReservation = () => q.isHeld();
  s.fetchAndStoreNeighbours = vi.fn(async (publicKey: string, o: Record<string, any>) => {
    const r = await fetchNeighbourPages(s as never, publicKey, {
      maxPages: 1, orderBy: 0, minIntervalMs: 60_000, signal: o.signal, onProgress: o.onProgress,
      manualSlot: o.manualSlot && {
        ...o.manualSlot,
        beforeClaim: () => !o.signal?.aborted && s.isConnected() && !s.isReceiveOnly(),
      },
      now, sleep: parkedSleep,
    });
    return { outcome: r.outcome, total: r.total, neighbours: [], pagesFetched: r.pagesFetched, written: 0, stored: 'none', ...(r.error ? { error: r.error } : {}) };
  });
  return s;
};

const waitFor = async (fn: () => Promise<boolean> | boolean, label = 'condition') => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

describe('manual MeshCore TX queue routes (#6493)', () => {
  let h: RouteTestHarness;
  let stubA: ReturnType<typeof makeStub>;
  let stubB: ReturnType<typeof makeStub>;
  let adminTok: string;
  let limitedTok: string;
  let marks: { tel: ReturnType<typeof vi.spyOn>; nb: ReturnType<typeof vi.spyOn>; ts: ReturnType<typeof vi.spyOn> };

  const url = (p: string, src = SRC_A) => `/api/sources/${src}/meshcore${p}`;
  const authed = (tok: string, r: request.Test) => r.set('Authorization', `Bearer ${tok}`);
  const post = (p: string, body: object, tok = adminTok, src = SRC_A) =>
    authed(tok, request(h.app).post(url(p, src))).send(body);
  const get = (p: string, tok = adminTok, src = SRC_A) => authed(tok, request(h.app).get(url(p, src)));
  /** Start a POST and keep it open; resolves when the response arrives. */
  const start = (p: string, body: object, tok = adminTok) => post(p, body, tok).then((r) => r);
  const queued = async (rid: string, tok = adminTok) => (await get(`/tx-queue/${rid}`, tok)).status === 200;
  const closeFloor = (s = stubA) => { s.last = now() - 5_000; };

  beforeEach(async () => {
    clock.offset = 0;
    clock.sleepers = [];
    registry.managers.clear();
    history.fn.mockReset();
    scheduler.current = { requestTelemetryForNode: vi.fn(async () => ({ written: 2, sources: ['status'] })) };
    h = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/sources/:id/meshcore', meshcoreRoutes);
        // The v1 router sits behind requireAPIToken in the app; stand in for it.
        app.use('/v1', (req: any, _res: any, next: any) => { req.user = h.admin; next(); });
        app.use('/v1/sources/:sourceId/actions', actionsRouter);
      },
    });
    for (const id of [SRC_A, SRC_B]) {
      await databaseService.sources.deleteSource(id).catch(() => {});
      await databaseService.sources.createSource({ id, name: id, type: 'meshcore', config: {}, enabled: true });
    }
    stubA = makeStub();
    stubB = makeStub();
    registry.managers.set(SRC_A, stubA);
    registry.managers.set(SRC_B, stubB);
    adminTok = await h.tokenFor(h.admin);
    limitedTok = await h.tokenFor(h.limited);
    marks = {
      tel: vi.spyOn(databaseService.meshcore, 'markTelemetryRequested').mockResolvedValue(undefined as never),
      nb: vi.spyOn(databaseService.meshcore, 'markNeighborsRequested').mockResolvedValue(undefined as never),
      ts: vi.spyOn(databaseService.meshcore, 'markTimeSyncRequested').mockResolvedValue(undefined as never),
    };
  });

  afterEach(async () => {
    clock.sleepers.splice(0).forEach((w) => w(false));
    getMeshCoreNeighboursFetchRegistry().clear();
    vi.restoreAllMocks();
    for (const id of [SRC_A, SRC_B]) await databaseService.sources.deleteSource(id).catch(() => {});
    await h.cleanup();
  });

  describe('telemetry/poll', () => {
    it('floor open: sends at once, success body keeps its shape plus waitedSecs 0', async () => {
      const res = await post(`/nodes/${PK}/telemetry/poll`, { type: 'status' }).expect(200);
      expect(res.body).toEqual({ success: true, data: { type: 'status', written: 2, sources: ['status'], waitedSecs: 0 } });
      expect(stubA.recordMeshTx).toHaveBeenCalledTimes(1);
      expect(marks.tel).toHaveBeenCalledTimes(1);
    });

    it('inside the floor: waits, then sends exactly once after the grant', async () => {
      closeFloor();
      const p = start(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: RID1 });
      await waitFor(() => queued(RID1), 'queued');
      const st = await get(`/tx-queue/${RID1}`).expect(200);
      expect(st.body.data).toMatchObject({ position: 1, depth: 1, action: 'telemetry', publicKey: PK });
      expect(scheduler.current!.requestTelemetryForNode).not.toHaveBeenCalled();
      expect(marks.tel).not.toHaveBeenCalled();

      advance(61_000);
      const res = await p;
      expect(res.status).toBe(200);
      expect(res.body.data.waitedSecs).toBeGreaterThanOrEqual(60);
      expect(scheduler.current!.requestTelemetryForNode).toHaveBeenCalledTimes(1);
      expect(marks.tel).toHaveBeenCalledTimes(1);
      // The grant stamped the floor; the route did not stamp it again.
      expect(stubA.recordMeshTx).toHaveBeenCalledTimes(1);
      await get(`/tx-queue/${RID1}`).expect(404);
    });

    it('the same user queuing a newer request supersedes the first: one send in total', async () => {
      closeFloor();
      const first = start(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: RID1 });
      await waitFor(() => queued(RID1), 'first queued');
      const second = start(`/nodes/${PK}/telemetry/poll`, { type: 'lpp', requestId: RID2 });
      const firstRes = await first;
      expect(firstRes.status).toBe(409);
      expect(firstRes.body.code).toBe('MESH_TX_SUPERSEDED');
      expect(firstRes.body.supersededBy).toEqual({ action: 'telemetry', publicKey: PK });

      await waitFor(() => queued(RID2), 'second queued');
      advance(61_000);
      expect((await second).status).toBe(200);
      expect(scheduler.current!.requestTelemetryForNode).toHaveBeenCalledTimes(1);
      expect(scheduler.current!.requestTelemetryForNode).toHaveBeenCalledWith(
        stubA, expect.anything(), { includeStatus: false, includeLpp: true },
      );
      expect(marks.tel).toHaveBeenCalledTimes(1);
      expect(stubA.recordMeshTx).toHaveBeenCalledTimes(1);
    });

    it('client abort while queued: no send, no mark, no stamp, entry gone', async () => {
      closeFloor();
      const server = h.app.listen(0);
      try {
        const port = (server.address() as AddressInfo).port;
        const body = JSON.stringify({ type: 'status', requestId: RID1 });
        const clientReq = http.request({
          port, host: '127.0.0.1', method: 'POST', path: url(`/nodes/${PK}/telemetry/poll`),
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${adminTok}` },
        });
        clientReq.on('error', () => {});
        clientReq.end(body);
        await waitFor(() => queued(RID1), 'queued');
        clientReq.destroy();
        await waitFor(async () => !(await queued(RID1)), 'entry removed');

        advance(61_000);
        await new Promise((r) => setTimeout(r, 50));
        expect(scheduler.current!.requestTelemetryForNode).not.toHaveBeenCalled();
        expect(marks.tel).not.toHaveBeenCalled();
        expect(stubA.recordMeshTx).not.toHaveBeenCalled();
      } finally {
        server.close();
      }
    });

    it('max wait: 429 MESH_TX_QUEUE_TIMEOUT with numeric retryAfterSeconds, Retry-After, no send', async () => {
      stubA = makeStub({ maxWaitMs: 30_000 });
      registry.managers.set(SRC_A, stubA);
      closeFloor();
      // Keep the floor closed past the max wait: another source of TX stamps it.
      const p = start(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: RID1 });
      await waitFor(() => queued(RID1), 'queued');
      stubA.last = now() + 20_000;
      advance(31_000);
      const res = await p;
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('MESH_TX_QUEUE_TIMEOUT');
      expect(typeof res.body.retryAfterSeconds).toBe('number');
      expect(res.body.retryAfterSecs).toBe(res.body.retryAfterSeconds);
      expect(res.headers['retry-after']).toBeDefined();
      expect(scheduler.current!.requestTelemetryForNode).not.toHaveBeenCalled();
      expect(marks.tel).not.toHaveBeenCalled();
    });

    it('wait:false inside the floor: legacy 429, no queue entry, nothing sent', async () => {
      closeFloor();
      const res = await post(`/nodes/${PK}/telemetry/poll`, { type: 'status', wait: false, requestId: RID1 }).expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(res.body.retryAfterSecs).toBeGreaterThan(0);
      expect(res.body.retryAfterSeconds).toBe(res.body.retryAfterSecs);
      expect(res.headers['retry-after']).toBeDefined();
      expect(stubA.recordMeshTx).not.toHaveBeenCalled();
      await get(`/tx-queue/${RID1}`).expect(404);
    });

    it('wait:false with the floor open claims atomically and sends', async () => {
      await post(`/nodes/${PK}/telemetry/poll`, { type: 'status', wait: false }).expect(200);
      expect(stubA.recordMeshTx).toHaveBeenCalledTimes(1);
    });

    it('source disconnects while queued: 409 SOURCE_NOT_CONNECTED, no send, no stamp', async () => {
      closeFloor();
      const p = start(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: RID1 });
      await waitFor(() => queued(RID1), 'queued');
      stubA.connected = false;
      advance(61_000);
      const res = await p;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      expect(scheduler.current!.requestTelemetryForNode).not.toHaveBeenCalled();
      expect(stubA.recordMeshTx).not.toHaveBeenCalled();
    });

    it('rejects a malformed requestId before anything is queued', async () => {
      closeFloor();
      const res = await post(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: 'a/b' }).expect(400);
      expect(res.body.code).toBe('INVALID_REQUEST_ID');
    });
  });

  describe('neighbours/poll', () => {
    it('inside the floor: waits, marks only after the grant, then polls once', async () => {
      closeFloor();
      const p = start(`/nodes/${PK}/neighbours/poll`, { requestId: RID1 });
      await waitFor(() => queued(RID1), 'queued');
      expect(marks.nb).not.toHaveBeenCalled();
      advance(61_000);
      const res = await p;
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ total: 2, written: 2 });
      expect(marks.nb).toHaveBeenCalledTimes(1);
      expect(stubA.pollNeighborsAndStore).toHaveBeenCalledTimes(1);
    });

    it('wait:false inside the floor: 429, nothing sent or marked', async () => {
      closeFloor();
      await post(`/nodes/${PK}/neighbours/poll`, { wait: false }).expect(429);
      expect(stubA.pollNeighborsAndStore).not.toHaveBeenCalled();
      expect(marks.nb).not.toHaveBeenCalled();
    });
  });

  describe('time-sync', () => {
    it('waits, then pushes the clock once and records one CLI-history row', async () => {
      closeFloor();
      const p = start(`/nodes/${PK}/time-sync`, { requestId: RID1 });
      await waitFor(() => queued(RID1), 'queued');
      advance(61_000);
      const res = await p;
      expect(res.status).toBe(200);
      expect(res.body.data.waitedSecs).toBeGreaterThanOrEqual(60);
      expect(stubA.syncNodeTime).toHaveBeenCalledTimes(1);
      expect(marks.ts).toHaveBeenCalledTimes(1);
      expect(history.fn).toHaveBeenCalledTimes(1);
    });

    it('superseded by a newer manual action: 409, no clock push, no mark, no CLI-history row', async () => {
      closeFloor();
      const ts = start(`/nodes/${PK}/time-sync`, { requestId: RID1 });
      await waitFor(() => queued(RID1), 'time-sync queued');
      const tel = start(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: RID2 });
      const tsRes = await ts;
      expect(tsRes.status).toBe(409);
      expect(tsRes.body.code).toBe('MESH_TX_SUPERSEDED');
      expect(tsRes.body.supersededBy.action).toBe('telemetry');
      expect(stubA.syncNodeTime).not.toHaveBeenCalled();
      expect(marks.ts).not.toHaveBeenCalled();
      expect(history.fn).not.toHaveBeenCalled();

      await waitFor(() => queued(RID2), 'telemetry queued');
      advance(61_000);
      expect((await tel).status).toBe(200);
      expect(stubA.recordMeshTx).toHaveBeenCalledTimes(1);
    });

    it('timeout writes no CLI-history row', async () => {
      stubA = makeStub({ maxWaitMs: 30_000 });
      registry.managers.set(SRC_A, stubA);
      closeFloor();
      const p = start(`/nodes/${PK}/time-sync`, { requestId: RID1 });
      await waitFor(() => queued(RID1), 'queued');
      stubA.last = now() + 20_000;
      advance(31_000);
      expect((await p).status).toBe(429);
      expect(history.fn).not.toHaveBeenCalled();
      expect(stubA.syncNodeTime).not.toHaveBeenCalled();
    });
  });

  describe('neighbours/fetch page 1', () => {
    const fetchBody = (rid: string) => ({ requestId: rid });

    it('queued page 1 reports queued progress and marks the node only after the grant', async () => {
      closeFloor();
      await post(`/nodes/${PK}/neighbours/fetch`, fetchBody(RID1)).expect(200);
      await waitFor(() => queued(RID1), 'page 1 queued');
      const prog = await get(`/nodes/${PK}/neighbours/fetch/${RID1}`).expect(200);
      expect(prog.body.data).toMatchObject({ phase: 'waiting', queued: true, queuePosition: 1 });
      expect(marks.nb).not.toHaveBeenCalled();
      expect(stubA.getNeighbours).not.toHaveBeenCalled();

      advance(61_000);
      await waitFor(async () => (await get(`/nodes/${PK}/neighbours/fetch/${RID1}`)).body.data?.phase === 'done', 'done');
      expect(marks.nb).toHaveBeenCalledTimes(1);
      expect(stubA.getNeighbours).toHaveBeenCalledTimes(1);
    });

    it('page 1 superseded by the same user: outcome superseded, no mark, nothing sent', async () => {
      closeFloor();
      await post(`/nodes/${PK}/neighbours/fetch`, fetchBody(RID1)).expect(200);
      await waitFor(() => queued(RID1), 'page 1 queued');
      const tel = start(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: RID2 });
      await waitFor(
        async () => (await get(`/nodes/${PK}/neighbours/fetch/${RID1}`)).body.data?.phase === 'done',
        'fetch done',
      );
      const prog = await get(`/nodes/${PK}/neighbours/fetch/${RID1}`).expect(200);
      expect(prog.body.data.outcome).toBe('superseded');
      expect(marks.nb).not.toHaveBeenCalled();
      expect(stubA.getNeighbours).not.toHaveBeenCalled();

      await waitFor(() => queued(RID2), 'telemetry queued');
      advance(61_000);
      expect((await tel).status).toBe(200);
      expect(stubA.recordMeshTx).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /tx-queue/:requestId', () => {
    it('owner only: another user, another source, an unknown or malformed id all get 404', async () => {
      await h.grant(h.limited.id, 'nodes', 'read', SRC_A);
      await h.grant(h.limited.id, 'nodes', 'read', SRC_B);
      closeFloor();
      const p = start(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: RID1 });
      await waitFor(() => queued(RID1), 'queued');

      await get(`/tx-queue/${RID1}`).expect(200);
      const other = await get(`/tx-queue/${RID1}`, limitedTok).expect(404);
      expect(other.body.code).toBe('MESH_TX_REQUEST_NOT_FOUND');
      await get(`/tx-queue/${RID1}`, adminTok, SRC_B).expect(404);
      await get('/tx-queue/unknown-id-1234').expect(404);
      await get('/tx-queue/a.b').expect(404);
      await request(h.app).get(url(`/tx-queue/${RID1}`)).expect(401);

      advance(61_000);
      await p;
    });

    it('a session login and an API token of one user are the same owner', async () => {
      closeFloor();
      const p = start(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: RID1 });
      await waitFor(() => queued(RID1), 'queued');
      const agent = await h.loginAs(h.admin);
      await agent.get(url(`/tx-queue/${RID1}`)).expect(200);
      advance(61_000);
      await p;
    });
  });

  describe('permissions are unchanged', () => {
    it('telemetry and neighbours polls need nodes:read on that source; time-sync needs configuration:write', async () => {
      await post(`/nodes/${PK}/telemetry/poll`, { type: 'status' }, limitedTok).expect(403);
      await post(`/nodes/${PK}/neighbours/poll`, {}, limitedTok).expect(403);
      await post(`/nodes/${PK}/time-sync`, {}, limitedTok).expect(403);

      await h.grant(h.limited.id, 'nodes', 'read', SRC_A);
      await post(`/nodes/${PK}/telemetry/poll`, { type: 'status' }, limitedTok).expect(200);
      await post(`/nodes/${PK}/time-sync`, {}, limitedTok).expect(403);
      // A grant on another source does not carry over.
      await post(`/nodes/${PK}/telemetry/poll`, { type: 'status' }, limitedTok, SRC_B).expect(403);

      await h.grant(h.limited.id, 'configuration', 'write', SRC_A);
      stubA.last = 0;
      await post(`/nodes/${PK}/time-sync`, {}, limitedTok).expect(200);
    });

    it('a receive-only source is refused before any queueing', async () => {
      stubA.receiveOnly = true;
      closeFloor();
      const res = await post(`/nodes/${PK}/telemetry/poll`, { type: 'status', requestId: RID1 }).expect(409);
      expect(res.body.code).toBe('TX_DISABLED');
      await get(`/tx-queue/${RID1}`).expect(404);
    });
  });

  describe('v1 request-telemetry', () => {
    const v1 = (body: object) =>
      request(h.app).post(`/v1/sources/${SRC_A}/actions/request-telemetry`).send(body);

    it('without wait: the quick 429 with Retry-After, nothing queued or sent', async () => {
      closeFloor();
      const res = await v1({ destination: PK, type: 'lpp', requestId: RID1 }).expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(30);
      expect(typeof res.body.retryAfter).toBe('number');
      expect(scheduler.current!.requestTelemetryForNode).not.toHaveBeenCalled();
      await get(`/tx-queue/${RID1}`).expect(404);
    });

    it('with wait:true: queues, then sends once and answers 200', async () => {
      closeFloor();
      const p = v1({ destination: PK, type: 'status', wait: true, requestId: RID1 }).then((r) => r);
      await waitFor(() => queued(RID1), 'queued');
      expect(scheduler.current!.requestTelemetryForNode).not.toHaveBeenCalled();
      advance(61_000);
      const res = await p;
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ protocol: 'meshcore', type: 'status', written: 2 });
      expect(scheduler.current!.requestTelemetryForNode).toHaveBeenCalledTimes(1);
    });

    it('floor open without wait still sends once', async () => {
      await v1({ destination: PK, type: 'status' }).expect(200);
      expect(stubA.recordMeshTx).toHaveBeenCalledTimes(1);
    });
  });
});
