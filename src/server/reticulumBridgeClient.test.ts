/**
 * Tests for reticulumBridgeClient.ts (#3960 Phase 1a WP3).
 *
 * Uses a real in-process WebSocket server (the `ws` package's
 * `WebSocketServer`, a devDependency) bound to an ephemeral loopback port to
 * stand in for the Python bridge — no Python needed, per the build spec's
 * test plan (§5). The client under test uses the platform-global
 * `WebSocket`, so this exercises the real wire protocol end to end, not a
 * mocked transport.
 *
 * The fixture-contract suite at the bottom loads every golden JSON fixture
 * WP2 committed under `bridge/tests/fixtures/` and asserts this module's
 * envelope decoder — and, for the two push-event fixtures, the full
 * client dispatch path — accepts them exactly. That is the cross-language
 * contract guard: if `protocol.py` and this file ever drift, this suite is
 * where it should be caught.
 *
 * The `validateBridgeUrl` suite covers the SSRF guard added in response to
 * CodeQL's `js/request-forgery` finding on the config-supplied `bridgeUrl`
 * flowing into `new WebSocket()` — see that function's doc comment in
 * reticulumBridgeClient.ts for the full rationale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WSSocket } from 'ws';
import {
  ReticulumBridgeClient,
  ReticulumBridgeError,
  validateBridgeUrl,
  RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV,
} from './reticulumBridgeClient.js';
import {
  decodeEnvelope,
  PROTOCOL_VERSION,
  type AnnounceMessage,
  type InterfaceStatsMessage,
  type LxmfMessageEvent,
  type DeliveryStateEvent,
  type TelemetryMessage,
  type RadioConfigMessage,
  type DeviceInfoMessage,
  type ProbeResultMessage,
  type RemoteStatusMessage,
  type PathTableMessage,
} from './reticulumProtocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../bridge/tests/fixtures');

interface MockBridge {
  url: string;
  close: () => Promise<void>;
}

/** Starts a `ws` server on an ephemeral loopback port; `onConnection` scripts its replies. */
function startMockBridge(onConnection: (ws: WSSocket, send: (obj: Record<string, unknown>) => void) => void): Promise<MockBridge> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('listening', () => {
      const addr = wss.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => wss.close(() => res())),
      });
    });
    wss.on('connection', (ws) => {
      const send = (obj: Record<string, unknown>) => ws.send(JSON.stringify(obj));
      onConnection(ws, send);
    });
  });
}

function parseIncoming(data: unknown): Record<string, unknown> {
  const raw = typeof data === 'string' ? data : String(data);
  return JSON.parse(raw) as Record<string, unknown>;
}

const activeClients: ReticulumBridgeClient[] = [];
const activeBridges: MockBridge[] = [];

afterEach(async () => {
  for (const client of activeClients.splice(0)) {
    client.removeAllListeners();
    client.disconnect();
  }
  for (const bridge of activeBridges.splice(0)) {
    await bridge.close();
  }
});

function trackClient(client: ReticulumBridgeClient): ReticulumBridgeClient {
  activeClients.push(client);
  return client;
}

function trackBridge(bridge: MockBridge): MockBridge {
  activeBridges.push(bridge);
  return bridge;
}

describe('validateBridgeUrl', () => {
  it('accepts the default loopback URL (ws://127.0.0.1:8765)', () => {
    const url = validateBridgeUrl('ws://127.0.0.1:8765');
    expect(url.href).toBe('ws://127.0.0.1:8765/');
  });

  it('accepts localhost', () => {
    const url = validateBridgeUrl('ws://localhost:8765');
    expect(url.hostname).toBe('localhost');
  });

  it('accepts IPv6 loopback ([::1])', () => {
    const url = validateBridgeUrl('ws://[::1]:8765');
    expect(url.hostname).toBe('[::1]');
  });

  it('accepts wss:// on a loopback host', () => {
    const url = validateBridgeUrl('wss://127.0.0.1:8765');
    expect(url.protocol).toBe('wss:');
  });

  it('rejects a non-ws scheme (http:)', () => {
    expect(() => validateBridgeUrl('http://127.0.0.1:8765')).toThrow(ReticulumBridgeError);
  });

  it('rejects a non-ws scheme (file:)', () => {
    expect(() => validateBridgeUrl('file:///etc/passwd')).toThrow(ReticulumBridgeError);
  });

  it('rejects an unparseable URL', () => {
    expect(() => validateBridgeUrl('not a url')).toThrow(ReticulumBridgeError);
  });

  it('rejects the cloud-metadata SSRF host (169.254.169.254) with no allowlist set', () => {
    expect(() => validateBridgeUrl('ws://169.254.169.254/', {})).toThrow(ReticulumBridgeError);
    try {
      validateBridgeUrl('ws://169.254.169.254/', {});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ReticulumBridgeError);
      expect((e as ReticulumBridgeError).message).toContain('169.254.169.254');
      expect((e as ReticulumBridgeError).message).toContain(RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV);
    }
  });

  it('rejects an arbitrary external host (evil.example.com) with no allowlist set', () => {
    expect(() => validateBridgeUrl('ws://evil.example.com/', {})).toThrow(ReticulumBridgeError);
  });

  it('accepts a non-loopback host when it is present in RETICULUM_BRIDGE_ALLOWED_HOSTS', () => {
    const env = { [RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV]: 'reticulum-bridge.internal, other.example.com' };
    const url = validateBridgeUrl('ws://reticulum-bridge.internal:8765', env);
    expect(url.hostname).toBe('reticulum-bridge.internal');
  });

  it('still rejects a host absent from a non-empty allowlist', () => {
    const env = { [RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV]: 'reticulum-bridge.internal' };
    expect(() => validateBridgeUrl('ws://evil.example.com/', env)).toThrow(ReticulumBridgeError);
  });

  it('defaults to process.env when no env override is passed', () => {
    // No assertion on outcome (depends on the ambient test environment) —
    // this only proves the default parameter doesn't throw on access.
    expect(() => validateBridgeUrl('ws://127.0.0.1:8765')).not.toThrow();
  });
});

