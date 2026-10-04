/**
 * MeshCore MQTT ingest — stop after repeated rejected logins (#5596).
 *
 * Before this, an ingest source with a wrong username or password retried the
 * login every ~60 s for as long as the process lived. Now five rejections in a
 * row stop it until the config is saved or someone reconnects it.
 *
 * These run the REAL `MqttBrokerClient` against a fake `mqtt.js`, so the fake
 * plays the broker and the client's own reconnect timers are what is under
 * test — a mocked client would only prove the mock.
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

import { connect } from 'mqtt';
import { logger } from '../utils/logger.js';
import {
  MeshCoreMqttManager,
  INGEST_MAX_AUTH_FAILURES,
  INGEST_AUTH_STOPPED_MESSAGE,
} from './meshcoreMqttManager.js';

const USERNAME = 'ingest-user-name';
const PASSWORD = 'ingest-pass-word';
const CONFIG = {
  brokerUrl: 'wss://broker.example:443',
  region: 'mco',
  username: USERNAME,
  password: PASSWORD,
};

const sockets = () => (connect as any).mock.results.map((r: any) => r.value);
const lastSocket = () => sockets().at(-1);
/** Every attempt the manager has made: one per socket plus its reconnects. */
const attempts = () =>
  sockets().reduce((n: number, s: any) => n + 1 + s.reconnect.mock.calls.length, 0);

/** The broker rejects the login (CONNACK 4), then closes the socket. */
function reject(sock: any) {
  sock.emit('error', Object.assign(new Error('Connection refused: Bad username or password'), { code: 4 }));
  sock.emit('close');
}
function accept(sock: any) {
  sock.emit('connect');
}

/**
 * Start a manager whose first login is answered by `first`. `start()` awaits
 * the first CONNACK or error, so the answer has to be queued before it.
 */
async function startWith(first: 'reject' | 'accept', config = CONFIG) {
  const mgr = new MeshCoreMqttManager('src-ingest', 'Region Feed', config);
  const starting = mgr.start();
  await vi.advanceTimersByTimeAsync(0);
  const sock = lastSocket();
  if (first === 'reject') reject(sock);
  else accept(sock);
  await starting;
  return { mgr, sock };
}

/** Let the client's backoff timer fire the next attempt, then reject it. */
async function nextAttemptRejected(sock: any) {
  await vi.advanceTimersByTimeAsync(70_000); // past the 60 s cap plus jitter
  reject(sock);
}

/** Drive a started-and-once-rejected manager to the stop. */
async function rejectUntilStopped(sock: any) {
  for (let i = 1; i < INGEST_MAX_AUTH_FAILURES; i++) await nextAttemptRejected(sock);
  await vi.advanceTimersByTimeAsync(0);
}

