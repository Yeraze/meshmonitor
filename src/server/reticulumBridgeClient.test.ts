/**
 * Tests for reticulumBridgeClient.ts (#3960 Phase 1a WP3).
 *
 * Uses a real in-process WebSocket server (the `ws` package's
 * `WebSocketServer`, already present transitively via socket.io) bound to an
 * ephemeral loopback port to stand in for the Python bridge — no Python
 * needed, per the build spec's test plan (§5). The client under test uses
 * the platform-global `WebSocket`, so this exercises the real wire protocol
 * end to end, not a mocked transport.
 *
 * The fixture-contract suite at the bottom loads every golden JSON fixture
 * WP2 committed under `bridge/tests/fixtures/` and asserts this module's
 * envelope decoder — and, for the two push-event fixtures, the full
 * client dispatch path — accepts them exactly. That is the cross-language
 * contract guard: if `protocol.py` and this file ever drift, this suite is
 * where it should be caught.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WSSocket } from 'ws';
import { ReticulumBridgeClient, ReticulumBridgeError } from './reticulumBridgeClient.js';
import { decodeEnvelope, PROTOCOL_VERSION, type AnnounceMessage, type InterfaceStatsMessage } from './reticulumProtocol.js';

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
  const fixtureFiles = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));

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
      ]),
    );
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
