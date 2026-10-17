/**
 * Route tests (#5867) — POST /nodes/:publicKey/remote-cli. Real-middleware
 * harness; only the source-manager registry is stubbed (per-source spies).
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

const KEY = 'cd'.repeat(32);

function stub(sourceId: string) {
  return {
    sourceId,
    sourceType: 'meshcore' as const,
    isReceiveOnly: () => false,
    canTransmit: () => true,
    setContactRemoteCli: vi.fn().mockResolvedValue({ flags: 0x11 }),
  };
}

describe('POST /nodes/:publicKey/remote-cli (#5867)', () => {
  let harness: RouteTestHarness;
  const url = (sid: string, key = KEY) => `/sources/${sid}/meshcore/nodes/${key}/remote-cli`;

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

  it('rejects anonymous callers', async () => {
    const anon = await harness.loginAs(null);
    expect((await anon.post(url(harness.sourceA)).send({ allowed: true })).status).toBe(401);
  });

  it('needs configuration:write on THIS source (nodes:write is not enough)', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(url(harness.sourceA)).send({ allowed: true })).status).toBe(403);
    expect(a().setContactRemoteCli).not.toHaveBeenCalled();
    expect(b().setContactRemoteCli).not.toHaveBeenCalled();
  });

  it('sets the permission on this source only', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const res = await (await harness.loginAs(harness.limited)).post(url(harness.sourceA)).send({ allowed: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { publicKey: KEY, allowed: true, flags: 0x11 } });
    expect(a().setContactRemoteCli).toHaveBeenCalledWith(KEY, true);
    expect(b().setContactRemoteCli).not.toHaveBeenCalled();
  });

  it.each([
    [KEY, { allowed: 'yes' }, 'INVALID_INPUT'],
    [KEY, {}, 'INVALID_INPUT'],
    ['abc', { allowed: true }, 'INVALID_PUBLIC_KEY'],
  ])('400 for key %s body %j: %s', async (key, body, code) => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const res = await (await harness.loginAs(harness.limited)).post(url(harness.sourceA, key)).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(a().setContactRemoteCli).not.toHaveBeenCalled();
  });

  it('409 when the firmware is too old, 502 when the radio refuses', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    a().setContactRemoteCli.mockRejectedValueOnce(new Error('Remote CLI permission needs firmware 1.18.0 or later on this radio'));
    const old = await agent.post(url(harness.sourceA)).send({ allowed: true });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('REMOTE_CLI_UNAVAILABLE');
    a().setContactRemoteCli.mockRejectedValueOnce(new Error('Remote-CLI permission not confirmed on device: read-back shows the old value'));
    const refused = await agent.post(url(harness.sourceA)).send({ allowed: true });
    expect(refused.status).toBe(502);
    expect(refused.body.code).toBe('REMOTE_CLI_FAILED');
  });
});
