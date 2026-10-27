/**
 * Source create/update warns when two enabled Meshtastic TCP sources point at
 * the same node (#5974). The exact-match 409 guard stays; this covers the
 * variants it misses (here, host case). Diagnostic only: the save succeeds.
 *
 * Uses createRouteTestApp() per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { logger } from '../../utils/logger.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    addManager: vi.fn().mockResolvedValue(undefined),
    removeManager: vi.fn().mockResolvedValue(undefined),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

describe('sourceRoutes — duplicate TCP endpoint warning (#5974)', () => {
  let harness: RouteTestHarness;
  let warn: ReturnType<typeof vi.spyOn>;
  // Rows persist for the life of the harness DB; give each test its own host.
  let n = 0;

  const slotWarnings = () =>
    warn.mock.calls.filter((c) => String(c[0]).includes('one TCP client at a time'));

  beforeEach(async () => {
    n += 1;
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    warn = vi.spyOn(logger, 'warn');
  });

  afterEach(async () => {
    warn.mockRestore();
    await harness.cleanup();
  });

  const tcpBody = (name: string, host: string) => ({
    name,
    type: 'meshtastic_tcp',
    config: { host, port: 4403, autoConnect: false },
  });

  it('warns on create when another enabled source has the same host in a different case', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.post('/').send(tcpBody(`G2-${n}`, `g2-${n}.lan`))).status).toBe(201);
    expect(slotWarnings()).toHaveLength(0);

    const res = await agent.post('/').send(tcpBody(`G2 again-${n}`, `G2-${n}.LAN`));
    expect(res.status).toBe(201);
    expect(slotWarnings()).toHaveLength(1);
    expect(String(slotWarnings()[0][0])).toContain(`g2-${n}.lan:4403`);
  });

  it('warns on update when an edit points a source at another source\'s node', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.post('/').send(tcpBody(`A-${n}`, `node-a-${n}.lan`))).status).toBe(201);
    const b = await agent.post('/').send(tcpBody(`B-${n}`, `node-b-${n}.lan`));
    expect(b.status).toBe(201);
    expect(slotWarnings()).toHaveLength(0);

    const id = b.body.id ?? b.body.data?.id;
    const res = await agent.put(`/${id}`).send({
      config: { host: `NODE-A-${n}.lan`, port: 4403, autoConnect: false },
    });
    expect(res.status).toBe(200);
    expect(slotWarnings()).toHaveLength(1);
  });

  it('does not warn for distinct nodes', async () => {
    const agent = await harness.loginAs(harness.admin);
    await agent.post('/').send(tcpBody(`X-${n}`, `x-${n}.lan`));
    await agent.post('/').send(tcpBody(`Y-${n}`, `y-${n}.lan`));
    expect(slotWarnings()).toHaveLength(0);
  });
});
