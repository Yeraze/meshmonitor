/**
 * Route tests — paged MeshCore neighbour fetch (#5413).
 *
 *  - POST /nodes/:pk/neighbours/fetch starts a manual (5-page) fetch in the
 *    background and answers at once.
 *  - GET  /nodes/:pk/neighbours/fetch/:requestId shows progress, the
 *    neighbours gathered so far, and the outcome, to the owner only.
 *  - POST /nodes/:pk/neighbours/fetch/:requestId/cancel aborts further pages.
 *  - One fetch per source: a second start is 409, carrying the id only for
 *    the owner so the UI can re-attach.
 *
 * Real-middleware harness (createRouteTestApp); only the source-manager
 * registry is mocked (non-DB).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { getMeshCoreNeighboursFetchRegistry } from '../services/meshcoreNeighboursFetchProgress.js';
import type { NeighboursFetchEvent, NeighboursFetchSummary } from '../services/meshcoreNeighboursFetchProgress.js';

const { fetchMock, receiveOnly } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  receiveOnly: { value: false },
}));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    isConnected: () => true,
    isReceiveOnly: () => receiveOnly.value,
    canTransmit: () => !receiveOnly.value,
    fetchAndStoreNeighbours: fetchMock,
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

const PK = '5413aa' + '22'.repeat(29);
const REQ = 'req-5413-abcdef';
const nb = (i: number) => ({ publicKeyPrefix: `p${i}`, heardSecondsAgo: i, snr: 3, name: `n${i}`, fullPublicKey: null });

interface FetchOpts { mode: string; signal: AbortSignal; onProgress: (e: NeighboursFetchEvent) => void }

/** A fetch the test drives by hand; resolves on `finish` or when aborted. */
function controllableFetch() {
  let opts!: FetchOpts;
  let finish: (s: NeighboursFetchSummary) => void = () => {};
  const started = new Promise<void>((resolveStarted) => {
    fetchMock.mockImplementationOnce((_pk: string, o: FetchOpts) => {
      opts = o;
      resolveStarted();
      return new Promise<NeighboursFetchSummary>((resolve) => {
        finish = resolve;
        o.signal.addEventListener('abort', () =>
          resolve({ outcome: 'cancelled', total: 37, neighbours: [nb(1)], pagesFetched: 1, written: 1, stored: 'merged' }));
      });
    });
  });
  return { started, opts: () => opts, finish: (s: NeighboursFetchSummary) => finish(s) };
}

