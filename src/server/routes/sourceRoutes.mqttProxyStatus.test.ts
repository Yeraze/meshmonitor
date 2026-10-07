/**
 * GET /:id/status carries `mqttProxyUnlinked` for the source card's warning
 * (#5013): the node is in MQTT client-proxy mode and nothing carries its MQTT
 * traffic. It is device configuration, so only callers with per-source
 * `configuration` read get it — the grant GET /api/config/current asks for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

type ProxyState = { mqttEnabled: boolean; proxyToClientEnabled: boolean; proxyClientAttached: boolean } | null;

const { managers } = vi.hoisted(() => ({ managers: new Map<string, unknown>() }));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn((id: string) => managers.get(id) ?? null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

const BROKER = 'rt-mqtt-broker';
const PROXY_ON: ProxyState = { mqttEnabled: true, proxyToClientEnabled: true, proxyClientAttached: false };

function setNode(sourceId: string, proxy: ProxyState, sourceType = 'meshtastic_tcp') {
  managers.set(sourceId, {
    sourceId,
    sourceType,
    getStatus: () => ({ sourceId, sourceName: sourceId, sourceType, connected: true }),
    getLocalNodeInfo: () => null,
    getMqttClientProxyState: () => proxy,
  });
}

describe('sourceRoutes — mqttProxyUnlinked on /:id/status (#5013)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    managers.clear();
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    await databaseService.sources.deleteSource(BROKER).catch(() => {});
    await databaseService.sources.createSource({
      id: BROKER, name: 'Broker', type: 'mqtt_broker', config: {}, enabled: true,
    });
  });

  afterEach(async () => {
    await databaseService.sources.deleteSource(BROKER).catch(() => {});
    await harness.cleanup();
  });

  const linkA = (target: string) =>
    databaseService.sources.updateSource(harness.sourceA, {
      config: { mqttLink: { enabled: true, mqttBrokerSourceId: target } },
    });

  it('admin: set when proxy is on and no source is linked', async () => {
    setNode(harness.sourceA, PROXY_ON);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.status).toBe(200);
    expect(res.body.mqttProxyUnlinked).toBe(true);
  });

  it('absent when the link points at an enabled MQTT source', async () => {
    setNode(harness.sourceA, PROXY_ON);
    await linkA(BROKER);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.body).not.toHaveProperty('mqttProxyUnlinked');
  });

  it('set when the linked source is disabled', async () => {
    setNode(harness.sourceA, PROXY_ON);
    await linkA(BROKER);
    await databaseService.sources.updateSource(BROKER, { enabled: false });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.body.mqttProxyUnlinked).toBe(true);
  });

  it('set when the linked source was deleted', async () => {
    setNode(harness.sourceA, PROXY_ON);
    await linkA('gone');
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.body.mqttProxyUnlinked).toBe(true);
  });

  it.each<[string, ProxyState]>([
    ['proxy off', { mqttEnabled: true, proxyToClientEnabled: false, proxyClientAttached: false }],
    ['MQTT off', { mqttEnabled: false, proxyToClientEnabled: true, proxyClientAttached: false }],
    ['a Virtual Node client carries MQTT', { ...PROXY_ON!, proxyClientAttached: true }],
    ['module config not loaded yet', null],
  ])('absent: %s', async (_name, proxy) => {
    setNode(harness.sourceA, proxy);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('mqttProxyUnlinked');
  });

  it('absent when the source has no running manager', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.body).not.toHaveProperty('mqttProxyUnlinked');
  });

  it('configuration read on the source: set', async () => {
    setNode(harness.sourceA, PROXY_ON);
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.body.mqttProxyUnlinked).toBe(true);
  });

  it('hidden without configuration read on that source', async () => {
    setNode(harness.sourceA, PROXY_ON);
    // Grants that must not unlock it: the same resource on another source, and
    // other resources on this one.
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'sources', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/status`);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('mqttProxyUnlinked');

    const anon = await harness.loginAs(null);
    const anonRes = await anon.get(`/${harness.sourceA}/status`);
    expect(anonRes.status).toBe(200);
    expect(anonRes.body).not.toHaveProperty('mqttProxyUnlinked');
  });
});