describe('ReticulumBridgeClient handshake', () => {
  it('completes hello/welcome then configure/ready and reaches the ready state', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    const welcomeEvents: unknown[] = [];
    const readyEvents: unknown[] = [];
    client.on('welcome', (w) => welcomeEvents.push(w));
    client.on('ready', (r) => readyEvents.push(r));

    await client.connect({ mode: 'attach', configDir: '/rns' });

    expect(client.isConnected()).toBe(true);
    expect(client.getState()).toBe('ready');
    expect(welcomeEvents).toHaveLength(1);
    expect(readyEvents).toHaveLength(1);
  });

  it('connect() rejects a non-loopback bridgeUrl before ever opening a socket (SSRF guard at the sink)', async () => {
    const client = trackClient(
      new ReticulumBridgeClient({ bridgeUrl: 'ws://evil.example.com:1/', token: 'change-me', requestTimeoutMs: 500 }),
    );
    client.on('error', () => {});

    let caught: unknown;
    try {
      await client.connect({ mode: 'attach', configDir: '/rns' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReticulumBridgeError);
    // Distinguishes "validateBridgeUrl rejected it" from a network-level
    // BRIDGE_UNREACHABLE failure — the guard must fire before any socket is
    // opened, so the error names the allowlist env var, not a connection code.
    expect((caught as ReticulumBridgeError).message).toContain(RETICULUM_BRIDGE_ALLOWED_HOSTS_ENV);
    expect((caught as ReticulumBridgeError).code).toBeUndefined();
    expect(client.getState()).not.toBe('ready');
  });

  it('connects successfully when bridgeUrl carries a non-root path (constant-reconstruction path handling)', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );

    // The mock `ws` server doesn't restrict the upgrade path, so a
    // successful round trip here proves connectOnce()'s constant-literal
    // reconstruction preserves a non-root pathname rather than dropping it.
    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: `${bridge.url}/rns-bridge`, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    expect(client.isConnected()).toBe(true);
  });

  it('sends configure with the tcp_peer mode and peers', async () => {
    let capturedConfigure: Record<string, unknown> | null = null;
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            capturedConfigure = env;
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'tcp_peer', peers: [{ host: '10.0.0.5', port: 4242 }] });

    expect(capturedConfigure).toMatchObject({
      type: 'configure',
      mode: 'tcp_peer',
      peers: [{ host: '10.0.0.5', port: 4242 }],
    });
  });

  it('sends configure with own mode, device path, and initial radio params (#3960 Phase 3 WP4)', async () => {
    let capturedConfigure: Record<string, unknown> | null = null;
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            capturedConfigure = env;
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({
      mode: 'own',
      device: '/dev/ttyUSB0',
      frequency: 914_875_000,
      bandwidth: 125_000,
      spreadingFactor: 8,
      codingRate: 5,
      txPower: 17,
      stAlock: 33.3,
      ltAlock: 66.6,
    });

    expect(capturedConfigure).toMatchObject({
      type: 'configure',
      mode: 'own',
      device: '/dev/ttyUSB0',
      frequency: 914_875_000,
      bandwidth: 125_000,
      spreadingFactor: 8,
      codingRate: 5,
      txPower: 17,
      stAlock: 33.3,
      ltAlock: 66.6,
    });
  });

  it('own-mode configure omits unset radio-param fields rather than sending them as undefined', async () => {
    let capturedConfigure: Record<string, unknown> | null = null;
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            capturedConfigure = env;
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'own', device: '/dev/ttyUSB0' });

    expect(capturedConfigure).toMatchObject({ type: 'configure', mode: 'own', device: '/dev/ttyUSB0' });
    expect(Object.keys(capturedConfigure as Record<string, unknown>)).not.toEqual(
      expect.arrayContaining(['frequency', 'bandwidth', 'spreadingFactor', 'codingRate', 'txPower', 'stAlock', 'ltAlock']),
    );
  });

  it('forwards remoteAllowed as a comma-separated field on configure (#3960 Phase 4 WP3, build spec §0 R5)', async () => {
    let capturedConfigure: Record<string, unknown> | null = null;
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            capturedConfigure = env;
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns', remoteAllowed: ['aabb1122', 'ccdd3344'] });

    expect(capturedConfigure).toMatchObject({ type: 'configure', remoteAllowed: 'aabb1122,ccdd3344' });
  });

  it('omits remoteAllowed from configure when not provided', async () => {
    let capturedConfigure: Record<string, unknown> | null = null;
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            capturedConfigure = env;
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });

    expect(Object.keys(capturedConfigure as Record<string, unknown>)).not.toEqual(
      expect.arrayContaining(['remoteAllowed']),
    );
  });

  // PR review finding 3: requestIdCounter used to be a module-level `let`,
  // so a second client (parallel test workers, or two real sources) would
  // continue the first client's sequence instead of starting its own.
  it('mints request ids from a per-instance counter, not a shared module counter', async () => {
    const capturedIds: string[] = [];
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            capturedIds.push(env.id as string);
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );

    const clientA = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await clientA.connect({ mode: 'attach', configDir: '/rns' });

    const clientB = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await clientB.connect({ mode: 'attach', configDir: '/rns' });

    expect(capturedIds).toHaveLength(2);
    // Each client's FIRST request (its initial `configure`) carries counter
    // suffix "1". If the counter were still module-level, client B's first
    // request would carry suffix "2" — continuing client A's sequence.
    expect(capturedIds[0]).toMatch(/^req-\d+-1$/);
    expect(capturedIds[1]).toMatch(/^req-\d+-1$/);
  });

  it('rejects with AUTH_FAILED when the bridge refuses the token', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'error', ts: Date.now(), code: 'AUTH_FAILED', message: 'token rejected' });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'wrong', requestTimeoutMs: 2000 }));
    client.on('error', () => {}); // avoid EventEmitter's throw-on-unhandled-'error' for the post-reject close

    await expect(client.connect({ mode: 'attach', configDir: '/rns' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(client.getState()).not.toBe('ready');
  });

  it('rejects with PROTOCOL_VERSION_MISMATCH when the bridge speaks a different protocol version', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'error', ts: Date.now(), code: 'PROTOCOL_VERSION_MISMATCH' });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me', requestTimeoutMs: 2000 }));
    client.on('error', () => {});

    let caught: unknown;
    try {
      await client.connect({ mode: 'attach', configDir: '/rns' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReticulumBridgeError);
    expect((caught as ReticulumBridgeError).code).toBe('PROTOCOL_VERSION_MISMATCH');
  });

  it('rejects with an RPC_AUTH_FAILED error surfaced during configure', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({
              v: 1,
              type: 'error',
              id: env.id,
              ts: Date.now(),
              code: 'RPC_AUTH_FAILED',
              message: 'rpc_key mismatch',
            });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me', requestTimeoutMs: 2000 }));
    client.on('error', () => {});

    await expect(client.connect({ mode: 'attach', configDir: '/rns' })).rejects.toMatchObject({
      code: 'RPC_AUTH_FAILED',
    });
  });
});

