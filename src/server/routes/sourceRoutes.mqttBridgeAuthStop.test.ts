/**
 * MQTT bridge — auth stop through the source routes.
 *
 * After five rejected logins in a row an upstream client of a bridge stops
 * reconnecting: the subscriber (intake halts), or one per-gateway publisher
 * (only that gateway stops). This file covers the route-level promises:
 *
 * - `GET /:id/status` says which part stopped. The route answers callers with
 *   no login, so it carries no username, password, broker host or broker error
 *   text, and gateway ids (node ids) only reach callers with `nodes:read`.
 * - A save that changes the config restarts the bridge, which clears every
 *   stop. A rename, or a save that changes nothing, leaves it alone.
 * - `POST /:id/connect` restarts the stopped parts and leaves a healthy or
 *   still-retrying bridge alone. Before this PR it refused every bridge.
 *
 * Uses `createRouteTestApp()` with the REAL registry, the REAL
 * `MqttBridgeManager`, publisher pool and `MqttBrokerClient`; only `mqtt.js` is
 * faked, so the fake plays the broker. The parent `mqtt_broker` is a stand-in
 * object: no listener is opened.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

/** How the fake broker answers a login, by Client ID. */
const broker = vi.hoisted(() => ({ rejects: (_clientId: string): boolean => false }));
const BROKER_TEXT = 'Connection refused: Not authorized';

vi.mock('mqtt', () => {
  const answer = (c: any) => {
    setImmediate(() => {
      if (!broker.rejects(c.clientId)) {
        c.emit('connect');
      } else {
        c.emit('error', Object.assign(new Error('Connection refused: Not authorized'), { code: 5 }));
        c.emit('close');
      }
    });
  };
  return {
    connect: vi.fn((_url: string, opts: { clientId: string }) => {
      const c = new EventEmitter() as any;
      c.clientId = opts.clientId;
      c.subscribe = vi.fn((_t: string[], _o: unknown, cb?: any) => cb && cb(null, [], {}));
      c.publish = vi.fn((_t: string, _p: Buffer, _o: unknown, cb?: any) => cb && cb());
      c.end = vi.fn((_f: boolean, _o: unknown, cb?: any) => cb && cb());
      c.reconnect = vi.fn(() => answer(c));
      answer(c);
      return c;
    }),
  };
});

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

import { connect } from 'mqtt';
import sourceRoutes from './sourceRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMqttBridgeManager } from '../sourceManagerTypes.js';
import { BRIDGE_AUTH_STOPPED_MESSAGE, BRIDGE_MAX_AUTH_FAILURES } from '../mqttBridgeManager.js';

const USERNAME = 'route-bridge-user';
const PASSWORD = 'route-bridge-pass';

const BROKER_NODE = 0x0000b0b0;
const SUBSCRIBER_ID = '!0000b0b0';
const GW_A = '!0000aaaa';
const GW_B = '!0000bbbb';

const sockets = (): any[] => (connect as any).mock.results.map((r: any) => r.value);
const socketsFor = (clientId: string) => sockets().filter((s) => s.clientId === clientId);
const lastSocketFor = (clientId: string) => socketsFor(clientId).at(-1);
const lastConnectOptions = () => (connect as any).mock.calls.at(-1)[1];
const settle = () => new Promise((r) => setImmediate(r));

