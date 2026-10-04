/**
 * POST /contacts/:publicKey/trace-path — timeout handling (#5588).
 *
 * A trace can wait up to 60 s, past the server's 30 s socket timeout. The
 * route must answer that wait itself (504 MESHCORE_TRACE_TIMEOUT with the time
 * waited) rather than let the socket drop, since a dropped socket makes the
 * browser resend the POST and start another trace on RF (#5494).
 */
import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, respondOnSocketTimeout } from '../middleware/requestTimeout.js';
import {
  MESHCORE_FLOOD_WAIT_MAX_MS,
  MESHCORE_TRACE_SOCKET_TIMEOUT_MS,
} from '../constants/meshcoreFirmwareTimeout.js';

const VALID_PK = 'f6' + 'a'.repeat(62);

const traceContactPathDetailed = vi.fn();
const managers = new Map<string, unknown>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => managers.get(sourceId),
    getAllManagers: () => Array.from(managers.values()),
  },
}));

describe('POST /contacts/:publicKey/trace-path — timeout (#5588)', () => {
  let harness: RouteTestHarness;
  let server: http.Server | null = null;

  beforeEach(async () => {
    traceContactPathDetailed.mockReset();
    harness = await createRouteTestApp({
      mount: (app) => {
        // Same safety net as server.ts, so a socket timeout would show up as
        // 504 REQUEST_TIMEOUT instead of a hung test.
        app.use(respondOnSocketTimeout());
        app.use('/sources/:id/meshcore', meshcoreRoutes);
      },
    });
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      managers.set(sourceId, {
        sourceId,
        sourceType: 'meshcore',
        isReceiveOnly: () => false,
        canTransmit: () => true,
        isConnected: () => true,
        getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
        traceContactPathDetailed,
      });
    }
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    managers.clear();
    await harness.cleanup();
  });

  const url = (sourceId = harness.sourceA) => `/sources/${sourceId}/meshcore/contacts/${VALID_PK}/trace-path`;

  it('answers a timed-out trace with 504 MESHCORE_TRACE_TIMEOUT and the time waited', async () => {
    traceContactPathDetailed.mockResolvedValue({ ok: false, reason: 'timeout', waitMs: 11_000, suggestedTimeoutMs: 2_500 });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(url()).send({});

    expect(res.status).toBe(504);
    expect(res.body).toEqual({
      success: false,
      code: 'MESHCORE_TRACE_TIMEOUT',
      error: 'No reply to the trace within 11 s.',
      reason: 'timeout',
      waitMs: 11_000,
      suggestedTimeoutMs: 2_500,
    });
    // One trace per request: the route does not retry a timeout.
    expect(traceContactPathDetailed).toHaveBeenCalledTimes(1);
  });

  it('answers any other failure with 409 MESHCORE_TRACE_FAILED', async () => {
    traceContactPathDetailed.mockResolvedValue({ ok: false, reason: 'failed' });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(url()).send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'MESHCORE_TRACE_FAILED', reason: 'failed' });
    expect(traceContactPathDetailed).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed key with 400 INVALID_PUBLIC_KEY and sends nothing', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(`/sources/${harness.sourceA}/meshcore/contacts/nothex/trace-path`).send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_PUBLIC_KEY' });
    expect(traceContactPathDetailed).not.toHaveBeenCalled();
  });

  it('per-source scoping: nodes:write on sourceA does not authorize sourceB', async () => {
    traceContactPathDetailed.mockResolvedValue({ ok: true, hops: [], lastSnr: 0, path: [] });
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(url(harness.sourceA)).send({})).status).toBe(200);
    expect((await agent.post(url(harness.sourceB)).send({})).status).toBe(403);
    expect(traceContactPathDetailed).toHaveBeenCalledTimes(1);
  });

  it('gives the request a socket timeout longer than the longest trace wait', () => {
    expect(MESHCORE_FLOOD_WAIT_MAX_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(MESHCORE_TRACE_SOCKET_TIMEOUT_MS).toBeGreaterThan(MESHCORE_FLOOD_WAIT_MAX_MS);
  });

  it('outlives the server socket timeout: the handler answers, the socket is not dropped, the trace runs once', async () => {
    // Stand-in for "trace waits 60 s on a 30 s server": a 100 ms server socket
    // timeout and a 400 ms trace. Without the route's own extension the socket
    // would time out mid-trace.
    const SERVER_SOCKET_TIMEOUT_MS = 100;
    const TRACE_MS = 400;
    traceContactPathDetailed.mockImplementation(
      () => new Promise((resolve) => setTimeout(
        () => resolve({ ok: false, reason: 'timeout', waitMs: 60_000, suggestedTimeoutMs: 500_000 }),
        TRACE_MS,
      )),
    );
    server = http.createServer(harness.app);
    server.setTimeout(SERVER_SOCKET_TIMEOUT_MS);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;

    const agent = request.agent(`http://127.0.0.1:${port}`);
    await agent.post('/__test__/login').send({ userId: harness.admin.id });

    const res = await agent.post(url()).send({});
    expect(res.status).toBe(504);
    // The route's own answer, not the socket-timeout safety net's REQUEST_TIMEOUT.
    expect(res.body).toMatchObject({ success: false, code: 'MESHCORE_TRACE_TIMEOUT', waitMs: 60_000 });
    expect(traceContactPathDetailed).toHaveBeenCalledTimes(1);
  });
});