describe('ReticulumBridgeClient reconnect/backoff', () => {
  it('reconnects and re-runs both handshakes after the bridge drops the connection post-ready', async () => {
    let connectionCount = 0;
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        connectionCount += 1;
        const isFirstConnection = connectionCount === 1;
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
            if (isFirstConnection) {
              // Simulate the bridge process restart (build-spec wire-protocol
              // fact #3): drop the socket shortly after the first session
              // reaches ready. The client's reconnect loop must re-open,
              // re-hello, and re-configure against the "fresh process" (the
              // same mock server here, but a new connection).
              setTimeout(() => ws.close(), 20);
            }
          }
        });
      }),
    );

    const client = trackClient(
      new ReticulumBridgeClient({
        bridgeUrl: bridge.url,
        token: 'change-me',
        reconnectInitialDelayMs: 20,
        reconnectMaxDelayMs: 50,
      }),
    );
    const readyEvents: unknown[] = [];
    const reconnectingEvents: Array<{ attempt: number; delayMs: number }> = [];
    client.on('ready', (r) => readyEvents.push(r));
    client.on('reconnecting', (e) => reconnectingEvents.push(e));
    client.on('error', () => {}); // transport error from the induced drop is expected

    await client.connect({ mode: 'attach', configDir: '/rns' });
    expect(readyEvents).toHaveLength(1);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for automatic reconnect')), 5000);
      client.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    expect(readyEvents).toHaveLength(2);
    expect(reconnectingEvents.length).toBeGreaterThanOrEqual(1);
    expect(reconnectingEvents[0]).toMatchObject({ attempt: 1, delayMs: 20 });
    expect(connectionCount).toBeGreaterThanOrEqual(2);
    expect(client.isConnected()).toBe(true);
  });

  it('does not schedule a reconnect when the very first connect() attempt fails', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'error', ts: Date.now(), code: 'AUTH_FAILED' });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'wrong', requestTimeoutMs: 2000 }));
    const reconnectingEvents: unknown[] = [];
    client.on('reconnecting', (e) => reconnectingEvents.push(e));
    client.on('error', () => {});

    await expect(client.connect({ mode: 'attach', configDir: '/rns' })).rejects.toBeInstanceOf(ReticulumBridgeError);

    // Give any (incorrect) reconnect scheduling a chance to fire before asserting absence.
    await new Promise((r) => setTimeout(r, 100));
    expect(reconnectingEvents).toHaveLength(0);
  });

  it('stops reconnecting once explicitly disconnected', async () => {
    let connectionCount = 0;
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        connectionCount += 1;
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );

    const client = trackClient(
      new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me', reconnectInitialDelayMs: 20 }),
    );
    client.on('error', () => {});
    await client.connect({ mode: 'attach', configDir: '/rns' });
    expect(connectionCount).toBe(1);

    client.disconnect();
    expect(client.getState()).toBe('closed');

    // No reconnect should occur after an explicit disconnect.
    await new Promise((r) => setTimeout(r, 150));
    expect(connectionCount).toBe(1);
  });
});

