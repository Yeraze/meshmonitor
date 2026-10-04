/**
 * MeshCore MQTT ingest — auth stop through the source routes (#5596).
 *
 * After five rejected logins an ingest source stops reconnecting. This file
 * covers the three route-level promises around that stop:
 *
 * - `GET /:id/status` (the payload the dashboard already polls) says why the
 *   source stopped, without the username, password or broker host — the route
 *   is readable without a login.
 * - A config save restarts the source on the new config, which clears the
 *   stop. Before this PR a save changed the stored config and left the running
 *   manager on the old one until a process restart.
 * - A manual connect clears it too. Before this PR `/connect` refused every
 *   `meshcore_mqtt` source with a 400.
 *
 * Uses `createRouteTestApp()` with the REAL registry, the REAL
 * `MeshCoreMqttManager` and the REAL `MqttBrokerClient`; only `mqtt.js` is
 * faked, so the fake plays the broker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

/** How the fake broker answers the next login. */
const broker = vi.hoisted(() => ({ mode: 'accept' as 'accept' | 'reject' }));

vi.mock('mqtt', () => {
  const answer = (c: any) => {
    setImmediate(() => {
      if (broker.mode === 'accept') {
        c.emit('connect');
      } else {
        c.emit('error', Object.assign(new Error('Connection refused: Bad username or password'), { code: 4 }));
        c.emit('close');
      }
    });
  };
  return {
    connect: vi.fn(() => {
      const c = new EventEmitter() as any;
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
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreMqttManager } from '../sourceManagerTypes.js';
import { INGEST_AUTH_STOPPED_MESSAGE, INGEST_MAX_AUTH_FAILURES } from '../meshcoreMqttManager.js';

const USERNAME = 'route-ingest-user';
const PASSWORD = 'route-ingest-pass';

const sockets = () => (connect as any).mock.results.map((r: any) => r.value);
const lastSocket = () => sockets().at(-1);
const lastConnectOptions = () => (connect as any).mock.calls.at(-1)[1];
const settle = () => new Promise((r) => setImmediate(r));

describe('meshcore_mqtt auth stop through the source routes (#5596)', () => {
  let harness: RouteTestHarness;
  let feed = 0;
  const created: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    broker.mode = 'accept';
    feed += 1;
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
  });

  afterEach(async () => {
    // Stop every manager so no reconnect timer outlives the test.
    for (const id of created.splice(0)) await sourceManagerRegistry.removeManager(id);
    await harness.cleanup();
  });

  async function createIngest(over: Record<string, unknown> = {}) {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/').send({
      name: `Ingest ${feed}`,
      type: 'meshcore_mqtt',
      config: {
        brokerUrl: `wss://authstop-${feed}.example:443`,
        region: 'MCO',
        username: USERNAME,
        password: PASSWORD,
        ...over,
      },
    });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    return { agent, id: res.body.id as string };
  }

  function ingestManager(id: string) {
    const mgr = sourceManagerRegistry.getManager(id);
    if (!mgr || !isMeshCoreMqttManager(mgr)) throw new Error('no ingest manager registered');
    return mgr;
  }

  /**
   * Create a source whose broker rejects the login, and drive it to the stop.
   * The first rejection answers the create's own connect; the rest are fed in
   * directly rather than waiting out 1 s + 2 s + 4 s + 8 s of real backoff.
   */
  async function createStopped() {
    broker.mode = 'reject';
    const { agent, id } = await createIngest();
    const sock = lastSocket();
    for (let i = 1; i < INGEST_MAX_AUTH_FAILURES; i++) {
      sock.emit('error', Object.assign(new Error('Connection refused: Bad username or password'), { code: 4 }));
    }
    await settle();
    expect(ingestManager(id).isAuthStopped()).toBe(true);
    return { agent, id, sock };
  }

  describe('GET /:id/status', () => {
    it('says the source stopped because the login was rejected', async () => {
      const { agent, id } = await createStopped();

      const res = await agent.get(`/${id}/status`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        sourceId: id,
        sourceType: 'meshcore_mqtt',
        connected: false,
        authStopped: true,
        permissionMessage: INGEST_AUTH_STOPPED_MESSAGE,
        lastError: INGEST_AUTH_STOPPED_MESSAGE,
      });
    });

    it('gives a caller with no login the reason, and no credentials or broker host', async () => {
      const { id } = await createStopped();

      const anon = await harness.loginAs(null);
      const res = await anon.get(`/${id}/status`);
      expect(res.status).toBe(200);
      expect(res.body.authStopped).toBe(true);
      expect(res.body.permissionMessage).toBe(INGEST_AUTH_STOPPED_MESSAGE);

      const text = JSON.stringify(res.body);
      expect(text).not.toContain(USERNAME);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(`authstop-${feed}.example`);
    });

    it('reports no stop for a healthy source', async () => {
      const { agent, id } = await createIngest();

      const res = await agent.get(`/${id}/status`);
      expect(res.body).toMatchObject({ connected: true, authStopped: false, permissionMessage: null });
    });
  });

  describe('PUT /:id — a config save clears the stop', () => {
    it('restarts the source on the new config', async () => {
      const { agent, id } = await createStopped();
      const stoppedManager = ingestManager(id);

      broker.mode = 'accept';
      const res = await agent.put(`/${id}`).send({
        config: {
          brokerUrl: `wss://authstop-${feed}.example:443`,
          region: 'MCO',
          username: USERNAME,
          password: 'the-corrected-password',
        },
      });
      expect(res.status).toBe(200);

      const fresh = ingestManager(id);
      expect(fresh).not.toBe(stoppedManager);
      expect(fresh.isAuthStopped()).toBe(false);
      expect(fresh.isConnected()).toBe(true);
      expect(lastConnectOptions().password).toBe('the-corrected-password');

      const status = await agent.get(`/${id}/status`);
      expect(status.body).toMatchObject({ connected: true, authStopped: false, permissionMessage: null });
    });

    it('a save with the same wrong password gets five fresh attempts, not an endless loop', async () => {
      const { agent, id } = await createStopped();
      const before = sockets().length;

      // Still rejecting. One save is one new connection.
      const res = await agent.put(`/${id}`).send({
        config: { brokerUrl: `wss://authstop-${feed}.example:443`, region: 'MCO', username: USERNAME },
      });
      expect(res.status).toBe(200);
      expect(sockets().length).toBe(before + 1);
      expect(ingestManager(id).isAuthStopped()).toBe(false);

      const sock = lastSocket();
      for (let i = 1; i < INGEST_MAX_AUTH_FAILURES; i++) {
        sock.emit('error', Object.assign(new Error('Connection refused: Bad username or password'), { code: 4 }));
      }
      await settle();
      expect(ingestManager(id).isAuthStopped()).toBe(true);
    });

    it('a rename alone does not touch the connection', async () => {
      const { agent, id } = await createIngest();
      const mgr = ingestManager(id);
      const before = sockets().length;

      const res = await agent.put(`/${id}`).send({ name: `Renamed ${feed}` });
      expect(res.status).toBe(200);
      expect(ingestManager(id)).toBe(mgr);
      expect(sockets().length).toBe(before);
    });

    it('turning auto-connect off stops the source and leaves it idle', async () => {
      const { agent, id } = await createIngest();

      const res = await agent.put(`/${id}`).send({
        config: {
          brokerUrl: `wss://authstop-${feed}.example:443`,
          region: 'MCO',
          username: USERNAME,
          autoConnect: false,
        },
      });
      expect(res.status).toBe(200);
      expect(sourceManagerRegistry.getManager(id)).toBeUndefined();
    });

    it('enabling a disabled source starts it', async () => {
      const { agent, id } = await createIngest();
      expect((await agent.put(`/${id}`).send({ enabled: false })).status).toBe(200);
      expect(sourceManagerRegistry.getManager(id)).toBeUndefined();

      expect((await agent.put(`/${id}`).send({ enabled: true })).status).toBe(200);
      expect(ingestManager(id).isConnected()).toBe(true);
    });
  });

  describe('POST /:id/connect — a manual connect clears the stop', () => {
    it('reconnects a stopped source', async () => {
      const { agent, id } = await createStopped();
      const stoppedManager = ingestManager(id);

      broker.mode = 'accept';
      const res = await agent.post(`/${id}/connect`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      const fresh = ingestManager(id);
      expect(fresh).not.toBe(stoppedManager);
      expect(fresh.isAuthStopped()).toBe(false);
      expect(fresh.isConnected()).toBe(true);
    });

    it('leaves an already-connected source alone', async () => {
      const { agent, id } = await createIngest();
      const mgr = ingestManager(id);
      const before = sockets().length;

      const res = await agent.post(`/${id}/connect`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, alreadyRunning: true });
      expect(ingestManager(id)).toBe(mgr);
      expect(sockets().length).toBe(before);
    });

    it('starts a source whose auto-connect is off', async () => {
      const { agent, id } = await createIngest({ autoConnect: false });
      expect(sourceManagerRegistry.getManager(id)).toBeUndefined();

      const res = await agent.post(`/${id}/connect`);
      expect(res.status).toBe(200);
      expect(ingestManager(id).isConnected()).toBe(true);
    });
  });
});
