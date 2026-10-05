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

describe('MeshtasticManager — refreshLocalSecurityConfig', () => {
  const STRICT = 2;
  const fresh = { publicKey: Buffer.alloc(32, 1), privateKey: Buffer.alloc(32, 2), packetSignaturePolicy: STRICT };

  beforeEach(() => {
    decodeAdminMessageMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Deliver a getConfigResponse as if the device had answered. */
  async function deviceAnswers(mgr: MeshtasticManager, response: unknown, from = LOCAL_NODE_NUM) {
    decodeAdminMessageMock.mockReturnValue({ getConfigResponse: response });
    await (mgr as any).processAdminMessage(new Uint8Array([1]), { from });
  }

  it('asks the device for SECURITY_CONFIG (7) and resolves with its answer', async () => {
    const mgr = makeManager();
    const requestConfig = vi.spyOn(mgr, 'requestConfig').mockResolvedValue(undefined);

    const pending = mgr.refreshLocalSecurityConfig(1000);
    await Promise.resolve();
    await deviceAnswers(mgr, { security: fresh });

    await expect(pending).resolves.toBe(fresh);
    expect(requestConfig).toHaveBeenCalledWith(7);
    expect((mgr as any).localSecurityConfigWaiters).toHaveLength(0);
  });

  it('replaces the stale cached section, so a policy set from the phone shows up', async () => {
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestConfig').mockResolvedValue(undefined);
    // Cache from connect time: no policy. The phone app then set STRICT.
    (mgr as any).actualDeviceConfig = {
      lora: { hopLimit: 3 },
      security: { publicKey: Buffer.alloc(32, 9), privateKey: Buffer.alloc(32, 9) },
    };

    const pending = mgr.refreshLocalSecurityConfig(1000);
    await Promise.resolve();
    await deviceAnswers(mgr, { security: fresh }, 0); // `from` 0 is local too
    await pending;

    expect((mgr as any).actualDeviceConfig.security).toBe(fresh);
    expect((mgr as any).actualDeviceConfig.lora).toEqual({ hopLimit: 3 });
    expect(mgr.getSecurityKeys().privateKey).toBe(Buffer.alloc(32, 2).toString('base64'));
  });

  it('resolves null on timeout and leaves the cache alone', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestConfig').mockResolvedValue(undefined);
    const cached = { packetSignaturePolicy: 1 };
    (mgr as any).actualDeviceConfig = { security: cached };

    const pending = mgr.refreshLocalSecurityConfig(1000);
    await vi.advanceTimersByTimeAsync(1001);

    await expect(pending).resolves.toBeNull();
    expect((mgr as any).actualDeviceConfig.security).toBe(cached);
    expect((mgr as any).localSecurityConfigWaiters).toHaveLength(0);
  });

  it('resolves null at once when the request cannot be sent', async () => {
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestConfig').mockRejectedValue(new Error('Not connected to Meshtastic node'));

    await expect(mgr.refreshLocalSecurityConfig(60_000)).resolves.toBeNull();
    expect((mgr as any).localSecurityConfigWaiters).toHaveLength(0);
  });

  it('a REMOTE node\'s security answer neither wakes the waiter nor touches the local cache', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestConfig').mockResolvedValue(undefined);
    (mgr as any).actualDeviceConfig = {};

    const pending = mgr.refreshLocalSecurityConfig(1000);
    await vi.advanceTimersByTimeAsync(0);
    await deviceAnswers(mgr, { security: fresh }, 999);
    await vi.advanceTimersByTimeAsync(1001);

    await expect(pending).resolves.toBeNull();
    expect((mgr as any).actualDeviceConfig.security).toBeUndefined();
  });

  it('a local answer for another section does not wake the waiter', async () => {
    vi.useFakeTimers();
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestConfig').mockResolvedValue(undefined);

    const pending = mgr.refreshLocalSecurityConfig(1000);
    await vi.advanceTimersByTimeAsync(0);
    await deviceAnswers(mgr, { lora: { hopLimit: 3 } });
    await vi.advanceTimersByTimeAsync(1001);

    await expect(pending).resolves.toBeNull();
  });

  it('answers every concurrent caller', async () => {
    const mgr = makeManager();
    vi.spyOn(mgr, 'requestConfig').mockResolvedValue(undefined);

    const a = mgr.refreshLocalSecurityConfig(1000);
    const b = mgr.refreshLocalSecurityConfig(1000);
    await Promise.resolve();
    await deviceAnswers(mgr, { security: fresh });

    await expect(Promise.all([a, b])).resolves.toEqual([fresh, fresh]);
  });
});