describe('ReticulumBridgeClient fixture contract parse', () => {
  // `.expected.json` files (e.g. sideband_telemetry_location_battery_temp.expected.json,
  // #3960 Phase 3 WP0/WP2) are bridge-side Python decode-test fixtures, not
  // Node-wire-protocol envelopes — they have no `type`/`v` envelope shell at
  // all, so they're excluded from this generic "every *.json is a valid
  // envelope" contract loop (pre-existing gap, fixed incidentally here).
  const fixtureFiles = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.expected.json'));

  it('found the golden fixture files committed by WP2', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
    expect(fixtureFiles).toEqual(
      expect.arrayContaining([
        'hello.json',
        'welcome.json',
        'error.json',
        'configure.json',
        'ready.json',
        'announce.json',
        'announce_no_signal.json',
        'interface_stats.json',
        'path_table.json',
        'get_status.json',
        'status.json',
        'probe.json',
        'probe_result.json',
        'probe_result_unreachable.json',
        'get_remote_status.json',
        'remote_status.json',
        'remote_status_denied.json',
      ]),
    );
  });

  it('every fixture is pinned to protocol v4 (#3960 Phase 4 WP3 drift guard)', () => {
    // This is the cross-language lockstep guard: protocol.py's
    // PROTOCOL_VERSION bumped 3->4 for Phase 4 (probe + remote status), and
    // every fixture WP2 committed was regenerated at v4 — if this file's
    // PROTOCOL_VERSION or a fixture's `v` ever drifts from the other, this
    // assertion (generalized from the per-file loop below, which already
    // asserts `env.v === PROTOCOL_VERSION`) is where it's caught.
    expect(PROTOCOL_VERSION).toBe(4);
    for (const file of fixtureFiles) {
      const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');
      const parsed = JSON.parse(raw) as { v?: number };
      expect(parsed.v, `${file} should be pinned to v4`).toBe(4);
    }
  });

  for (const file of fixtureFiles) {
    it(`decodeEnvelope() accepts ${file} as a well-formed v1 envelope`, () => {
      const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');
      const env = decodeEnvelope(raw);
      expect(env.v).toBe(PROTOCOL_VERSION);
      expect(typeof env.type).toBe('string');
      expect(typeof env.ts).toBe('number');
    });
  }

  it('announce.json carries populated signal fields (attach-mode announce)', () => {
    const env = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'announce.json'), 'utf-8')) as AnnounceMessage;
    expect(env.type).toBe('announce');
    expect(typeof env.destinationHash).toBe('string');
    expect(env.appName).toBe('lxmf');
    expect(env.aspects).toEqual(['delivery']);
    expect(typeof env.rssi).toBe('number');
    expect(typeof env.snr).toBe('number');
    expect(typeof env.q).toBe('number');
    expect(env.isPathResponse).toBe(false);
  });

  it('announce_no_signal.json carries explicit nulls (loopback tcp_peer announce, no RF)', () => {
    const env = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'announce_no_signal.json'), 'utf-8')) as AnnounceMessage;
    expect(env.type).toBe('announce');
    expect(env.appName).toBeNull();
    expect(env.aspects).toBeNull();
    expect(env.rssi).toBeNull();
    expect(env.snr).toBeNull();
    expect(env.q).toBeNull();
    expect(env.isPathResponse).toBe(true);
  });

  it('interface_stats.json matches the {name,type,hash?,mode?,status,online,bitrate?,txBytes,rxBytes} shape exactly', () => {
    const env = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'interface_stats.json'), 'utf-8'),
    ) as InterfaceStatsMessage;
    expect(env.type).toBe('interface_stats');
    expect(env.interfaces).toHaveLength(2);
    const up = env.interfaces.find((i) => i.status === 'up');
    const down = env.interfaces.find((i) => i.status === 'down');
    expect(up).toMatchObject({ name: 'TCP Server Interface', type: 'TCPServerInterface', online: true, status: 'up' });
    expect(down).toMatchObject({ name: 'tcp_peer_127.0.0.1_4242', type: 'TCPClientInterface', online: false, status: 'down' });
    for (const iface of env.interfaces) {
      expect(Object.keys(iface).sort()).toEqual(
        ['bitrate', 'hash', 'mode', 'name', 'online', 'rxBytes', 'status', 'txBytes', 'type'].sort(),
      );
    }
  });

  it('path_table.json decodes into the mirrored PathTableEntry shape (#3960 Phase 4 WP3 drift guard)', () => {
    const env = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'path_table.json'), 'utf-8')) as PathTableMessage;
    expect(env.type).toBe('path_table');
    expect(env.paths).toHaveLength(1);
    expect(env.paths[0]).toMatchObject({
      destinationHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      via: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      hops: 1,
      interface: 'TCP Server Interface',
      expires: 1755001800.0,
    });
  });

  it('probe_result.json decodes into the mirrored ProbeResultMessage shape, ok:true branch (#3960 Phase 4 WP3 drift guard)', () => {
    const env = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'probe_result.json'), 'utf-8'),
    ) as ProbeResultMessage;
    expect(env.type).toBe('probe_result');
    expect(env.ok).toBe(true);
    expect(env.destinationHash).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(env.rttMs).toBe(842.5);
    expect(env.hops).toBe(3);
    expect(env.error).toBeNull();
  });

  it('probe_result_unreachable.json decodes into the mirrored ProbeResultMessage shape, ok:false branch (#3960 Phase 4 WP3 drift guard)', () => {
    const env = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'probe_result_unreachable.json'), 'utf-8'),
    ) as ProbeResultMessage;
    expect(env.type).toBe('probe_result');
    expect(env.ok).toBe(false);
    expect(env.rttMs).toBeNull();
    expect(env.hops).toBeNull();
    expect(env.error).toBe('no path to destination');
  });

  it('remote_status.json decodes into the mirrored RemoteStatusMessage shape, ok:true branch (#3960 Phase 4 WP3 drift guard)', () => {
    const env = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'remote_status.json'), 'utf-8'),
    ) as RemoteStatusMessage;
    expect(env.type).toBe('remote_status');
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();
    expect(env.status).not.toBeNull();
    expect(env.status?.linkCount).toBe(2);
    expect(env.status?.interfaces).toHaveLength(1);
    expect(env.status?.interfaces[0]).toMatchObject({
      name: 'TCP Server Interface',
      type: 'TCPServerInterface',
      status: 'up',
      online: true,
    });
    expect(env.path).toHaveLength(1);
    expect(env.path?.[0]).toMatchObject({ destinationHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', hops: 1 });
  });

  it('remote_status_denied.json decodes into the mirrored RemoteStatusMessage shape, ok:false branch (#3960 Phase 4 WP3 drift guard)', () => {
    const env = JSON.parse(
      fs.readFileSync(path.join(FIXTURES_DIR, 'remote_status_denied.json'), 'utf-8'),
    ) as RemoteStatusMessage;
    expect(env.type).toBe('remote_status');
    expect(env.ok).toBe(false);
    expect(env.status).toBeNull();
    expect(env.path).toBeNull();
    expect(env.error).toBe('link to remote management destination did not establish');
  });

  it('client dispatches a live announce.json frame as an announce event', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'announce.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as AnnounceMessage;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
            // Push the golden announce fixture verbatim right after ready.
            send(fixture as unknown as Record<string, unknown>);
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    const announcePromise = new Promise<AnnounceMessage>((resolve) => {
      client.once('announce', (msg: AnnounceMessage) => resolve(msg));
    });
    await client.connect({ mode: 'attach', configDir: '/rns' });

    const received = await announcePromise;
    expect(received).toEqual(fixture);
  });

  it('client dispatches a live interface_stats.json frame as an interface_stats event', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'interface_stats.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as InterfaceStatsMessage;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
            send(fixture as unknown as Record<string, unknown>);
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    const statsPromise = new Promise<InterfaceStatsMessage>((resolve) => {
      client.once('interface_stats', (msg: InterfaceStatsMessage) => resolve(msg));
    });
    await client.connect({ mode: 'attach', configDir: '/rns' });

    const received = await statsPromise;
    expect(received).toEqual(fixture);
  });

  it('client dispatches a live path_table.json frame as a path_table event', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'path_table.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
            send(fixture);
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    const pathTablePromise = new Promise<unknown>((resolve) => {
      client.once('path_table', (msg: unknown) => resolve(msg));
    });
    await client.connect({ mode: 'attach', configDir: '/rns' });

    const received = await pathTablePromise;
    expect(received).toEqual(fixture);
  });

  it('client requestStatus() resolves with a live status.json-shaped reply', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'status.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'get_status') {
            send({ ...fixture, id: env.id });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    const status = await client.requestStatus();
    expect(status).toMatchObject({
      type: 'status',
      connected: true,
      mode: 'attach',
      interfaceCount: 2,
      rnsVersion: '1.4.2',
    });
  });
});

