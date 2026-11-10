/**
 * sourceRoutes — mqtt_broker `rootTopic` validation (#6338).
 *
 * The embedded broker uses `rootTopic` as a topic prefix (`<root>/`), so a
 * wildcard, a stray `/` or `''` silently breaks the prefix match. Unset (or
 * null) means `msh`. A PUT checks the root only when it changes, so an edit of
 * another field still saves a broker that already holds a bad root.
 *
 * Every source is created with `enabled: false` so the handlers never build a
 * live MqttBrokerManager and bind a real TCP listener.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const BROKER_ID = 'root-broker';
let harness: RouteTestHarness;

const brokerConfig = (extra: Record<string, unknown> = {}) => ({
  listener: { port: 21884, host: '127.0.0.1' },
  auth: { username: 'mm', password: 's3cret' },
  gateway: { nodeNum: 0x80000001, nodeId: '!80000001', longName: 'MM', shortName: 'MM' },
  ...extra,
});

beforeEach(async () => {
  harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
});

afterEach(async () => {
  await harness.db.sources.deleteSource(BROKER_ID).catch(() => {});
  await harness.cleanup();
});

async function create(config: Record<string, unknown>) {
  const agent = await harness.loginAs(harness.admin);
  return agent.post('/').send({ name: 'Root Broker', type: 'mqtt_broker', enabled: false, config });
}

describe('sourceRoutes — mqtt_broker rootTopic validation', () => {
  it.each([
    ['msh/#', 'WILDCARD'],
    ['msh/', 'SLASH'],
    ['msh/US/2', 'ENDS_WITH_2'],
    ['', 'EMPTY'],
    [7, 'NOT_STRING'],
  ] as [unknown, string][])('POST refuses %j (%s)', async (rootTopic, reason) => {
    const res = await create(brokerConfig({ rootTopic }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_MQTT_ROOT', field: 'rootTopic', reason });
  });

  it.each([
    ['missing', {}],
    ['null', { rootTopic: null }],
    ['msh', { rootTopic: 'msh' }],
    ['msh/US/FL', { rootTopic: 'msh/US/FL' }],
  ] as [string, Record<string, unknown>][])('POST accepts a root that is %s', async (_label, extra) => {
    const res = await create(brokerConfig(extra));
    expect(res.status).toBe(201);
    await harness.db.sources.deleteSource(res.body.id).catch(() => {});
  });

  it('PUT saves another edit on a broker that already holds a bad root', async () => {
    await harness.db.sources.createSource({
      id: BROKER_ID,
      name: 'Root Broker',
      type: 'mqtt_broker',
      config: brokerConfig({ rootTopic: 'msh/' }),
      enabled: false,
    });
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.put(`/${BROKER_ID}`).send({ config: brokerConfig({ rootTopic: 'msh/', downlinkHopLimitOverride: 3 }) });
    expect(res.status).toBe(200);
    const stored = await harness.db.sources.getSource(BROKER_ID);
    expect((stored!.config as Record<string, unknown>).downlinkHopLimitOverride).toBe(3);
  });

  it('PUT refuses a changed bad root and leaves the stored config alone', async () => {
    await harness.db.sources.createSource({
      id: BROKER_ID,
      name: 'Root Broker',
      type: 'mqtt_broker',
      config: brokerConfig({ rootTopic: 'msh' }),
      enabled: false,
    });
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.put(`/${BROKER_ID}`).send({ config: brokerConfig({ rootTopic: 'msh/+' }) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MQTT_ROOT', reason: 'WILDCARD' });
    const stored = await harness.db.sources.getSource(BROKER_ID);
    expect((stored!.config as Record<string, unknown>).rootTopic).toBe('msh');
  });
});
