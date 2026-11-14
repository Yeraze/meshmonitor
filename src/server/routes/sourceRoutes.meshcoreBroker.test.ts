/**
 * Creating and saving a `meshcore_mqtt_broker` source (#6197): config is
 * validated before it is stored, the listener port must be free, creation
 * needs `sources:write`, and a valid source starts a broker manager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockAddManager = vi.fn();
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(undefined),
    addManager: (...args: unknown[]) => mockAddManager(...args),
    removeManager: vi.fn(),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const VALID = {
  listener: { port: 19884 },
  auth: { tokenAudience: 'aud', username: 'local', password: 'pw' },
  autoConnect: true,
};

describe('sourceRoutes — meshcore_mqtt_broker', () => {
  let harness: RouteTestHarness;
  const created: string[] = [];

  beforeEach(async () => {
    mockAddManager.mockReset().mockResolvedValue(undefined);
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
  });

  afterEach(async () => {
    for (const id of created.splice(0)) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.cleanup();
  });

  it('needs sources:write to create', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post('/').send({ name: 'B', type: 'meshcore_mqtt_broker', config: VALID });
    expect(res.status).toBe(403);
  });

  it('refuses a config with no login method', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin
      .post('/')
      .send({ name: 'B', type: 'meshcore_mqtt_broker', config: { listener: { port: 19884 }, auth: {} } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BROKER_CONFIG');
  });

  it('creates a valid source, starts its manager, and refuses a second one on the same port', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/').send({ name: 'B', type: 'meshcore_mqtt_broker', config: VALID });
    expect(res.status).toBe(201);
    created.push(res.body.id ?? res.body.data?.id);
    expect(mockAddManager).toHaveBeenCalledTimes(1);
    expect(mockAddManager.mock.calls[0][0].sourceType).toBe('meshcore_mqtt_broker');

    const dup = await admin.post('/').send({ name: 'B2', type: 'meshcore_mqtt_broker', config: VALID });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('PORT_IN_USE');
  });

  it('validates the merged config on save', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.post('/').send({ name: 'B', type: 'meshcore_mqtt_broker', config: VALID });
    const id = res.body.id ?? res.body.data?.id;
    created.push(id);
    const bad = await admin.put(`/${id}`).send({ config: { ...VALID, limits: { maxMessagesPerSecond: 0 } } });
    expect(bad.status).toBe(400);
    // A blank password on save keeps the stored one, so this stays valid.
    const ok = await admin.put(`/${id}`).send({ config: { ...VALID, auth: { tokenAudience: 'aud', username: 'local' } } });
    expect(ok.status).toBe(200);
    const stored = await harness.db.sources.getSource(id);
    expect((stored?.config as { auth: { password?: string } }).auth.password).toBe('pw');
  });
});