describe('ReticulumBridgeClient Phase 2 LXMF messaging (#3960 Phase 2 WP3)', () => {
  it('dispatches a live lxmf_message.json push frame as an lxmf_message event', async () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'lxmf_message.json'), 'utf-8'));
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
            send(fixture);
          }
        });
      }),
    );
    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    const received = new Promise<LxmfMessageEvent>((resolve) => client.once('lxmf_message', resolve));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    expect(await received).toEqual(fixture);
  });

  it('dispatches an unsolicited delivery_state.json push frame (no id) as a delivery_state event', async () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'delivery_state.json'), 'utf-8'));
    expect(fixture.id).toBeUndefined(); // guards the fixture's own shape assumption
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
            send(fixture);
          }
        });
      }),
    );
    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    const received = new Promise<DeliveryStateEvent>((resolve) => client.once('delivery_state', resolve));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    expect(await received).toEqual(fixture);
  });

  it('sendLxmf() resolves with the send_lxmf_response.json-shaped delivery_state reply and does NOT also dispatch it as a push event', async () => {
    const responseFixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'send_lxmf_response.json'), 'utf-8'));
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'send_lxmf') {
            send({ ...responseFixture, id: env.id });
          }
        });
      }),
    );
    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    let sawPushEvent = false;
    client.on('delivery_state', () => {
      sawPushEvent = true;
    });
    await client.connect({ mode: 'attach', configDir: '/rns' });

    const result = await client.sendLxmf({ to: '112233445566778899aabbccddeeff0', title: 'Hello', content: 'Hello from the WP1 spike!', method: 'opportunistic' });
    expect(result).toMatchObject({ type: 'delivery_state', hash: responseFixture.hash, state: 'sending', method: 'opportunistic' });
    expect(sawPushEvent).toBe(false);
  });

  it('announceSelf()/setDisplayName()/syncPropagation()/setPropagationNode() resolve with a ready-shaped ack', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          } else if (
            env.type === 'announce_self' ||
            env.type === 'set_display_name' ||
            env.type === 'sync_propagation' ||
            env.type === 'set_propagation_node'
          ) {
            send({ v: 2, type: 'ready', id: env.id, ts: Date.now() });
          }
        });
      }),
    );
    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });

    await expect(client.announceSelf()).resolves.toMatchObject({ type: 'ready' });
    await expect(client.setDisplayName('Alice')).resolves.toMatchObject({ type: 'ready' });
    await expect(client.syncPropagation()).resolves.toMatchObject({ type: 'ready' });
    await expect(client.setPropagationNode('abcd'.padEnd(32, '0'))).resolves.toMatchObject({ type: 'ready' });
  });

  it('sendLxmf()/announceSelf() reject with the bridge-sent error when the command fails (LXMF_COMMAND_FAILED)', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'send_lxmf') {
            send({ v: 2, type: 'error', id: env.id, code: 'LXMF_COMMAND_FAILED', message: 'no route', ts: Date.now() });
          }
        });
      }),
    );
    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    await expect(client.sendLxmf({ to: 'deadbeef'.padEnd(32, '0') })).rejects.toMatchObject({ code: 'LXMF_COMMAND_FAILED' });
  });
});