describe('meshcoreRoutes — paged neighbour fetch (#5413)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    fetchMock.mockReset();
    receiveOnly.value = false;
    getMeshCoreNeighboursFetchRegistry().clear();
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    getMeshCoreNeighboursFetchRegistry().clear();
    await harness.cleanup();
  });

  const startUrl = (s: string, pk = PK) => `/sources/${s}/meshcore/nodes/${pk}/neighbours/fetch`;
  const progressUrl = (s: string, id = REQ, pk = PK) => `/sources/${s}/meshcore/nodes/${pk}/neighbours/fetch/${id}`;
  const cancelUrl = (s: string, id = REQ) => `/sources/${s}/meshcore/nodes/${PK}/neighbours/fetch/${id}/cancel`;

  it('starts a manual fetch, streams progress, and reports the final outcome', async () => {
    const f = controllableFetch();
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(startUrl(harness.sourceA)).send({ requestId: REQ });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { requestId: REQ, maxPages: 5 } });
    await f.started;
    expect(fetchMock).toHaveBeenCalledWith(PK, expect.objectContaining({ mode: 'manual' }));

    f.opts().onProgress({ phase: 'page', page: 1, plannedPages: 4, total: 37, neighbours: [nb(1), nb(2)] });
    f.opts().onProgress({ phase: 'waiting', page: 2, plannedPages: 4, waitMs: 60_000 });
    const mid = await agent.get(progressUrl(harness.sourceA));
    expect(mid.status).toBe(200);
    expect(mid.body.data).toMatchObject({ phase: 'waiting', page: 2, plannedPages: 4, total: 37, pagesFetched: 1, waitMs: 60_000 });
    expect(mid.body.data.neighbours).toHaveLength(2);
    expect(mid.body.data.waitRemainingMs).toBeGreaterThan(55_000);

    f.finish({ outcome: 'complete', total: 37, neighbours: [nb(1)], pagesFetched: 4, written: 37, stored: 'replaced' });
    await new Promise((r) => setImmediate(r));
    const done = await agent.get(progressUrl(harness.sourceA));
    expect(done.body.data).toMatchObject({ phase: 'done', outcome: 'complete', stored: 'replaced', written: 37 });
  });

  it('cancel aborts the fetch; progress shows the partial outcome', async () => {
    const f = controllableFetch();
    const agent = await harness.loginAs(harness.admin);
    await agent.post(startUrl(harness.sourceA)).send({ requestId: REQ });
    await f.started;

    const res = await agent.post(cancelUrl(harness.sourceA)).send({});
    expect(res.status).toBe(200);
    expect(f.opts().signal.aborted).toBe(true);
    await new Promise((r) => setImmediate(r));
    const done = await agent.get(progressUrl(harness.sourceA));
    expect(done.body.data).toMatchObject({ phase: 'done', outcome: 'cancelled', stored: 'merged', cancelRequested: true });
  });

  it('allows one fetch per source; the owner gets the running id back to re-attach', async () => {
    const f = controllableFetch();
    const agent = await harness.loginAs(harness.admin);
    await agent.post(startUrl(harness.sourceA)).send({ requestId: REQ });
    await f.started;

    const again = await agent.post(startUrl(harness.sourceA)).send({ requestId: 'req-5413-second' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'NEIGHBOURS_FETCH_IN_PROGRESS', activeRequestId: REQ, activePublicKey: PK });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Another user sees that the source is busy, but not the id.
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const other = await harness.loginAs(harness.limited);
    const busy = await other.post(startUrl(harness.sourceA)).send({ requestId: 'req-5413-other1' });
    expect(busy.status).toBe(409);
    expect(busy.body.activeRequestId).toBeNull();
    // ...and cannot read or cancel it.
    expect((await other.get(progressUrl(harness.sourceA))).status).toBe(404);
    expect((await other.post(cancelUrl(harness.sourceA)).send({})).status).toBe(404);
    expect(f.opts().signal.aborted).toBe(false);

    // A different source is independent.
    controllableFetch();
    const b = await agent.post(startUrl(harness.sourceB)).send({ requestId: 'req-5413-src-b' });
    expect(b.status).toBe(200);
  });

  it('progress is scoped to the source and node it was started on', async () => {
    const f = controllableFetch();
    const agent = await harness.loginAs(harness.admin);
    await agent.post(startUrl(harness.sourceA)).send({ requestId: REQ });
    await f.started;
    expect((await agent.get(progressUrl(harness.sourceB))).status).toBe(404);
    expect((await agent.get(progressUrl(harness.sourceA, REQ, 'c'.repeat(64)))).status).toBe(404);
  });

  it('rejects a bad requestId or public key without starting anything', async () => {
    const agent = await harness.loginAs(harness.admin);
    const badId = await agent.post(startUrl(harness.sourceA)).send({ requestId: 'x/../y' });
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe('INVALID_REQUEST_ID');
    const badPk = await agent.post(startUrl(harness.sourceA, 'zz')).send({ requestId: REQ });
    expect(badPk.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires nodes:read on the source', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(startUrl(harness.sourceA)).send({ requestId: REQ });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses in receive-only mode with 409 TX_DISABLED', async () => {
    receiveOnly.value = true;
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(startUrl(harness.sourceA)).send({ requestId: REQ });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TX_DISABLED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a crashed fetch ends as failed instead of hanging', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const agent = await harness.loginAs(harness.admin);
    await agent.post(startUrl(harness.sourceA)).send({ requestId: REQ });
    await new Promise((r) => setImmediate(r));
    const done = await agent.get(progressUrl(harness.sourceA));
    expect(done.body.data).toMatchObject({ phase: 'done', outcome: 'failed', error: 'boom', stored: 'none' });
  });
});
