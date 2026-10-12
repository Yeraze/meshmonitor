import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub the TCP transport so constructing a manager never touches a real socket
vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

// Prevent the constructor's async position-recalc path from touching the DB
vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    recordTracerouteRequestAsync: vi.fn().mockResolvedValue(undefined),
  };
  return { default: shared, databaseService: shared };
});

// Mock protobufService — auto-stub any method via a Proxy so the constructor
// never crashes on an unmocked call; override decodeAdminMessage per test.
const { decodeAdminMessageMock } = vi.hoisted(() => ({
  decodeAdminMessageMock: vi.fn(),
}));
vi.mock('./protobufService.js', () => {
  const base: any = {
    decodeAdminMessage: decodeAdminMessageMock,
    createGetModuleConfigRequest: vi.fn(() => new Uint8Array()),
    createAdminPacket: vi.fn(() => new Uint8Array()),
  };
  const proxy = new Proxy(base, {
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = vi.fn();
      return target[prop];
    },
  });
  return { default: proxy, convertIpv4ConfigToStrings: vi.fn((x: any) => x) };
});

import { MeshtasticManager } from './meshtasticManager.js';

const LOCAL_NODE_NUM = 123;

function makeManager() {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = {
    nodeNum: LOCAL_NODE_NUM,
    nodeId: '!0000007b',
    firmwareVersion: '2.7.24',
  };
  return mgr;
}

/**
 * readLocalModuleConfig (#5745): ask the local node for one module config and
 * wait for its answer. The Status Message save uses it to confirm the node
 * took a write.
 */
describe('MeshtasticManager — readLocalModuleConfig (#5745)', () => {
  const STATUSMESSAGE = 13;
  const waiters = (mgr: MeshtasticManager): Map<string, unknown[]> => (mgr as any).localModuleConfigWaiters;

  beforeEach(() => {
    decodeAdminMessageMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Deliver a getModuleConfigResponse as if the device had answered. */
  async function deviceAnswers(mgr: MeshtasticManager, response: unknown, from = LOCAL_NODE_NUM) {
    decodeAdminMessageMock.mockReturnValue({ getModuleConfigResponse: response });
    await (mgr as any).processAdminMessage(new Uint8Array([1]), { from });
  }

  it('asks for the module and resolves with the section the node returned', async () => {
    const mgr = makeManager();
    const request = vi.spyOn(mgr, 'requestModuleConfig').mockResolvedValue(undefined);
    (mgr as any).actualModuleConfig = { statusmessage: { nodeStatus: 'old' }, mqtt: { enabled: true } };

    const pending = mgr.readLocalModuleConfig(STATUSMESSAGE, 1000);
    await Promise.resolve();
    await deviceAnswers(mgr, { statusmessage: { nodeStatus: 'Monitoring' } }, 0); // `from` 0 is local too

    await expect(pending).resolves.toEqual({ nodeStatus: 'Monitoring' });
    expect(request).toHaveBeenCalledWith(STATUSMESSAGE);
    expect((mgr as any).actualModuleConfig).toEqual({
      statusmessage: { nodeStatus: 'Monitoring' },
      mqtt: { enabled: true },
    });
    expect(waiters(mgr).size).toBe(0);
  });

  it('resolves {} for an all-default (empty) answer, even with an older value cached', async () => {
    const mgr = makeManager();
    // Not mocked: the real request records the pending key the empty answer is filed under.
    (mgr as any).transport = { send: vi.fn().mockResolvedValue(undefined), isConnected: () => true };
    vi.spyOn(mgr, 'isTransportReady').mockReturnValue(true);
    vi.spyOn(mgr, 'sendLocalAdminPacket').mockResolvedValue(undefined as never);
    (mgr as any).actualModuleConfig = { statusmessage: { nodeStatus: 'old' } };

    const pending = mgr.readLocalModuleConfig(STATUSMESSAGE, 1000);
    await vi.waitFor(() => expect(mgr.sendLocalAdminPacket).toHaveBeenCalledTimes(1));
    await deviceAnswers(mgr, {});

    await expect(pending).resolves.toEqual({});
    expect(waiters(mgr).size).toBe(0);
  });

  it('resolves null on timeout, clears its waiter, and leaves the cache alone', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestModuleConfig').mockResolvedValue(undefined);
    const cached = { nodeStatus: 'old' };
    (mgr as any).actualModuleConfig = { statusmessage: cached };

    const pending = mgr.readLocalModuleConfig(STATUSMESSAGE, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(waiters(mgr).get('statusmessage')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1001);

    await expect(pending).resolves.toBeNull();
    expect((mgr as any).actualModuleConfig.statusmessage).toBe(cached);
    expect(waiters(mgr).size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits 5 s by default', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestModuleConfig').mockResolvedValue(undefined);
    let settled = false;
    const pending = mgr.readLocalModuleConfig(STATUSMESSAGE).then((v) => { settled = true; return v; });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toBeNull();
  });

  it('resolves null at once when the request cannot be sent, with no timer left', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestModuleConfig').mockRejectedValue(new Error('Not connected to Meshtastic node'));

    await expect(mgr.readLocalModuleConfig(STATUSMESSAGE, 60_000)).resolves.toBeNull();
    expect(waiters(mgr).size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a disconnect settles the waiter as null and clears its timer', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestModuleConfig').mockResolvedValue(undefined);

    const pending = mgr.readLocalModuleConfig(STATUSMESSAGE, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    const timersWhileWaiting = vi.getTimerCount();
    (mgr as any).cancelLocalModuleConfigWaiters();

    await expect(pending).resolves.toBeNull();
    expect(waiters(mgr).size).toBe(0);
    expect(vi.getTimerCount()).toBe(timersWhileWaiting - 1);
  });

  it('handleDisconnected cancels waiting reads', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('./meshtasticManager.ts', import.meta.url), 'utf8'));
    const handler = source.slice(source.indexOf('private async handleDisconnected()'));
    expect(handler.slice(0, 600)).toContain('this.cancelLocalModuleConfigWaiters();');
  });

  it("a REMOTE node's answer does not wake the waiter", async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestModuleConfig').mockResolvedValue(undefined);

    const pending = mgr.readLocalModuleConfig(STATUSMESSAGE, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await deviceAnswers(mgr, { statusmessage: { nodeStatus: 'theirs' } }, 999);
    await vi.advanceTimersByTimeAsync(1001);

    await expect(pending).resolves.toBeNull();
  });

  it('a local answer for another module does not wake the waiter', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestModuleConfig').mockResolvedValue(undefined);

    const pending = mgr.readLocalModuleConfig(STATUSMESSAGE, 1000);
    await vi.advanceTimersByTimeAsync(0);
    await deviceAnswers(mgr, { mqtt: { enabled: true } });
    await vi.advanceTimersByTimeAsync(1001);

    await expect(pending).resolves.toBeNull();
  });

  it('resolves null for a module type it does not know, without asking', async () => {
    const mgr = makeManager();
    const request = vi.spyOn(mgr, 'requestModuleConfig').mockResolvedValue(undefined);
    await expect(mgr.readLocalModuleConfig(999, 1000)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
