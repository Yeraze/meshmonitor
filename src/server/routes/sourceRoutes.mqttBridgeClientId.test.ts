/**
 * sourceRoutes — mqtt_bridge `upstream.clientId` validation (#5893).
 *
 * The optional single-mode Client ID must be 8 hex digits, with or without a
 * leading `!`. It is stored as lowercase `!xxxxxxxx`; a blank value is removed.
 * Covers the create and update paths.
 *
 * Uses the real route test harness. Every source is created with
 * `enabled: false` so the handlers never start a live bridge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

let harness: RouteTestHarness;

const bridgeConfig = (upstream: Record<string, unknown> = {}) => ({
  upstream: { url: 'mqtt://strict-broker.example:1883', ...upstream },
  subscriptions: ['msh/US/#'],
  forwardingMode: 'single',
});

const created: string[] = [];

beforeEach(async () => {
  harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
});

afterEach(async () => {
  for (const id of created.splice(0)) await harness.db.sources.deleteSource(id).catch(() => {});
  await harness.db.sources.deleteSource('cid-bridge').catch(() => {});
  await harness.cleanup();
});

describe('sourceRoutes — mqtt_bridge upstream.clientId', () => {
  it.each([
    ['!a1b2c3d4', '!a1b2c3d4'],
    ['!A1B2C3D4', '!a1b2c3d4'],
    ['a1b2c3d4', '!a1b2c3d4'],
  ])('POST accepts %s and stores %s', async (input, stored) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/').send({
      name: 'CID Bridge',
      type: 'mqtt_bridge',
      enabled: false,
      config: bridgeConfig({ clientId: input }),
    });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    expect(res.body.config.upstream.clientId).toBe(stored);
    const row = await harness.db.sources.getSource(res.body.id);
    expect((row?.config as any).upstream.clientId).toBe(stored);
  });

  it('POST drops a blank clientId', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/').send({
      name: 'CID Bridge',
      type: 'mqtt_bridge',
      enabled: false,
      config: bridgeConfig({ clientId: '  ' }),
    });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    expect(res.body.config.upstream.clientId).toBeUndefined();
  });

  it.each([
    ['!a1b2c3d', 'too short'],
    ['!a1b2c3d4e', 'too long'],
    ['mm-bridge-abc', 'not hex'],
    ['!g1b2c3d4', 'non-hex digit'],
    [12345678, 'a number'],
  ] as [unknown, string][])('POST rejects %j (%s)', async (value) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/').send({
      name: 'CID Bridge',
      type: 'mqtt_bridge',
      enabled: false,
      config: bridgeConfig({ clientId: value }),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CLIENT_ID');
    expect(res.body.error).toMatch(/upstream\.clientId must be 8 hex digits/);
  });

  it('PUT normalises a valid value and rejects a bad one', async () => {
    await harness.db.sources.createSource({
      id: 'cid-bridge',
      name: 'CID Bridge',
      type: 'mqtt_bridge',
      config: bridgeConfig(),
      enabled: false,
    });
    const agent = await harness.loginAs(harness.admin);

    const ok = await agent.put('/cid-bridge').send({ config: bridgeConfig({ clientId: 'DEADBEEF' }) });
    expect(ok.status).toBe(200);
    const row = await harness.db.sources.getSource('cid-bridge');
    expect((row?.config as any).upstream.clientId).toBe('!deadbeef');

    const bad = await agent.put('/cid-bridge').send({ config: bridgeConfig({ clientId: '!xyz' }) });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_CLIENT_ID');
    const after = await harness.db.sources.getSource('cid-bridge');
    expect((after?.config as any).upstream.clientId).toBe('!deadbeef');
  });
});
