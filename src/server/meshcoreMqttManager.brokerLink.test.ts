/**
 * MeshCore MQTT ingest: broker-link alert wiring (#6307 S7).
 *
 * The REAL `MqttBrokerClient` against a fake `mqtt.js`; the server-event
 * service is a spy, so what is asserted is what the manager asks it to send.
 * The debounce rules themselves are covered in `brokerLinkNotifier.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: { upsertNode: vi.fn(), insertMessage: vi.fn() },
    channels: { getAllChannels: vi.fn().mockResolvedValue([]) },
    telemetry: { insertTelemetryBatch: vi.fn() },
  },
}));
vi.mock('./services/dataEventEmitter.js', () => ({ dataEventEmitter: { emitMeshCoreMessage: vi.fn() } }));
vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));
vi.mock('./services/meshcoreMessageFilter.js', () => ({
  meshcoreMessageFilter: {
    loadSource: vi.fn().mockResolvedValue(undefined),
    classify: vi.fn().mockReturnValue({ action: 'allow' }),
    countHit: vi.fn(),
  },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Fake mqtt.js client — the "broker" the tests drive. */
function makeFakeMqtt() {
  const c = new EventEmitter() as any;
  c.subscribe = vi.fn((_t: string[], _o: unknown, cb?: any) => cb && cb(null, [], {}));
  c.publish = vi.fn((_t: string, _p: Buffer, _o: unknown, cb?: any) => cb && cb());
  c.end = vi.fn((_f: boolean, _o: unknown, cb?: any) => cb && cb());
  c.reconnect = vi.fn();
  return c;
}
vi.mock('mqtt', () => ({ connect: vi.fn(() => makeFakeMqtt()) }));

vi.mock('./services/serverEventNotificationService.js', () => ({
  serverEventNotificationService: {
    notifyNodeConnected: vi.fn().mockResolvedValue(undefined),
    notifyNodeDisconnected: vi.fn().mockResolvedValue(undefined),
  },
}));

import { connect } from 'mqtt';
import { serverEventNotificationService as svc } from './services/serverEventNotificationService.js';
import { BROKER_LINK_GRACE_MS } from './services/brokerLinkNotifier.js';
import { MeshCoreMqttManager, INGEST_MAX_AUTH_FAILURES } from './meshcoreMqttManager.js';

const CONFIG = { brokerUrl: 'wss://broker.example:443', region: 'mco', username: 'u', password: 'p' };
const lastSocket = () => (connect as any).mock.results.at(-1).value;
const down = () => (svc.notifyNodeDisconnected as any).mock.calls;
const up = () => (svc.notifyNodeConnected as any).mock.calls;

async function startConnected() {
  const mgr = new MeshCoreMqttManager('src-ingest', 'Region Feed', CONFIG);
  const starting = mgr.start();
  await vi.advanceTimersByTimeAsync(0);
  const sock = lastSocket();
  sock.emit('connect');
  await starting;
  return { mgr, sock };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('MeshCoreMqttManager: broker-link alerts', () => {
  it('reports a connect with broker wording', async () => {
    await startConnected();
    expect(up()).toEqual([['src-ingest', 'Region Feed', 'broker']]);
    expect(down()).toHaveLength(0);
  });

  it('a drop shorter than the grace is silent; a longer one alerts once', async () => {
    const { sock } = await startConnected();
    sock.emit('close');
    await vi.advanceTimersByTimeAsync(BROKER_LINK_GRACE_MS - 1000);
    sock.emit('connect');
    await vi.advanceTimersByTimeAsync(BROKER_LINK_GRACE_MS * 2);
    expect(down()).toHaveLength(0);

    sock.emit('close');
    await vi.advanceTimersByTimeAsync(BROKER_LINK_GRACE_MS + 1);
    expect(down()).toEqual([['src-ingest', 'Region Feed', 'broker']]);
  });

  it('stop() during an outage clears the timer and never alerts', async () => {
    const { mgr, sock } = await startConnected();
    sock.emit('close');
    await mgr.stop();
    await vi.advanceTimersByTimeAsync(BROKER_LINK_GRACE_MS * 3);
    expect(down()).toHaveLength(0);
  });

  it('restart() (what a settings save does) is silent', async () => {
    const { mgr, sock } = await startConnected();
    sock.emit('close');
    const restarting = mgr.restart();
    await vi.advanceTimersByTimeAsync(0);
    lastSocket().emit('connect');
    await restarting;
    await vi.advanceTimersByTimeAsync(BROKER_LINK_GRACE_MS * 3);
    expect(down()).toHaveLength(0);
  });

  it('a rejected-login stop alerts at once, without waiting for the grace', async () => {
    const { sock } = await startConnected();
    for (let i = 0; i < INGEST_MAX_AUTH_FAILURES; i++) {
      sock.emit('error', Object.assign(new Error('Connection refused: Bad username or password'), { code: 4 }));
      sock.emit('close');
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(down()).toEqual([['src-ingest', 'Region Feed', 'broker']]);
    // The grace timer from the closes was cleared: still one alert later.
    await vi.advanceTimersByTimeAsync(BROKER_LINK_GRACE_MS * 3);
    expect(down()).toHaveLength(1);
  });
});
