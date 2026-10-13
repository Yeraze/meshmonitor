import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSettingForSource: vi.fn(async (s: string, k: string) => store.get(`${s}|${k}`) ?? null),
      setSourceSetting: vi.fn(async (s: string, k: string, v: string) => { store.set(`${s}|${k}`, v); }),
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

vi.mock('./protobufService.js', () => {
  const proxy = new Proxy({} as any, {
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = vi.fn();
      return target[prop];
    },
  });
  return { default: proxy, convertIpv4ConfigToStrings: vi.fn((x: any) => x) };
});

import { MeshtasticManager } from './meshtasticManager.js';

function makeManager(sourceId: string, firmwareVersion = '2.7.24') {
  const mgr = new MeshtasticManager(sourceId, { host: '127.0.0.1', port: 4403 });
  (mgr as any).localNodeInfo = { nodeNum: 123, nodeId: '!0000007b', firmwareVersion };
  const read = vi.spyOn(mgr, 'readLocalModuleConfig');
  const save = vi.spyOn(mgr, 'setGenericModuleConfig').mockResolvedValue(undefined);
  return { mgr, read, save };
}

describe('MeshtasticManager.maybeReapplyStatusMessage (#5745)', () => {
  beforeEach(() => store.clear());

  it('setting off: no write', async () => {
    const { mgr, read, save } = makeManager('s1');
    store.set('s1|statusMessageLastVerified', 'Monitoring');
    await mgr.maybeReapplyStatusMessage();
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('on + empty node + remembered value: exactly one verified save', async () => {
    const { mgr, read, save } = makeManager('s1');
    store.set('s1|statusMessageReapplyAfterReboot', 'true');
    store.set('s1|statusMessageLastVerified', 'Monitoring');
    read.mockResolvedValue({});
    await mgr.maybeReapplyStatusMessage();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('statusmessage', { nodeStatus: 'Monitoring' }, { verify: true });
  });

  it('on + node has a different value: no write, remembered value updated', async () => {
    const { mgr, read, save } = makeManager('s1');
    store.set('s1|statusMessageReapplyAfterReboot', '1');
    store.set('s1|statusMessageLastVerified', 'Monitoring');
    read.mockResolvedValue({ nodeStatus: 'Away' });
    await mgr.maybeReapplyStatusMessage();
    expect(save).not.toHaveBeenCalled();
    expect(store.get('s1|statusMessageLastVerified')).toBe('Away');
  });

  it('a second config load on the same connection makes no second attempt; a new connection may', async () => {
    const { mgr, read, save } = makeManager('s1');
    store.set('s1|statusMessageReapplyAfterReboot', 'true');
    store.set('s1|statusMessageLastVerified', 'Monitoring');
    read.mockResolvedValue({});
    await mgr.maybeReapplyStatusMessage();
    await mgr.maybeReapplyStatusMessage();
    expect(save).toHaveBeenCalledTimes(1);
    // The connect path resets the flag when it registers the per-connection callback.
    (mgr as any).statusReapplyAttempted = false;
    await mgr.maybeReapplyStatusMessage();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('failure: warns, does not throw, does not retry on this connection', async () => {
    const { mgr, read, save } = makeManager('s1');
    store.set('s1|statusMessageReapplyAfterReboot', 'true');
    store.set('s1|statusMessageLastVerified', 'Monitoring');
    read.mockResolvedValue({});
    save.mockRejectedValue(new Error('unverified'));
    await expect(mgr.maybeReapplyStatusMessage()).resolves.toBeUndefined();
    await mgr.maybeReapplyStatusMessage();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('firmware without the module: nothing', async () => {
    const { mgr, read, save } = makeManager('s1', '2.7.19');
    store.set('s1|statusMessageReapplyAfterReboot', 'true');
    store.set('s1|statusMessageLastVerified', 'Monitoring');
    await mgr.maybeReapplyStatusMessage();
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('per source: A\'s setting and memory never drive a write on B', async () => {
    const a = makeManager('A');
    const b = makeManager('B');
    store.set('A|statusMessageReapplyAfterReboot', 'true');
    store.set('A|statusMessageLastVerified', 'Monitoring');
    a.read.mockResolvedValue({});
    b.read.mockResolvedValue({});
    await b.mgr.maybeReapplyStatusMessage();
    expect(b.save).not.toHaveBeenCalled();
    await a.mgr.maybeReapplyStatusMessage();
    expect(a.save).toHaveBeenCalledTimes(1);
  });
});
