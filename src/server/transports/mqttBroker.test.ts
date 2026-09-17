/**
 * MqttBroker.stop() with live clients (#5264).
 *
 * `net.Server.close(cb)` stops accepting new connections at once but only
 * calls back when every EXISTING connection has ended. An MQTT client — a
 * radio, a bridge, a TCP-linked device — holds its socket open indefinitely,
 * so a stop() that awaited `server.close` before tearing down the clients
 * never resolved. The source PUT awaits stop(), so saving a broker hung until
 * the browser gave up, port 1883 was already refusing connections, and each
 * retry stacked another `close` listener on the same Server until Node's
 * MaxListenersExceededWarning fired.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { connect, type MqttClient } from 'mqtt';
import { createServer } from 'net';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { MqttBroker } from './mqttBroker.js';

const AUTH = { username: 'mm', password: 's3cret' };

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
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

function connectClient(port: number, clientId: string): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const c = connect(`mqtt://127.0.0.1:${port}`, { ...AUTH, clientId, reconnectPeriod: 0 });
    c.once('connect', () => resolve(c));
    c.once('error', reject);
  });
}

/** Resolve with 'timeout' if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

describe('MqttBroker.stop() with connected clients (#5264)', () => {
  const brokers: MqttBroker[] = [];
  const clients: MqttClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) c.end(true);
    for (const b of brokers.splice(0)) await within(b.stop(), 2000);
  });

  async function startBroker(port: number): Promise<MqttBroker> {
    const b = new MqttBroker({ port, host: '127.0.0.1', auth: AUTH, brokerId: `t-${port}` });
    brokers.push(b);
    await b.start();
    return b;
  }

  it('resolves promptly while a client is still connected', async () => {
    const port = await ephemeralPort();
    const broker = await startBroker(port);
    clients.push(await connectClient(port, 'radio'));

    expect(await within(broker.stop(), 3000)).not.toBe('timeout');
    expect(broker.getStatus().listening).toBe(false);
  });

  it('disconnects the clients it was serving', async () => {
    const port = await ephemeralPort();
    const broker = await startBroker(port);
    const client = await connectClient(port, 'radio');
    clients.push(client);
    const closed = new Promise<void>((r) => client.once('close', () => r()));

    await within(broker.stop(), 3000);

    expect(await within(closed, 3000)).not.toBe('timeout');
  });

  it('frees the port so a restarted broker can listen on it again', async () => {
    const port = await ephemeralPort();
    const first = await startBroker(port);
    clients.push(await connectClient(port, 'radio'));
    await within(first.stop(), 3000);

    const second = await startBroker(port);
    expect(second.getStatus().listening).toBe(true);
    const again = await connectClient(port, 'radio-again');
    clients.push(again);
    expect(again.connected).toBe(true);
  });

  it('is safe to call repeatedly — no stacked close listeners, every call resolves', async () => {
    const port = await ephemeralPort();
    const broker = await startBroker(port);
    clients.push(await connectClient(port, 'radio'));
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.name);
    process.on('warning', onWarning);
    try {
      const calls = Array.from({ length: 15 }, () => broker.stop());
      expect(await within(Promise.all(calls), 3000)).not.toBe('timeout');
      // Let any deferred warning emit.
      await new Promise((r) => setTimeout(r, 50));
      expect(warnings).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('can be started again after stopping', async () => {
    const port = await ephemeralPort();
    const broker = await startBroker(port);
    clients.push(await connectClient(port, 'radio'));
    await within(broker.stop(), 3000);

    await broker.start();
    expect(broker.getStatus().listening).toBe(true);
  });
});