const logText = () =>
  (['info', 'warn', 'error', 'debug'] as const)
    .flatMap((level) => (logger as any)[level].mock.calls)
    .map((call: unknown[]) => call.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    .join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MeshCoreMqttManager — auth stop (#5596)', () => {
  it('stops after 5 rejected logins and makes no 6th attempt', async () => {
    const { mgr, sock } = await startWith('reject');
    expect(mgr.isAuthStopped()).toBe(false);

    await rejectUntilStopped(sock);
    expect(attempts()).toBe(5);
    expect(mgr.isAuthStopped()).toBe(true);

    // A day of fake time: still exactly five attempts, and one socket.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(attempts()).toBe(5);
    expect(sockets()).toHaveLength(1);
  });

  it('closes the rejected socket once, and reports not connected', async () => {
    const { mgr, sock } = await startWith('reject');
    await rejectUntilStopped(sock);

    expect(sock.end).toHaveBeenCalledTimes(1);
    expect(mgr.isConnected()).toBe(false);
  });

  it('a successful connect resets the count', async () => {
    const { mgr, sock } = await startWith('reject');
    for (let i = 0; i < 3; i++) await nextAttemptRejected(sock); // 4 rejections so far

    await vi.advanceTimersByTimeAsync(70_000);
    accept(sock); // the 5th attempt gets in
    expect(mgr.isAuthStopped()).toBe(false);

    // The broker later starts rejecting again: four more are still under the
    // limit, because the count started over.
    sock.emit('close');
    for (let i = 0; i < 4; i++) await nextAttemptRejected(sock);
    expect(mgr.isAuthStopped()).toBe(false);

    await nextAttemptRejected(sock); // the 5th in a row since the success
    expect(mgr.isAuthStopped()).toBe(true);
  });

  it('other errors keep the normal backoff and never stop the source', async () => {
    const { mgr, sock } = await startWith('accept');
    sock.emit('close');

    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(70_000);
      sock.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      sock.emit('close');
    }

    expect(mgr.isAuthStopped()).toBe(false);
    expect(sock.reconnect).toHaveBeenCalledTimes(12);
    // And it is still trying.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(sock.reconnect).toHaveBeenCalledTimes(13);
  });

  it('a manual reconnect clears the stop and tries again from scratch', async () => {
    const { mgr, sock } = await startWith('reject');
    await rejectUntilStopped(sock);
    expect(mgr.isAuthStopped()).toBe(true);

    const restarting = mgr.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets()).toHaveLength(2);
    const fresh = lastSocket();
    accept(fresh);
    await restarting;

    expect(mgr.isAuthStopped()).toBe(false);
    expect(mgr.isConnected()).toBe(true);
    expect(mgr.getStatus().permissionMessage).toBeNull();
    // The old socket stays dead: a late event from it must not re-stop the source.
    reject(sock);
    expect(mgr.isAuthStopped()).toBe(false);
  });

  it('a manual reconnect against a still-wrong password stops again after 5', async () => {
    const { mgr, sock } = await startWith('reject');
    await rejectUntilStopped(sock);

    const restarting = mgr.restart();
    await vi.advanceTimersByTimeAsync(0);
    const fresh = lastSocket();
    reject(fresh);
    await restarting;
    expect(mgr.isAuthStopped()).toBe(false);

    await rejectUntilStopped(fresh);
    expect(mgr.isAuthStopped()).toBe(true);
    expect(attempts()).toBe(10);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(attempts()).toBe(10);
  });

  it('a config change (a new manager) starts clean', async () => {
    const { mgr, sock } = await startWith('reject');
    await rejectUntilStopped(sock);
    expect(mgr.isAuthStopped()).toBe(true);

    // What a config save does: stop the old manager, build one from the new config.
    await mgr.stop();
    const { mgr: next } = await startWith('accept', { ...CONFIG, password: 'the-right-one' });

    expect(next.isAuthStopped()).toBe(false);
    expect(next.isConnected()).toBe(true);
    expect((connect as any).mock.calls.at(-1)[1].password).toBe('the-right-one');
  });

  it('a process restart (a new manager, same config) gets five fresh attempts, then stops', async () => {
    // The count is in memory by design: nothing is persisted, so a restart is
    // a new manager with a zero count.
    const first = await startWith('reject');
    await rejectUntilStopped(first.sock);
    await first.mgr.stop();
    const before = attempts();

    const second = await startWith('reject');
    await rejectUntilStopped(second.sock);

    expect(second.mgr.isAuthStopped()).toBe(true);
    expect(attempts() - before).toBe(5);
  });
});

describe('MeshCoreMqttManager — auth stop in the status payload (#5596)', () => {
  it('reports nothing unusual while connected', async () => {
    const { mgr } = await startWith('accept');
    expect(mgr.getStatus()).toEqual({
      sourceId: 'src-ingest',
      sourceName: 'Region Feed',
      sourceType: 'meshcore_mqtt',
      connected: true,
      authStopped: false,
      permissionMessage: null,
      lastError: null,
    });
  });

  it('does not report a stop while it is still retrying', async () => {
    const { mgr, sock } = await startWith('reject');
    await nextAttemptRejected(sock);

    const status = mgr.getStatus();
    expect(status.connected).toBe(false);
    expect(status.authStopped).toBe(false);
    expect(status.permissionMessage).toBeNull();
  });

  it('says why it stopped, in fixed text', async () => {
    const { mgr, sock } = await startWith('reject');
    await rejectUntilStopped(sock);

    expect(mgr.getStatus()).toEqual({
      sourceId: 'src-ingest',
      sourceName: 'Region Feed',
      sourceType: 'meshcore_mqtt',
      connected: false,
      authStopped: true,
      permissionMessage: INGEST_AUTH_STOPPED_MESSAGE,
      lastError: INGEST_AUTH_STOPPED_MESSAGE,
    });
    expect(INGEST_AUTH_STOPPED_MESSAGE).toMatch(/rejected the login 5 times/);
  });

  it('never leaks the username, password or broker host through status or stats', async () => {
    const { mgr, sock } = await startWith('reject');
    await rejectUntilStopped(sock);

    const exposed = JSON.stringify([mgr.getStatus(), mgr.getIngestStats()]);
    expect(exposed).not.toContain(USERNAME);
    expect(exposed).not.toContain(PASSWORD);
    expect(exposed).not.toContain('broker.example');
  });

  it('never logs the username or password', async () => {
    const { sock } = await startWith('reject');
    await rejectUntilStopped(sock);

    const text = logText();
    expect(text).toContain('rejected the login 5 times in a row');
    expect(text).not.toContain(USERNAME);
    expect(text).not.toContain(PASSWORD);
  });

  it('logs a broker URL with embedded credentials in redacted form only', async () => {
    const { sock } = await startWith('reject', {
      ...CONFIG,
      brokerUrl: 'wss://urluser:urlsecret@broker.example:443',
    });
    await rejectUntilStopped(sock);

    const text = logText();
    expect(text).toContain('wss://***@broker.example:443');
    expect(text).not.toContain('urlsecret');
    expect(text).not.toContain('urluser');
  });
});