describe('mqtt_bridge auth stop through the source routes', () => {
  let harness: RouteTestHarness;
  let run = 0;
  let parentId = '';
  let parent: any;
  const created: string[] = [];

  const host = () => `bridge-authstop-${run}.example`;
  const bridgeConfig = (over: Record<string, unknown> = {}) => ({
    brokerSourceId: parentId,
    upstream: { url: `mqtts://${host()}:8883`, username: USERNAME, password: PASSWORD },
    subscriptions: ['msh/US/#'],
    ignoreOkToMqtt: true,
    ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    broker.rejects = () => false;
    run += 1;
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });

    // A parent broker the bridge can attach to: a source row for the route's
    // validation, and a stand-in manager in the registry. No port is opened.
    parentId = `authstop-parent-${run}`;
    await databaseService.sources.createSource({
      id: parentId,
      name: `Parent ${run}`,
      type: 'mqtt_broker',
      config: {},
      enabled: false,
    });
    parent = new EventEmitter();
    parent.sourceId = parentId;
    parent.sourceType = 'mqtt_broker';
    parent.start = vi.fn().mockResolvedValue(undefined);
    parent.stop = vi.fn().mockResolvedValue(undefined);
    parent.getStatus = () => ({ sourceId: parentId, sourceName: 'Parent', sourceType: 'mqtt_broker', connected: true });
    parent.getLocalNodeInfo = () => ({ nodeNum: BROKER_NODE });
    parent.publish = vi.fn().mockResolvedValue(undefined);
    await sourceManagerRegistry.addManager(parent);
  });

  afterEach(async () => {
    // Stop every manager so no reconnect timer outlives the test.
    for (const id of created.splice(0)) {
      await sourceManagerRegistry.removeManager(id);
      await databaseService.sources.deleteSource(id).catch(() => {});
    }
    await sourceManagerRegistry.removeManager(parentId);
    await databaseService.sources.deleteSource(parentId).catch(() => {});
    await harness.cleanup();
  });

  async function createBridge(over: Record<string, unknown> = {}) {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/').send({
      name: `Bridge ${run}`,
      type: 'mqtt_bridge',
      config: bridgeConfig(over),
    });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    await settle();
    return { agent, id: res.body.id as string };
  }

  function bridgeManager(id: string) {
    const mgr = sourceManagerRegistry.getManager(id);
    if (!mgr || !isMqttBridgeManager(mgr)) throw new Error('no bridge manager registered');
    return mgr;
  }

  /** Feed a socket rejections until its client reaches the limit. */
  async function rejectToLimit(sock: any, already: number) {
    for (let i = already; i < BRIDGE_MAX_AUTH_FAILURES; i++) {
      sock.emit('error', Object.assign(new Error(BROKER_TEXT), { code: 5 }));
    }
    await settle();
  }

  /**
   * A bridge whose subscriber login is rejected, driven to the stop. The first
   * rejection answers the create's own connect; the rest are fed in directly
   * rather than waiting out the real backoff.
   */
  async function createSubscriberStopped() {
    broker.rejects = () => true;
    const { agent, id } = await createBridge();
    await rejectToLimit(lastSocketFor(SUBSCRIBER_ID), 1);
    expect(bridgeManager(id).getStatus().authStopped).toBe(true);
    return { agent, id };
  }

  /** A local gateway heard a packet; the parent broker hands it to the bridge. */
  let packetSeq = 0;
  async function uplink(gatewayId: string) {
    packetSeq += 1;
    parent.emit('local-packet', {
      topic: `msh/US/2/e/LongFast/${gatewayId}`,
      payload: Buffer.from(`uplink-${packetSeq}`),
      retained: false,
      envelope: { gatewayId, packet: { id: packetSeq, from: 0x1234 } },
      clientId: 'local-device',
    });
    await settle();
    await settle();
  }

  /** Subscriber and gateway B connected; gateway A refused until it stops. */
  async function createGatewayAStopped() {
    broker.rejects = (clientId) => clientId === GW_A;
    const { agent, id } = await createBridge();
    await uplink(GW_B);
    await uplink(GW_A);
    await rejectToLimit(lastSocketFor(GW_A), 1);
    expect(bridgeManager(id).getStatus().authStoppedGateways).toEqual([GW_A]);
    return { agent, id };
  }

  function expectNoSecrets(body: unknown) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(USERNAME);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(host());
    expect(text).not.toContain(BROKER_TEXT);
  }

  describe('GET /:id/status', () => {
    it('says the subscriber stopped because the login was rejected', async () => {
      const { agent, id } = await createSubscriberStopped();

      const res = await agent.get(`/${id}/status`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        sourceId: id,
        sourceType: 'mqtt_bridge',
        connected: false,
        authStopped: true,
        authStoppedGatewayCount: 0,
        permissionMessage: BRIDGE_AUTH_STOPPED_MESSAGE,
        lastError: BRIDGE_AUTH_STOPPED_MESSAGE,
      });
      expectNoSecrets(res.body);
    });

    it('gives a caller with no login the reason, and no credentials, host or broker text', async () => {
      const { id } = await createSubscriberStopped();

      const anon = await harness.loginAs(null);
      const res = await anon.get(`/${id}/status`);
      expect(res.status).toBe(200);
      expect(res.body.authStopped).toBe(true);
      expect(res.body.permissionMessage).toBe(BRIDGE_AUTH_STOPPED_MESSAGE);
      expectNoSecrets(res.body);
    });

    it('names the stopped gateway for an admin', async () => {
      const { agent, id } = await createGatewayAStopped();

      const res = await agent.get(`/${id}/status`);
      expect(res.body).toMatchObject({
        connected: true,
        authStopped: false,
        authStoppedGatewayCount: 1,
        authStoppedGateways: [GW_A],
      });
      expect(res.body.publishers[GW_A]).toMatchObject({ authStopped: true, connected: false });
      expect(res.body.publishers[GW_B]).toMatchObject({ authStopped: false, connected: true });
      expectNoSecrets(res.body);
    });

    it('gives a caller with no login the count of stopped gateways, and no gateway ids', async () => {
      const { id } = await createGatewayAStopped();

      const anon = await harness.loginAs(null);
      const res = await anon.get(`/${id}/status`);
      expect(res.status).toBe(200);
      expect(res.body.authStoppedGatewayCount).toBe(1);
      expect(res.body.authStoppedGateways).toBeUndefined();
      // Still enough for the "n/m gateways" badge.
      const entries = Object.values(res.body.publishers) as Array<{ connected: boolean; authStopped: boolean }>;
      expect(entries).toHaveLength(2);
      expect(entries.filter((e) => e.connected)).toHaveLength(1);
      expect(entries.filter((e) => e.authStopped)).toHaveLength(1);

      const text = JSON.stringify(res.body);
      expect(text).not.toContain(GW_A);
      expect(text).not.toContain(GW_B);
      expectNoSecrets(res.body);
    });

    it('gateway ids follow nodes:read on that source', async () => {
      const { id } = await createGatewayAStopped();

      const limited = await harness.loginAs(harness.limited);
      const without = await limited.get(`/${id}/status`);
      expect(without.body.authStoppedGatewayCount).toBe(1);
      expect(without.body.authStoppedGateways).toBeUndefined();
      expect(JSON.stringify(without.body)).not.toContain(GW_A);

      await harness.grant(harness.limited.id, 'nodes', 'read', id);
      const withRead = await limited.get(`/${id}/status`);
      expect(withRead.body.authStoppedGateways).toEqual([GW_A]);
      expect(withRead.body.publishers[GW_A]).toMatchObject({ authStopped: true });
      expectNoSecrets(withRead.body);
    });

    it('reports no stop for a healthy bridge', async () => {
      const { agent, id } = await createBridge();

      const res = await agent.get(`/${id}/status`);
      expect(res.body).toMatchObject({
        connected: true,
        authStopped: false,
        authStoppedGatewayCount: 0,
        authStoppedGateways: [],
        permissionMessage: null,
      });
    });
  });

  describe('PUT /:id', () => {
    it('a changed config restarts the bridge and clears the stop', async () => {
      const { agent, id } = await createSubscriberStopped();
      const stoppedManager = bridgeManager(id);

      broker.rejects = () => false;
      const res = await agent.put(`/${id}`).send({
        config: bridgeConfig({
          upstream: { url: `mqtts://${host()}:8883`, username: USERNAME, password: 'the-corrected-password' },
        }),
      });
      expect(res.status).toBe(200);
      await settle();

      const fresh = bridgeManager(id);
      expect(fresh).not.toBe(stoppedManager);
      expect(lastConnectOptions().password).toBe('the-corrected-password');
      const status = await agent.get(`/${id}/status`);
      expect(status.body).toMatchObject({ connected: true, authStopped: false, permissionMessage: null });
    });

    it('a changed config clears a gateway stop too', async () => {
      const { agent, id } = await createGatewayAStopped();

      broker.rejects = () => false;
      const res = await agent.put(`/${id}`).send({ config: bridgeConfig({ subscriptions: ['msh/EU/#'] }) });
      expect(res.status).toBe(200);
      await settle();

      const status = await agent.get(`/${id}/status`);
      expect(status.body).toMatchObject({ authStopped: false, authStoppedGatewayCount: 0 });
    });

    it('a changed config with the same wrong password gets five fresh attempts, not an endless loop', async () => {
      const { agent, id } = await createSubscriberStopped();
      const before = socketsFor(SUBSCRIBER_ID).length;

      const res = await agent.put(`/${id}`).send({ config: bridgeConfig({ subscriptions: ['msh/EU/#'] }) });
      expect(res.status).toBe(200);
      await settle();
      expect(socketsFor(SUBSCRIBER_ID).length).toBe(before + 1);
      expect(bridgeManager(id).getStatus().authStopped).toBe(false);

      await rejectToLimit(lastSocketFor(SUBSCRIBER_ID), 1);
      expect(bridgeManager(id).getStatus().authStopped).toBe(true);
    });

    it('a rename alone does not restart a stopped bridge or reset its count', async () => {
      const { agent, id } = await createSubscriberStopped();
      const mgr = bridgeManager(id);
      const before = sockets().length;

      const res = await agent.put(`/${id}`).send({ name: `Renamed ${run}` });
      expect(res.status).toBe(200);
      await settle();

      expect(bridgeManager(id)).toBe(mgr);
      expect(sockets().length).toBe(before);
      expect(mgr.getStatus().authStopped).toBe(true);
    });

    it('a rename sent with the unchanged config, as the edit form sends it, does not restart either', async () => {
      const { agent, id } = await createSubscriberStopped();
      const mgr = bridgeManager(id);
      const before = sockets().length;

      // The form never holds the stored password; it sends the rest back,
      // here with the keys in another order.
      const res = await agent.put(`/${id}`).send({
        name: `Renamed ${run}`,
        config: {
          ignoreOkToMqtt: true,
          subscriptions: ['msh/US/#'],
          upstream: { username: USERNAME, url: `mqtts://${host()}:8883` },
          brokerSourceId: parentId,
        },
      });
      expect(res.status).toBe(200);
      await settle();

      expect(bridgeManager(id)).toBe(mgr);
      expect(sockets().length).toBe(before);
      expect(mgr.getStatus().authStopped).toBe(true);
    });

    it('an unchanged save leaves a healthy bridge connected on the same socket', async () => {
      const { agent, id } = await createBridge();
      const mgr = bridgeManager(id);
      const sock = lastSocketFor(SUBSCRIBER_ID);
      const before = sockets().length;

      const res = await agent.put(`/${id}`).send({ name: `Renamed ${run}`, config: bridgeConfig() });
      expect(res.status).toBe(200);
      await settle();

      expect(bridgeManager(id)).toBe(mgr);
      expect(sockets().length).toBe(before);
      expect(sock.end).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/connect', () => {
    it('restarts a stopped subscriber', async () => {
      const { agent, id } = await createSubscriberStopped();
      const mgr = bridgeManager(id);

      broker.rejects = () => false;
      const res = await agent.post(`/${id}/connect`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, restarted: { subscriber: true, gateways: 0 } });

      expect(bridgeManager(id)).toBe(mgr);
      expect(socketsFor(SUBSCRIBER_ID)).toHaveLength(2);
      const status = await agent.get(`/${id}/status`);
      expect(status.body).toMatchObject({ connected: true, authStopped: false, permissionMessage: null });
    });

    it('a broker that still rejects gets five more attempts, then silence', async () => {
      const { agent, id } = await createSubscriberStopped();

      const res = await agent.post(`/${id}/connect`);
      expect(res.status).toBe(200);
      expect(bridgeManager(id).getStatus().authStopped).toBe(false);

      await rejectToLimit(lastSocketFor(SUBSCRIBER_ID), 1);
      expect(bridgeManager(id).getStatus().authStopped).toBe(true);
    });

    it('restarts only the stopped gateway and leaves the rest connected', async () => {
      const { agent, id } = await createGatewayAStopped();
      const subscriber = lastSocketFor(SUBSCRIBER_ID);
      const gatewayB = lastSocketFor(GW_B);

      broker.rejects = () => false;
      const res = await agent.post(`/${id}/connect`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, restarted: { subscriber: false, gateways: 1 } });
      await settle();

      expect(socketsFor(GW_A)).toHaveLength(2);
      expect(socketsFor(GW_B)).toHaveLength(1);
      expect(socketsFor(SUBSCRIBER_ID)).toHaveLength(1);
      expect(subscriber.end).not.toHaveBeenCalled();
      expect(gatewayB.end).not.toHaveBeenCalled();
      const status = await agent.get(`/${id}/status`);
      expect(status.body).toMatchObject({ authStoppedGatewayCount: 0, authStoppedGateways: [] });
      // Nothing was republished toward the mesh by the stop or the restart.
      expect(parent.publish).not.toHaveBeenCalled();
    });

    it('leaves a healthy bridge alone', async () => {
      const { agent, id } = await createBridge();
      const mgr = bridgeManager(id);
      const sock = lastSocketFor(SUBSCRIBER_ID);
      const before = sockets().length;

      const res = await agent.post(`/${id}/connect`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, alreadyRunning: true });
      expect(bridgeManager(id)).toBe(mgr);
      expect(sockets().length).toBe(before);
      expect(sock.end).not.toHaveBeenCalled();
    });

    it('leaves a bridge that is still retrying alone: a click adds no login attempts', async () => {
      broker.rejects = () => true;
      const { agent, id } = await createBridge();
      const sock = lastSocketFor(SUBSCRIBER_ID);
      const before = sockets().length;

      for (let i = 0; i < 10; i++) {
        const res = await agent.post(`/${id}/connect`);
        expect(res.body).toEqual({ success: true, alreadyRunning: true });
      }
      expect(sockets().length).toBe(before);
      expect(sock.reconnect).not.toHaveBeenCalled();
      expect(bridgeManager(id).getStatus().authStopped).toBe(false);
    });

    it('refuses a caller with no login', async () => {
      const { id } = await createSubscriberStopped();
      const before = sockets().length;

      const anon = await harness.loginAs(null);
      const res = await anon.post(`/${id}/connect`);
      expect([401, 403]).toContain(res.status);
      expect(sockets().length).toBe(before);
      expect(bridgeManager(id).getStatus().authStopped).toBe(true);
    });
  });
});