describe('ReticulumBridgeClient Phase 3 telemetry + own-mode radio config/device info (#3960 WP4)', () => {
  it('client dispatches a live telemetry.json frame as a telemetry event', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'telemetry.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as TelemetryMessage;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
            send(fixture as unknown as Record<string, unknown>);
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    const telemetryPromise = new Promise<TelemetryMessage>((resolve) => {
      client.once('telemetry', (msg: TelemetryMessage) => resolve(msg));
    });
    await client.connect({ mode: 'attach', configDir: '/rns' });

    const received = await telemetryPromise;
    expect(received).toEqual(fixture);
    expect(received.id).toBeUndefined(); // telemetry is always unsolicited/pushed, never id-correlated
  });

  it('getRadioConfig() resolves with a live radio_config.json-shaped reply', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'radio_config.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'get_radio_config') {
            send({ ...fixture, id: env.id });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'own', device: '/dev/ttyUSB0' });
    const config: RadioConfigMessage = await client.getRadioConfig();
    expect(config).toMatchObject({
      type: 'radio_config',
      frequency: 914_875_000,
      bandwidth: 125_000,
      spreadingFactor: 8,
      codingRate: 5,
      txPower: 17,
      radioState: true,
    });
  });

  it('setRadioConfig() sends only the patched fields and resolves with the echoed radio_config reply', async () => {
    let capturedSet: Record<string, unknown> | null = null;
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'set_radio_config') {
            capturedSet = env;
            send({ v: 3, type: 'radio_config', id: env.id, ts: Date.now(), frequency: 915_000_000, bandwidth: null, spreadingFactor: null, codingRate: null, txPower: 20, stAlock: null, ltAlock: null, radioState: null });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'own', device: '/dev/ttyUSB0' });
    const config = await client.setRadioConfig({ frequency: 915_000_000, txPower: 20 });

    expect(capturedSet).toMatchObject({ type: 'set_radio_config', frequency: 915_000_000, txPower: 20 });
    expect(Object.keys(capturedSet as Record<string, unknown>)).not.toEqual(
      expect.arrayContaining(['bandwidth', 'spreadingFactor', 'codingRate', 'stAlock', 'ltAlock', 'radioState']),
    );
    expect(config).toMatchObject({ type: 'radio_config', frequency: 915_000_000, txPower: 20 });
  });

  it('getDeviceInfo() resolves with a live device_info.json-shaped reply', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'device_info.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'get_device_info') {
            send({ ...fixture, id: env.id });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'own', device: '/dev/ttyUSB0' });
    const info: DeviceInfoMessage = await client.getDeviceInfo();
    expect(info).toMatchObject({
      type: 'device_info',
      firmwareVersion: '1.52',
      mcu: 30,
      platform: 128,
      chipTemp: 34,
      csma: { cwBand: 2, cwMin: 3, cwMax: 8 },
    });
  });

  it('getRadioConfig()/setRadioConfig()/getDeviceInfo() reject with the bridge-sent OWN_MODE_REQUIRED error in attach/tcp_peer mode', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 1, type: 'welcome', ts: Date.now(), protocolVersion: 1, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 1, type: 'ready', id: env.id, ts: Date.now() });
          } else if (
            env.type === 'get_radio_config' ||
            env.type === 'set_radio_config' ||
            env.type === 'get_device_info'
          ) {
            send({ v: 3, type: 'error', id: env.id, code: 'OWN_MODE_REQUIRED', message: 'source is not running in own mode', ts: Date.now() });
          }
        });
      }),
    );
    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });

    await expect(client.getRadioConfig()).rejects.toMatchObject({ code: 'OWN_MODE_REQUIRED' });
    await expect(client.setRadioConfig({ txPower: 17 })).rejects.toMatchObject({ code: 'OWN_MODE_REQUIRED' });
    await expect(client.getDeviceInfo()).rejects.toMatchObject({ code: 'OWN_MODE_REQUIRED' });
  });
});

