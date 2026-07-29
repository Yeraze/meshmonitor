/**
 * Route tests — POST /contacts/:publicKey/ping (zero-hop ping, issue #4393)
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md: real
 * express-session + real auth middleware + real permission SQL against the
 * singleton's `:memory:` SQLite DB. Only the source-manager registry is mocked
 * (non-DB) — the router-level guard requires a registered manager whose
 * `sourceType === 'meshcore'`, and the handler needs a `pingContactZeroHop`.
 *
 * Mount prefix mirrors `src/server/server.ts`
 * (`apiRouter.use('/sources/:id/meshcore', meshcoreRoutes)`); the harness talks
 * to the Express app directly, so the `/api` segment is not needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const { pingMock } = vi.hoisted(() => ({ pingMock: vi.fn() }));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    pingContactZeroHop: pingMock,
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

const PK = 'a3' + 'f'.repeat(62);

const OK_RESULT = {
  ok: true as const,
  hopHash: 'a3',
  rttMs: 812,
  snrToTarget: 10,
  snrFromTarget: 7.25,
};

describe('meshcoreRoutes — POST /contacts/:publicKey/ping (#4393)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    pingMock.mockReset();
    pingMock.mockResolvedValue(OK_RESULT);
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const urlFor = (sourceId: string, publicKey = PK) =>
    `/sources/${sourceId}/meshcore/contacts/${publicKey}/ping`;

  it('returns 401 when unauthenticated', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(401);
    expect(pingMock).not.toHaveBeenCalled();
  });

  it('returns 403 without nodes:write on the source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(403);
    expect(pingMock).not.toHaveBeenCalled();
  });

  it('returns 200 with the ping envelope when granted nodes:write', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(urlFor(harness.sourceA));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      hopHash: 'a3',
      rttMs: 812,
      snrToTarget: 10,
      snrFromTarget: 7.25,
    });
    expect(pingMock).toHaveBeenCalledWith(PK);
  });

  it('per-source scoping: nodes:write on sourceA does not authorize sourceB', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    expect((await agent.post(urlFor(harness.sourceA))).status).toBe(200);
    expect((await agent.post(urlFor(harness.sourceB))).status).toBe(403);
  });

  it('rejects a malformed public key with 400 INVALID_PUBLIC_KEY before touching the device', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA, 'not-a-key'));

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('INVALID_PUBLIC_KEY');
    expect(pingMock).not.toHaveBeenCalled();
  });

  it('maps a no-reply (out of range) result to 504 MESHCORE_PING_NO_REPLY', async () => {
    pingMock.mockResolvedValue({
      ok: false,
      reason: 'no-reply',
      error: 'No reply — the node is not in direct radio range (or does not repeat traces).',
    });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));

    expect(res.status).toBe(504);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('MESHCORE_PING_NO_REPLY');
    expect(res.body.reason).toBe('no-reply');
    expect(res.body.error).toMatch(/direct radio range/i);
  });

  it.each([
    ['not-companion', 'MESHCORE_PING_NOT_COMPANION'],
    ['disconnected', 'MESHCORE_PING_DISCONNECTED'],
    ['unknown-contact', 'MESHCORE_PING_UNKNOWN_CONTACT'],
  ])('maps guard failure %s to 409 %s', async (reason, code) => {
    pingMock.mockResolvedValue({ ok: false, reason, error: 'nope' });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(code);
    expect(res.body.reason).toBe(reason);
  });

  it('returns 500 MESHCORE_PING_FAILED when the manager throws', async () => {
    pingMock.mockRejectedValue(new Error('boom'));
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('MESHCORE_PING_FAILED');
  });

  it('returns 404 for a source with no registered MeshCore manager', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor('not-registered'));
    expect(res.status).toBe(404);
  });
});
