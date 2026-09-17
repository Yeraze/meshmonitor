/**
 * MqttBrokerManager restart with a connected client (#5264) — the reported
 * scenario end to end: an operator saves the broker source repeatedly while a
 * radio stays connected. Each save stops the manager and starts a new one on
 * the same port. Before the fix the first stop() never resolved, so the save
 * hung, the port refused connections, and retries stacked `close` listeners.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { connect, type MqttClient } from 'mqtt';

const upsertNode = vi.fn();
const insertTelemetry = vi.fn();
const insertMessage = vi.fn(async () => true);

// Stateful fake for the manual-ignore gate (mqttIngestion.ts's defense-in-depth
// check: `databaseService.ignoredNodes.isIgnoredCached(fromNum, sourceId)`).
// Mirrors the real IgnoredNodesRepository's cache-key shape (`${sourceId}:${nodeNum}`)
// closely enough for `addIgnoredNodeAsync` to make `isIgnoredCached` true, which is
// all the Phase 2 broker-path coverage below needs.
const ignoredCache = new Set<string>();
function ignoreKey(nodeNum: number, sourceId: string): string {
  return `${sourceId}:${nodeNum}`;
}
const addIgnoredNodeAsync = vi.fn(async (nodeNum: number, sourceId: string) => {
  ignoredCache.add(ignoreKey(nodeNum, sourceId));
});
const isIgnoredCached = vi.fn((nodeNum: number, sourceId: string) => ignoredCache.has(ignoreKey(nodeNum, sourceId)));

vi.mock('../services/database.js', () => ({
  default: {
    upsertNodeAsync: async (...a: unknown[]) => upsertNode(...a),
    insertTelemetryAsync: async (...a: unknown[]) => insertTelemetry(...a),
    insertTracerouteAsync: vi.fn(async () => undefined),
    insertRouteSegmentAsync: vi.fn(async () => undefined),
    messages: {
      insertMessage: async (...a: unknown[]) => insertMessage(...a),
    },
    ignoredNodes: {
      addIgnoredNodeAsync: async (...a: unknown[]) => addIgnoredNodeAsync(...(a as [number, string])),
      isIgnoredCached: (...a: unknown[]) => isIgnoredCached(...(a as [number, string])),
    },
    // Inline auto-delete-by-distance (#3900) reads per-source settings on each
    // POSITION packet. Return null so the feature reads as disabled and the
    // inline check is a no-op for this suite.
    settings: {
      getSettingForSource: async () => null,
    },
    nodes: {
      getNode: async () => null,
    },
    deleteNodeAsync: vi.fn(async () => undefined),
    setNodeIgnoredAsync: vi.fn(async () => undefined),
  },
}));

import { MqttBrokerManager } from './mqttBrokerManager.js';

async function ephemeralPort(): Promise<number> {
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
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

function connectClient(port: number, clientId: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const c = connect(`mqtt://127.0.0.1:${port}`, { username: 'mm', password: 's3cret', clientId, reconnectPeriod: 0 });
    c.once('connect', () => resolve(c));
    c.once('error', reject);
  });
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

function makeManager(port: number): MqttBrokerManager {
  return new MqttBrokerManager('restart-broker', 'Restart Broker', {
    listener: { port, host: '127.0.0.1' },
    auth: { username: 'mm', password: 's3cret' },
    gateway: { nodeNum: 0xdeadbeef, nodeId: '!deadbeef', longName: 'MM', shortName: 'MM' },
    rootTopic: 'msh',
    hopLimitPolicy: { raise: { enabled: true, target: 3, portnums: [4, 67, 71] } },
  });
}

describe('MqttBrokerManager restart with a connected client (#5264)', () => {
  const clients: MqttClient[] = [];
  let current: MqttBrokerManager | null = null;

  afterEach(async () => {
    for (const c of clients.splice(0)) c.end(true);
    if (current) await within(current.stop(), 3000);
    current = null;
  });

  it('survives a dozen save-style restarts: every stop resolves, no listener leak, port keeps accepting', async () => {
    const port = await ephemeralPort();
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
    process.on('warning', onWarning);
    try {
      current = makeManager(port);
      await current.start();

      for (let i = 0; i < 12; i++) {
        clients.push(await connectClient(port, `radio-${i}`));
        expect(await within(current.stop(), 3000), `stop #${i + 1} hung`).not.toBe('timeout');
        current = makeManager(port);
        await current.start();
      }

      const last = await connectClient(port, 'radio-final');
      clients.push(last);
      expect(last.connected).toBe(true);
      expect(current.getStatus().listening).toBe(true);

      await new Promise((r) => setTimeout(r, 50));
      expect(warnings.filter((w) => w.startsWith('MaxListenersExceededWarning'))).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  }, 60_000);
});
