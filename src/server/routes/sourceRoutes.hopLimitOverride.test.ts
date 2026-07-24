/**
 * sourceRoutes — mqtt_broker `downlinkHopLimitOverride` validation (#4081).
 *
 * Covers the 0–7 integer gate on both the create and update paths, plus the
 * absent/null cases (which mean "pass hop_limit through unchanged") and the
 * legacy `zeroHopInjection` boolean, which stays accepted so pre-#4081
 * configs round-trip through an edit untouched.
 *
 * Uses the real route test harness (real session + real permission SQL), and
 * creates every source with `enabled: false` so the POST/PUT handlers never
 * build a live MqttBrokerManager and bind a real TCP listener.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import {
  createRouteTestApp,
  type RouteTestHarness,
} from '../test-helpers/routeTestApp.js';

let harness: RouteTestHarness;

const brokerConfig = (extra: Record<string, unknown> = {}) => ({
  listener: { port: 21883, host: '127.0.0.1' },
  auth: { username: 'mm', password: 's3cret' },
  gateway: { nodeNum: 0x80000001, nodeId: '!80000001', longName: 'MM', shortName: 'MM' },
  rootTopic: 'msh',
  ...extra,
});

beforeEach(async () => {
  harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
});

afterEach(async () => {
  await harness.db.sources.deleteSource('hop-broker').catch(() => {});
  await harness.cleanup();
});

describe('sourceRoutes — mqtt_broker downlinkHopLimitOverride validation', () => {
  it.each([0, 1, 3, 7])('POST accepts an override of %i', async (value) => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/').send({
      name: 'Hop Broker',
      type: 'mqtt_broker',
      enabled: false,
      config: brokerConfig({ downlinkHopLimitOverride: value }),
    });

    expect(res.status).toBe(201);
    expect(res.body.config.downlinkHopLimitOverride).toBe(value);
    await harness.db.sources.deleteSource(res.body.id).catch(() => {});
  });

  it('POST accepts a config with no override at all', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/').send({
      name: 'Hop Broker',
      type: 'mqtt_broker',
      enabled: false,
      config: brokerConfig(),
    });

    expect(res.status).toBe(201);
    expect(res.body.config.downlinkHopLimitOverride).toBeUndefined();
    await harness.db.sources.deleteSource(res.body.id).catch(() => {});
  });

  it('POST still accepts the legacy zeroHopInjection boolean', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/').send({
      name: 'Hop Broker',
      type: 'mqtt_broker',
      enabled: false,
      config: brokerConfig({ zeroHopInjection: true }),
    });

    expect(res.status).toBe(201);
    expect(res.body.config.zeroHopInjection).toBe(true);
    await harness.db.sources.deleteSource(res.body.id).catch(() => {});
  });

  it.each([
    [8, 'above the 3-bit protocol max'],
    [-1, 'negative'],
    [3.5, 'non-integer'],
    ['3', 'a string'],
    [true, 'a boolean'],
  ] as [unknown, string][])('POST rejects an override of %j (%s)', async (value) => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.post('/').send({
      name: 'Hop Broker',
      type: 'mqtt_broker',
      enabled: false,
      config: brokerConfig({ downlinkHopLimitOverride: value }),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/downlinkHopLimitOverride must be an integer between 0 and 7/);
  });

  it('PUT accepts a valid override on an existing broker', async () => {
    await harness.db.sources.createSource({
      id: 'hop-broker',
      name: 'Hop Broker',
      type: 'mqtt_broker',
      config: brokerConfig(),
      enabled: false,
    });
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .put('/hop-broker')
      .send({ config: brokerConfig({ downlinkHopLimitOverride: 6 }) });

    expect(res.status).toBe(200);
    const stored = await harness.db.sources.getSource('hop-broker');
    expect((stored!.config as Record<string, unknown>).downlinkHopLimitOverride).toBe(6);
  });

  it('PUT rejects an out-of-range override and leaves the stored config alone', async () => {
    await harness.db.sources.createSource({
      id: 'hop-broker',
      name: 'Hop Broker',
      type: 'mqtt_broker',
      config: brokerConfig({ downlinkHopLimitOverride: 2 }),
      enabled: false,
    });
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .put('/hop-broker')
      .send({ config: brokerConfig({ downlinkHopLimitOverride: 9 }) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/downlinkHopLimitOverride must be an integer between 0 and 7/);
    const stored = await harness.db.sources.getSource('hop-broker');
    expect((stored!.config as Record<string, unknown>).downlinkHopLimitOverride).toBe(2);
  });

  it('PUT drops the legacy boolean when the numeric field replaces it', async () => {
    await harness.db.sources.createSource({
      id: 'hop-broker',
      name: 'Hop Broker',
      type: 'mqtt_broker',
      config: brokerConfig({ zeroHopInjection: true }),
      enabled: false,
    });
    const agent = await harness.loginAs(harness.admin);

    // Mirrors what the edit form posts after #4081: the numeric field only.
    const res = await agent
      .put('/hop-broker')
      .send({ config: brokerConfig({ downlinkHopLimitOverride: 4 }) });

    expect(res.status).toBe(200);
    const stored = (await harness.db.sources.getSource('hop-broker'))!.config as Record<string, unknown>;
    expect(stored.downlinkHopLimitOverride).toBe(4);
    expect(stored.zeroHopInjection).toBeUndefined();
  });

  it('does not apply the broker validator to other source types', async () => {
    const agent = await harness.loginAs(harness.admin);

    // A bogus hop override on a bridge config is simply ignored — the field
    // is meaningless there, and rejecting it would be a surprise.
    const res = await agent.post('/').send({
      name: 'Bridge',
      type: 'mqtt_bridge',
      enabled: false,
      config: {
        upstream: { url: 'mqtt://example.invalid:1883' },
        subscriptions: ['msh/#'],
        downlinkHopLimitOverride: 99,
      },
    });

    expect(res.status).toBe(201);
    await harness.db.sources.deleteSource(res.body.id).catch(() => {});
  });
});
