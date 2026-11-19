/**
 * sourceRoutes — mqtt_broker required fields.
 *
 * A broker saved without `listener.port`, `auth` or `gateway` threw on start
 * (`gateway.nodeNum` of undefined), and its bridges failed with it. POST and
 * PUT now refuse such a config. Sources are created with `enabled: false` so
 * no listener is bound.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const BROKER_ID = 'core-broker';
let harness: RouteTestHarness;

const good = () => ({
  listener: { port: 21885, host: '127.0.0.1' },
  auth: { username: 'mm', password: 's3cret' },
  gateway: { nodeNum: 0x80000002, nodeId: '!80000002', longName: 'MM', shortName: 'MM' },
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
  return agent.post('/').send({ name: 'Core Broker', type: 'mqtt_broker', enabled: false, config });
}

describe('sourceRoutes — mqtt_broker required fields', () => {
  it.each([
    ['no listener', { listener: undefined }],
    ['port 0', { listener: { port: 0 } }],
    ['port as string', { listener: { port: '1883' } }],
    ['no auth', { auth: undefined }],
    ['blank username', { auth: { username: '  ', password: 'x' } }],
    ['no password', { auth: { username: 'mm' } }],
    ['empty password', { auth: { username: 'mm', password: '' } }],
    ['no gateway', { gateway: undefined }],
    ['bad nodeNum', { gateway: { nodeNum: -1, nodeId: '!80000002' } }],
    ['bad nodeId', { gateway: { nodeNum: 1, nodeId: 'gateway' } }],
  ] as [string, Record<string, unknown>][])('POST refuses %s', async (_label, patch) => {
    const res = await create({ ...good(), ...patch });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_BROKER_CONFIG' });
  });

  it('POST accepts a complete config', async () => {
    const res = await create(good());
    expect(res.status).toBe(201);
    await harness.db.sources.deleteSource(res.body.id).catch(() => {});
  });

  it('PUT accepts a complete config', async () => {
    await harness.db.sources.createSource({ id: BROKER_ID, name: 'Core Broker', type: 'mqtt_broker', config: good(), enabled: false });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.put(`/${BROKER_ID}`).send({ config: { ...good(), listener: { port: 21886 } } });
    expect(res.status).toBe(200);
    const stored = await harness.db.sources.getSource(BROKER_ID);
    expect((stored!.config as { listener: { port: number } }).listener.port).toBe(21886);
  });

  it('PUT refuses dropping the gateway and leaves the stored config alone', async () => {
    await harness.db.sources.createSource({
      id: BROKER_ID,
      name: 'Core Broker',
      type: 'mqtt_broker',
      config: good(),
      enabled: false,
    });
    const agent = await harness.loginAs(harness.admin);
    const { gateway: _gw, ...noGateway } = good();
    const res = await agent.put(`/${BROKER_ID}`).send({ config: noGateway });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BROKER_CONFIG');
    const stored = await harness.db.sources.getSource(BROKER_ID);
    expect((stored!.config as Record<string, unknown>).gateway).toBeDefined();
  });
});
