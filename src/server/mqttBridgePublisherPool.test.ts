/**
 * Unit tests for MqttBridgePublisherPool.
 *
 * Stands up a real Aedes broker that records every CONNECT's clientId and
 * every publish's clientId, then asserts the pool creates one upstream
 * connection per gatewayNum and that publishes ride the matching clientId.
 *
 * Pairs with the per-gateway integration test in mqttBridgeManager.test.ts;
 * here we exercise the pool API directly to keep failure modes localized.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Aedes, type Client as AedesClient } from 'aedes';
import { createServer, type Server } from 'net';

import {
  MqttBridgePublisherPool,
  formatGatewayClientId,
} from './mqttBridgePublisherPool.js';

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

interface UpstreamRecorder {
  aedes: Aedes;
  server: Server;
  port: number;
  connects: string[];                                            // clientIds in order
  publishes: Array<{ clientId: string | null; topic: string }>;
}

async function startUpstream(): Promise<UpstreamRecorder> {
  const port = await ephemeralPort();
  const aedes = await Aedes.createBroker({ id: 'pool-upstream' });
  const rec: UpstreamRecorder = { aedes, server: null as unknown as Server, port, connects: [], publishes: [] };
  aedes.on('client', (c: AedesClient) => rec.connects.push(c.id));
  aedes.on('publish', (packet, client) => {
    // Internal aedes broadcasts (e.g. $SYS, retained reload) come through
    // with client === null — ignore those, we only care about pool publishes.
    if (!client) return;
    rec.publishes.push({ clientId: client.id, topic: packet.topic });
  });
  const server = createServer((socket) => aedes.handle(socket));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  rec.server = server;
  return rec;
}

async function stopUpstream(rec: UpstreamRecorder): Promise<void> {
  await new Promise<void>((resolve) => rec.server.close(() => resolve()));
  await new Promise<void>((resolve) => rec.aedes.close(() => resolve()));
}

// Wait until predicate is true or timeout. Avoids fragile sleep-based asserts.
async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('MqttBridgePublisherPool', () => {
  let upstream: UpstreamRecorder;
  let pool: MqttBridgePublisherPool;

  beforeEach(async () => {
    upstream = await startUpstream();
    pool = new MqttBridgePublisherPool({
      url: `mqtt://127.0.0.1:${upstream.port}`,
      poolLabel: 'unit-test',
    });
  });

  afterEach(async () => {
    await pool.close();
    await stopUpstream(upstream);
  });

  it('formats clientIds as `!<8-hex>` matching firmware convention', () => {
    expect(formatGatewayClientId(0xdeadbeef)).toBe('!deadbeef');
    expect(formatGatewayClientId(0x1)).toBe('!00000001');
    // High-bit-set nodeNums (used for synthetic broker gateways) still
    // produce a valid 8-hex string — confirms the unsigned cast.
    expect(formatGatewayClientId(0x80000001)).toBe('!80000001');
  });

  it('creates one upstream connection per distinct gatewayNum and publishes through it', async () => {
    await pool.publish(0x11111111, 'msh/test/!11111111', Buffer.from('hello-a'));
    await pool.publish(0x22222222, 'msh/test/!22222222', Buffer.from('hello-b'));
    // Second publish from same gateway reuses the existing connection.
    await pool.publish(0x11111111, 'msh/test/!11111111', Buffer.from('hello-a-again'));

    await waitFor(() => upstream.publishes.length >= 3);

    // Two distinct CONNECTs — the third publish reused the first connection.
    expect(upstream.connects).toContain('!11111111');
    expect(upstream.connects).toContain('!22222222');
    const conn1Count = upstream.connects.filter((id) => id === '!11111111').length;
    expect(conn1Count).toBe(1);

    // Publishes carry the matching clientId on the wire.
    const fromGw1 = upstream.publishes.filter((p) => p.clientId === '!11111111');
    const fromGw2 = upstream.publishes.filter((p) => p.clientId === '!22222222');
    expect(fromGw1.length).toBe(2);
    expect(fromGw2.length).toBe(1);
  });

  it('exposes per-entry status via getStatus()', async () => {
    await pool.publish(0xabcdef01, 'msh/test/!abcdef01', Buffer.from('x'));
    await waitFor(() => upstream.publishes.length >= 1);

    const status = pool.getStatus();
    expect(Object.keys(status)).toEqual(['!abcdef01']);
    const entry = status['!abcdef01'];
    expect(entry.clientId).toBe('!abcdef01');
    expect(entry.publishes).toBe(1);
    expect(entry.lastPublishAt).not.toBeNull();
    expect(entry.lastError).toBeNull();
  });

  it('prepare() opens the connection without publishing', async () => {
    await pool.prepare(0xcafebabe);
    await waitFor(() => upstream.connects.includes('!cafebabe'));
    expect(upstream.publishes).toEqual([]);
    expect(pool.size()).toBe(1);
  });

  it('close() disconnects every pool entry and rejects further publishes', async () => {
    await pool.publish(0x11111111, 'msh/test/x', Buffer.from('x'));
    await waitFor(() => upstream.publishes.length >= 1);

    await pool.close();
    await expect(
      pool.publish(0x22222222, 'msh/test/y', Buffer.from('y')),
    ).rejects.toThrow(/closed/);
  });

  it('normalizes signed/negative gatewayNum input via unsigned 32-bit cast', async () => {
    // -1 interpreted as uint32 = 0xffffffff → `!ffffffff`
    await pool.publish(-1, 'msh/test/all', Buffer.from('z'));
    await waitFor(() => upstream.publishes.length >= 1);
    expect(upstream.connects).toContain('!ffffffff');
  });
});
