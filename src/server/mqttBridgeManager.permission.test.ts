/**
 * Permission-detection tests for MqttBrokerClient + MqttBridgeManager.
 *
 * Exercises SUBACK denial (0x80) detection, CONNACK auth-rejection
 * classification, and the user-facing permissionMessage produced from the
 * resulting capability snapshot. Uses Aedes as the upstream broker and its
 * `authorizeSubscribe` / `authenticate` hooks to simulate ACL restrictions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Aedes } from 'aedes';
import { createServer, type Server } from 'net';

const upsertNode = vi.fn();
const insertMessage = vi.fn().mockReturnValue(true);
const insertTelemetry = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    upsertNode: (...a: unknown[]) => upsertNode(...a),
    insertMessage: (...a: unknown[]) => insertMessage(...a),
    insertTelemetry: (...a: unknown[]) => insertTelemetry(...a),
  },
}));

import { MqttBrokerClient } from './transports/mqttBrokerClient.js';
import {
  MqttBridgeManager,
  buildPermissionMessage,
} from './mqttBridgeManager.js';
import { MqttBrokerManager } from './mqttBrokerManager.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';

async function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

interface UpstreamOptions {
  /** Topics that authorizeSubscribe should reject (returns qos=128). */
  denySubscriptionsMatching?: (topic: string) => boolean;
  /** When true, authenticate callback rejects with NotAuthorized (code 5). */
  rejectAuth?: boolean;
}

async function startUpstream(
  port: number,
  opts: UpstreamOptions = {},
): Promise<{ aedes: Aedes; server: Server }> {
  const aedes = await Aedes.createBroker({ id: 'upstream' });

  if (opts.rejectAuth) {
    aedes.authenticate = (_client, _username, _password, cb) => {
      // Code 5 = NOT_AUTHORIZED in MQTT 3.1.1 CONNACK return codes.
      const err = new Error('not authorized') as Error & { returnCode: number };
      err.returnCode = 5;
      cb(err, false);
    };
  }

  if (opts.denySubscriptionsMatching) {
    const shouldDeny = opts.denySubscriptionsMatching;
    aedes.authorizeSubscribe = (_client, sub, cb) => {
      if (shouldDeny(sub.topic)) {
        // Per Aedes lib/handlers/subscribe.js: returning a non-object
        // (typically null) signals failure and the broker emits SUBACK
        // qos=128 (MQTT 3.1.1 §3.9.3) for that topic.
        cb(null, null);
        return;
      }
      cb(null, sub);
    };
  }

  const server = createServer((socket) => aedes.handle(socket));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  return { aedes, server };
}

async function stopUpstream(u: { aedes: Aedes; server: Server }): Promise<void> {
  await new Promise<void>((resolve) => u.server.close(() => resolve()));
  await new Promise<void>((resolve) => u.aedes.close(() => resolve()));
}

