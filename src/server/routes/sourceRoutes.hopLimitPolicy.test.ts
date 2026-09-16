/**
 * sourceRoutes — mqtt_broker `hopLimitPolicy` validation (#5188 raise,
 * #5190 clamp).
 *
 * The raise half is a deliberate bypass of firmware hop scaling, so its bounds
 * are the ones that matter most here: a target above MAX_RAISE_TARGET or a
 * portnum outside the hop-scaled four must be refused at the API, not silently
 * dropped at read time.
 *
 * Uses the real route test harness (real session + real permission SQL), and
 * creates every source with `enabled: false` so the POST/PUT handlers never
 * build a live MqttBrokerManager and bind a real TCP listener.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { PortNum } from '../constants/meshtastic.js';

let harness: RouteTestHarness;
const created: string[] = [];

const brokerConfig = (extra: Record<string, unknown> = {}) => ({
  listener: { port: 21884, host: '127.0.0.1' },
  auth: { username: 'mm', password: 's3cret' },
  gateway: { nodeNum: 0x80000002, nodeId: '!80000002', longName: 'MM', shortName: 'MM' },
  rootTopic: 'msh',
  ...extra,
});

beforeEach(async () => {
  harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
});

afterEach(async () => {
  for (const id of created.splice(0)) {
    await harness.db.sources.deleteSource(id).catch(() => {});
  }
  await harness.cleanup();
});

async function post(policy: unknown) {
  const agent = await harness.loginAs(harness.admin);
  const res = await agent.post('/').send({
    name: 'Policy Broker',
    type: 'mqtt_broker',
    enabled: false,
    config: brokerConfig({ hopLimitPolicy: policy }),
  });
  if (res.body?.id) created.push(res.body.id);
  return res;
}

describe('sourceRoutes — mqtt_broker hopLimitPolicy validation', () => {
  it('accepts a clamp across the full protocol range', async () => {
    for (const max of [0, 3, 7]) {
      const res = await post({ clamp: { enabled: true, max } });
      expect(res.status).toBe(201);
      expect(res.body.config.hopLimitPolicy.clamp.max).toBe(max);
    }
  });

  it('rejects a clamp maximum above the 3-bit protocol range', async () => {
    const res = await post({ clamp: { enabled: true, max: 8 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/clamp\.max/);
  });

  it('rejects a non-integer clamp maximum', async () => {
    const res = await post({ clamp: { enabled: true, max: 2.5 } });
    expect(res.status).toBe(400);
  });

  it('accepts a clamp exemption list', async () => {
    const res = await post({
      clamp: { enabled: true, max: 3, exemptPortnums: [PortNum.TEXT_MESSAGE_APP] },
    });
    expect(res.status).toBe(201);
    expect(res.body.config.hopLimitPolicy.clamp.exemptPortnums).toEqual([PortNum.TEXT_MESSAGE_APP]);
  });

  it('rejects an exemption above the highest defined portnum', async () => {
    const res = await post({ clamp: { enabled: true, max: 3, exemptPortnums: [PortNum.MAX + 1] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exemptPortnums/);
  });

  it('rejects a non-array exemption list', async () => {
    const res = await post({ clamp: { enabled: true, max: 3, exemptPortnums: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exemptPortnums/);
  });

  it('accepts a raise inside the cap targeting a hop-scaled portnum', async () => {
    const res = await post({
      raise: { enabled: true, target: 3, portnums: [PortNum.NODEINFO_APP, PortNum.POSITION_APP] },
    });
    expect(res.status).toBe(201);
    expect(res.body.config.hopLimitPolicy.raise.target).toBe(3);
  });

  it('rejects a raise target above the cap', async () => {
    const res = await post({ raise: { enabled: true, target: 4, portnums: [PortNum.POSITION_APP] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/raise\.target/);
  });

  it('rejects a raise target of 0 — that is a clamp, not a raise', async () => {
    const res = await post({ raise: { enabled: true, target: 0, portnums: [PortNum.POSITION_APP] } });
    expect(res.status).toBe(400);
  });

  it('rejects a raise on a portnum firmware hop scaling does not touch', async () => {
    const res = await post({
      raise: { enabled: true, target: 2, portnums: [PortNum.TEXT_MESSAGE_APP] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/raise\.portnums/);
  });

  it('rejects an enabled raise with no portnums', async () => {
    const res = await post({ raise: { enabled: true, target: 2, portnums: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/raise\.portnums/);
  });

  it('accepts a disabled raise without validating its bounds', async () => {
    // A form that toggles the raise off should not have to clear stale values.
    const res = await post({ raise: { enabled: false, target: 7, portnums: [] } });
    expect(res.status).toBe(201);
  });

  it('accepts both halves together', async () => {
    const res = await post({
      raise: { enabled: true, target: 2, portnums: [PortNum.NODEINFO_APP] },
      clamp: { enabled: true, max: 3 },
    });
    expect(res.status).toBe(201);
  });

  it('rejects a non-object policy', async () => {
    const res = await post(['clamp']);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hopLimitPolicy/);
  });

  it('validates on the update path too', async () => {
    const agent = await harness.loginAs(harness.admin);
    const create = await agent.post('/').send({
      name: 'Policy Broker',
      type: 'mqtt_broker',
      enabled: false,
      config: brokerConfig(),
    });
    expect(create.status).toBe(201);
    created.push(create.body.id);

    const bad = await agent
      .put(`/${create.body.id}`)
      .send({ config: brokerConfig({ hopLimitPolicy: { clamp: { enabled: true, max: 9 } } }) });
    expect(bad.status).toBe(400);

    const good = await agent
      .put(`/${create.body.id}`)
      .send({ config: brokerConfig({ hopLimitPolicy: { clamp: { enabled: true, max: 1 } } }) });
    expect(good.status).toBe(200);
  });
});