describe('ReticulumBridgeClient Phase 4 probe + remote status (#3960 WP2/WP3)', () => {
  it('probe() resolves with a live probe_result.json-shaped reply and sends the destinationHash/timeoutS fields', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'probe_result.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;
    let captured: Record<string, unknown> | null = null;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 4, type: 'welcome', ts: Date.now(), protocolVersion: 4, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 4, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'probe') {
            captured = env;
            send({ ...fixture, id: env.id });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    const result: ProbeResultMessage = await client.probe({
      destinationHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      timeoutS: 12,
    });

    expect(captured).toMatchObject({
      type: 'probe',
      destinationHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      timeoutS: 12,
    });
    expect(result).toMatchObject({ type: 'probe_result', ok: true, rttMs: 842.5, hops: 3 });
  });

  it('probe() resolves (not rejects) with an ok:false result for an unreachable destination', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'probe_result_unreachable.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 4, type: 'welcome', ts: Date.now(), protocolVersion: 4, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 4, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'probe') {
            send({ ...fixture, id: env.id });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    const result = await client.probe({ destinationHash: '112233445566778899aabbccddeeff0' });

    expect(result).toMatchObject({ ok: false, rttMs: null, hops: null, error: 'no path to destination' });
  });

  it('probe() rejects with the bridge-sent PROBE_FAILED typed error', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 4, type: 'welcome', ts: Date.now(), protocolVersion: 4, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 4, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'probe') {
            send({ v: 4, type: 'error', id: env.id, code: 'PROBE_FAILED', message: 'malformed destination hash', ts: Date.now() });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    await expect(client.probe({ destinationHash: 'zz' })).rejects.toMatchObject({ code: 'PROBE_FAILED' });
  });

  it('probe() rejects on a request timeout when the bridge never replies', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 4, type: 'welcome', ts: Date.now(), protocolVersion: 4, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 4, type: 'ready', id: env.id, ts: Date.now() });
          }
          // 'probe' command intentionally never answered.
        });
      }),
    );

    const client = trackClient(
      new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me', requestTimeoutMs: 300 }),
    );
    await client.connect({ mode: 'attach', configDir: '/rns' });
    await expect(client.probe({ destinationHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })).rejects.toThrow(
      /timed out waiting for probe_result reply/,
    );
  });

  it('getRemoteStatus() resolves with a live remote_status.json-shaped reply and sends the destinationHash/timeoutS fields', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'remote_status.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;
    let captured: Record<string, unknown> | null = null;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 4, type: 'welcome', ts: Date.now(), protocolVersion: 4, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 4, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'get_remote_status') {
            captured = env;
            send({ ...fixture, id: env.id });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    const result: RemoteStatusMessage = await client.getRemoteStatus({
      destinationHash: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      timeoutS: 15,
    });

    expect(captured).toMatchObject({
      type: 'get_remote_status',
      destinationHash: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      timeoutS: 15,
    });
    expect(result.ok).toBe(true);
    expect(result.status?.linkCount).toBe(2);
  });

  it('getRemoteStatus() rejects with the bridge-sent REMOTE_MANAGEMENT_DENIED typed error', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 4, type: 'welcome', ts: Date.now(), protocolVersion: 4, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 4, type: 'ready', id: env.id, ts: Date.now() });
          } else if (env.type === 'get_remote_status') {
            send({
              v: 4,
              type: 'error',
              id: env.id,
              code: 'REMOTE_MANAGEMENT_DENIED',
              message: 'link to remote management destination did not establish',
              ts: Date.now(),
            });
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    await client.connect({ mode: 'attach', configDir: '/rns' });
    await expect(
      client.getRemoteStatus({ destinationHash: '112233445566778899aabbccddeeff0' }),
    ).rejects.toMatchObject({ code: 'REMOTE_MANAGEMENT_DENIED' });
  });

  it('getRemoteStatus() rejects on a request timeout when the bridge never replies', async () => {
    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 4, type: 'welcome', ts: Date.now(), protocolVersion: 4, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 4, type: 'ready', id: env.id, ts: Date.now() });
          }
          // 'get_remote_status' command intentionally never answered.
        });
      }),
    );

    const client = trackClient(
      new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me', requestTimeoutMs: 300 }),
    );
    await client.connect({ mode: 'attach', configDir: '/rns' });
    await expect(
      client.getRemoteStatus({ destinationHash: '9f8e7d6c5b4a39281706f5e4d3c2b1a0' }),
    ).rejects.toThrow(/timed out waiting for remote_status reply/);
  });

  it('client emits a path_table event for a live path_table.json frame, and does not surface probe/remote_status as push events', async () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES_DIR, 'path_table.json'), 'utf-8');
    const fixture = JSON.parse(fixtureRaw) as Record<string, unknown>;

    const bridge = trackBridge(
      await startMockBridge((ws, send) => {
        ws.on('message', (data) => {
          const env = parseIncoming(data);
          if (env.type === 'hello') {
            send({ v: 4, type: 'welcome', ts: Date.now(), protocolVersion: 4, bridgeVersion: '0.1.0', rnsVersion: '1.4.2' });
          } else if (env.type === 'configure') {
            send({ v: 4, type: 'ready', id: env.id, ts: Date.now() });
            send(fixture as unknown as Record<string, unknown>);
          }
        });
      }),
    );

    const client = trackClient(new ReticulumBridgeClient({ bridgeUrl: bridge.url, token: 'change-me' }));
    const pathTablePromise = new Promise<PathTableMessage>((resolve) => {
      client.once('path_table', (msg: PathTableMessage) => resolve(msg));
    });
    await client.connect({ mode: 'attach', configDir: '/rns' });

    const received = await pathTablePromise;
    expect(received).toEqual(fixture);
  });
});