/** Resolve when the predicate returns true. Polls every 20ms up to `timeoutMs`. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('buildPermissionMessage', () => {
  it('returns null when broker is fully permissive', () => {
    const msg = buildPermissionMessage(
      { canSubscribe: true, canPublish: 'unknown', authFailed: false, deniedSubscriptions: [] },
      1,
    );
    expect(msg).toBeNull();
  });

  it('flags auth failures distinctly from subscribe denials', () => {
    const msg = buildPermissionMessage(
      { canSubscribe: false, canPublish: 'unknown', authFailed: true, deniedSubscriptions: [] },
      1,
    );
    expect(msg).toContain('authentication');
  });

  it('uses publish-only phrasing when every requested subscription was denied', () => {
    const msg = buildPermissionMessage(
      {
        canSubscribe: false,
        canPublish: 'unknown',
        authFailed: false,
        deniedSubscriptions: ['msh/CA/#', 'msh/US/#'],
      },
      2,
    );
    expect(msg).toContain('publish-only');
    expect(msg).toContain('downlink is disabled');
  });

  it('lists denied topics inline when only some subs were rejected', () => {
    const msg = buildPermissionMessage(
      {
        canSubscribe: true,
        canPublish: 'unknown',
        authFailed: false,
        deniedSubscriptions: ['msh/blocked/#'],
      },
      3,
    );
    expect(msg).toContain('msh/blocked/#');
    expect(msg).toContain('Downlink reduced');
  });

  it('truncates long denial lists with a "+N more" overflow', () => {
    const msg = buildPermissionMessage(
      {
        canSubscribe: true,
        canPublish: 'unknown',
        authFailed: false,
        deniedSubscriptions: ['a', 'b', 'c', 'd', 'e'],
      },
      5,
    );
    // requestedCount === deniedCount triggers the publish-only branch instead,
    // so use a partial-denial scenario for the overflow assertion.
    const partial = buildPermissionMessage(
      {
        canSubscribe: true,
        canPublish: 'unknown',
        authFailed: false,
        deniedSubscriptions: ['a', 'b', 'c', 'd', 'e'],
      },
      10,
    );
    expect(msg).toContain('publish-only');
    expect(partial).toContain('+2 more');
  });
});

describe('MqttBrokerClient permission detection', () => {
  let upstreamPort: number;
  let upstream: { aedes: Aedes; server: Server };
  let client: MqttBrokerClient | null = null;

  beforeEach(async () => {
    upstreamPort = await ephemeralPort();
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
    if (upstream) await stopUpstream(upstream);
  });

  it('marks topics with SUBACK qos=128 as denied and emits permission-denied', async () => {
    upstream = await startUpstream(upstreamPort, {
      denySubscriptionsMatching: (topic) => topic.startsWith('msh/blocked/'),
    });

    client = new MqttBrokerClient({ url: `mqtt://127.0.0.1:${upstreamPort}` });
    const deniedEvents: Array<{ kind: string; topics?: string[]; message: string }> = [];
    client.on('permission-denied', (info) => deniedEvents.push(info));

    await client.connect();
    await client.subscribe(['msh/allowed/#', 'msh/blocked/#']);

    const caps = client.getCapabilities();
    expect(caps.deniedSubscriptions).toEqual(['msh/blocked/#']);
    expect(caps.canSubscribe).toBe(true); // at least one granted
    expect(caps.authFailed).toBe(false);

    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0].kind).toBe('subscribe');
    expect(deniedEvents[0].topics).toEqual(['msh/blocked/#']);
  });

  it('reports canSubscribe=false when every subscription is denied', async () => {
    upstream = await startUpstream(upstreamPort, {
      denySubscriptionsMatching: () => true,
    });

    client = new MqttBrokerClient({ url: `mqtt://127.0.0.1:${upstreamPort}` });
    await client.connect();
    await client.subscribe(['msh/a/#', 'msh/b/#']);

    const caps = client.getCapabilities();
    expect(caps.canSubscribe).toBe(false);
    expect(caps.deniedSubscriptions.sort()).toEqual(['msh/a/#', 'msh/b/#']);
  });

  it('classifies CONNACK NotAuthorized as an auth failure', async () => {
    upstream = await startUpstream(upstreamPort, { rejectAuth: true });

    client = new MqttBrokerClient({
      url: `mqtt://127.0.0.1:${upstreamPort}`,
      username: 'bad',
      password: 'creds',
    });
    const deniedEvents: Array<{ kind: string; message: string }> = [];
    client.on('permission-denied', (info) => deniedEvents.push(info));
    // Absorb 'error' so EventEmitter doesn't rethrow as an unhandled
    // exception while mqtt.js retries the rejected CONNACK in the
    // background. Production callers register their own handler.
    client.on('error', () => {});

    // Don't await connect() — it never resolves on auth failure since
    // mqtt.js keeps retrying. Fire and wait for the error path instead.
    void client.connect();

    await waitFor(() => client!.getCapabilities().authFailed, 5000, 'authFailed');
    const caps = client.getCapabilities();
    expect(caps.authFailed).toBe(true);
    expect(deniedEvents.some((e) => e.kind === 'auth')).toBe(true);
  });
});

describe('MqttBridgeManager exposes capabilities + permissionMessage', () => {
  let upstreamPort: number;
  let localPort: number;
  let upstream: { aedes: Aedes; server: Server };
  let broker: MqttBrokerManager;
  let bridge: MqttBridgeManager;

  beforeEach(async () => {
    upsertNode.mockClear();
    insertMessage.mockClear();
    insertTelemetry.mockClear();

    upstreamPort = await ephemeralPort();
    localPort = await ephemeralPort();
    upstream = await startUpstream(upstreamPort, {
      denySubscriptionsMatching: (t) => t.startsWith('msh/forbidden/'),
    });

    broker = new MqttBrokerManager('local-broker', 'Local', {
      listener: { port: localPort, host: '127.0.0.1' },
      auth: { username: 'u', password: 'p' },
      gateway: {
        nodeNum: 0xdeadbeef,
        nodeId: '!deadbeef',
        longName: 'L',
        shortName: 'L',
      },
      rootTopic: 'msh',
    });
    await sourceManagerRegistry.addManager(broker);
  });

  afterEach(async () => {
    await sourceManagerRegistry.stopAll();
    await stopUpstream(upstream);
  });

  it('surfaces denied subscriptions and a human-readable permissionMessage', async () => {
    bridge = new MqttBridgeManager('test-bridge', 'Bridge', {
      brokerSourceId: 'local-broker',
      upstream: { url: `mqtt://127.0.0.1:${upstreamPort}` },
      subscriptions: ['msh/ok/#', 'msh/forbidden/#'],
    });
    await sourceManagerRegistry.addManager(bridge);

    await waitFor(
      () => bridge.getStatus().capabilities.deniedSubscriptions.length > 0,
      3000,
      'denied subscriptions populated',
    );

    const status = bridge.getStatus();
    expect(status.upstreamConnected).toBe(true);
    expect(status.capabilities.deniedSubscriptions).toEqual(['msh/forbidden/#']);
    expect(status.capabilities.canSubscribe).toBe(true); // ok/# was granted
    expect(status.permissionMessage).toContain('msh/forbidden/#');
    expect(status.permissionMessage).toContain('Downlink reduced');
  });
});
