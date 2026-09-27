import { describe, it, expect, vi, beforeEach } from 'vitest';

// #5363: the per-source geofence triggers (Automation → Geofence Triggers)
// judge the sign-flip corrected point when correction is on for the source,
// and the reported point when it is off. Mock setup follows
// meshtasticManager.positionChannel.test.ts.

vi.mock('./virtualNodeServer.js', () => ({
  VirtualNodeServer: vi.fn(function (this: any) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.broadcastToClients = vi.fn().mockResolvedValue(undefined);
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  }),
}));

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

const { getSettingForSourceMock } = vi.hoisted(() => ({ getSettingForSourceMock: vi.fn() }));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSettingForSource: getSettingForSourceMock,
    },
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
  };
  return { default: shared, databaseService: shared };
});

const { ctxHolder } = vi.hoisted(() => ({ ctxHolder: { ctx: null as unknown } }));
vi.mock('./services/signFlipCorrection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/signFlipCorrection.js')>();
  return { ...actual, getCachedSignFlipContext: vi.fn(async () => ctxHolder.ctx) };
});

import { MeshtasticManager } from './meshtasticManager.js';

const TAMPA_FENCE = [{
  id: 'geo-1',
  name: 'Tampa',
  enabled: true,
  shape: { type: 'circle', center: { lat: 27.95, lng: -82.46 }, radiusKm: 50 },
  event: 'entry',
  nodeFilter: { type: 'all' },
  responseType: 'text',
  response: 'hi',
  channel: 0,
}];

function makeManager() {
  const mgr = new MeshtasticManager('src-1', { host: '127.0.0.1', port: 4403 });
  const execute = vi.fn();
  (mgr as any).executeGeofenceTrigger = execute;
  (mgr as any).isGeofenceCooldownActive = () => false;
  return { mgr, execute };
}

describe('MeshtasticManager geofence triggers and sign-flip correction (#5363)', () => {
  beforeEach(() => {
    getSettingForSourceMock.mockReset().mockImplementation(async (_s: string, key: string) =>
      key === 'geofenceTriggers' ? JSON.stringify(TAMPA_FENCE) : null);
  });

  it('fires entry for a flipped node when correction is on, at the corrected point', async () => {
    ctxHolder.ctx = { reference: { latitude: 27.95, longitude: -82.46 }, rangeKm: 500 };
    const { mgr, execute } = makeManager();
    await (mgr as any).checkGeofencesForNode(5, 27.9, 82.5);
    expect(execute).toHaveBeenCalledTimes(1);
    const [, nodeNum, lat, lng, event] = execute.mock.calls[0];
    expect(nodeNum).toBe(5);
    expect(lat).toBeCloseTo(27.9);
    expect(lng).toBeCloseTo(-82.5);
    expect(event).toBe('entry');
  });

  it('does not fire for the same node when correction is off', async () => {
    ctxHolder.ctx = null;
    const { mgr, execute } = makeManager();
    await (mgr as any).checkGeofencesForNode(5, 27.9, 82.5);
    expect(execute).not.toHaveBeenCalled();
  });
});
