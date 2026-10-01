/**
 * Route tests — POST /contacts/:publicKey/discover-path (#5508).
 *
 * The route now returns the firmware's suggested timeout and the UI wait
 * budget in the ok() envelope, and errors through fail().
 *
 * Real-middleware harness (createRouteTestApp); only the source-manager
 * registry is mocked (non-DB).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const { discoverMock } = vi.hoisted(() => ({ discoverMock: vi.fn() }));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    discoverContactPath: discoverMock,
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

const PK = 'c'.repeat(64);

describe('meshcoreRoutes — discover-path (#5508)', () => {
  let harness: RouteTestHarness;
  const urlFor = (sourceId: string, publicKey = PK) =>
    `/sources/${sourceId}/meshcore/contacts/${publicKey}/discover-path`;

  beforeEach(async () => {
    discoverMock.mockReset();
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('returns 401 when unauthenticated', async () => {
    const agent = await harness.loginAs(null);
    expect((await agent.post(urlFor(harness.sourceA))).status).toBe(401);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('per-source scoping: nodes:write on sourceA does not authorize sourceB', async () => {
    discoverMock.mockResolvedValue({ suggestedTimeoutMs: 0, discoveryTimeoutMs: 30_000 });
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.post(urlFor(harness.sourceA))).status).toBe(200);
    expect((await agent.post(urlFor(harness.sourceB))).status).toBe(403);
  });

  it('returns the timeout budget in the ok() envelope', async () => {
    discoverMock.mockResolvedValue({ suggestedTimeoutMs: 20_000, discoveryTimeoutMs: 32_000 });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { suggestedTimeoutMs: 20_000, discoveryTimeoutMs: 32_000 },
    });
    expect(discoverMock).toHaveBeenCalledWith(PK);
  });

  it('rejects a malformed key with 400 INVALID_PUBLIC_KEY', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA, 'not-hex'));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PUBLIC_KEY');
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('returns 409 DISCOVER_PATH_FAILED when the manager rejects', async () => {
    discoverMock.mockResolvedValue(false);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post(urlFor(harness.sourceA));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'DISCOVER_PATH_FAILED' });
  });
});
