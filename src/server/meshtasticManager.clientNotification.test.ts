import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * FromRadio.ClientNotification handling (firmware 2.8 favorite/ignore cap +
 * general device warnings). Verifies the manager's handleClientNotification:
 *   - reverts the optimistic favorite/ignore flag on a protected-node-cap
 *     refusal, scoped to the manager's own sourceId, and pushes a node update;
 *   - surfaces normal warnings as a client-notification event;
 *   - drops suppressed (recurring/structured) notifications;
 *   - dedupes identical messages within the throttle window.
 */

const { VNConstructor } = vi.hoisted(() => ({
  VNConstructor: vi.fn(function (this: any) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.isRunning = () => true;
    this.getClientCount = () => 0;
  }),
}));
vi.mock('./virtualNodeServer.js', () => ({ VirtualNodeServer: VNConstructor }));

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

const { setNodeFavorite, setNodeIgnoredAsync } = vi.hoisted(() => ({
  setNodeFavorite: vi.fn().mockResolvedValue(undefined),
  setNodeIgnoredAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      getSettingForSource: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      setNodeFavorite,
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    setNodeIgnoredAsync,
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./meshtasticProtobufService.js', () => {
  const svc = {
    getPortNumName: (n: number) => `PORT_${n}`,
    normalizePortNum: (n: any) => (typeof n === 'number' ? n : 0),
    processPayload: vi.fn(),
  };
  return { default: svc, meshtasticProtobufService: svc };
});
vi.mock('./services/packetLogService.js', () => ({
  default: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
  packetLogService: { isEnabled: vi.fn().mockResolvedValue(false), logPacket: vi.fn() },
}));
vi.mock('./services/channelDecryptionService.js', () => ({
  channelDecryptionService: { isEnabled: () => false, tryDecrypt: vi.fn() },
}));

import { MeshtasticManager } from './meshtasticManager.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';

describe('MeshtasticManager — handleClientNotification', () => {
  const SOURCE = 'src-1';
  const NODE = 0xdeadbeef;
  let emitClient: ReturnType<typeof vi.spyOn>;
  let emitNode: ReturnType<typeof vi.spyOn>;

  const seedManager = () => {
    const mgr = new MeshtasticManager(SOURCE, { host: '127.0.0.1', port: 4403 } as any) as any;
    mgr.isConnected = true;
    return mgr;
  };

  beforeEach(() => {
    setNodeFavorite.mockClear();
    setNodeIgnoredAsync.mockClear();
    emitClient = vi.spyOn(dataEventEmitter, 'emitClientNotification').mockImplementation(() => {});
    emitNode = vi.spyOn(dataEventEmitter, 'emitNodeUpdate').mockImplementation(() => {});
  });

  afterEach(() => {
    // dataEventEmitter is a singleton — restore so spy call counts don't leak across tests.
    vi.restoreAllMocks();
  });

  it('reverts the favorite flag on a protected-node-cap refusal, scoped to its source', async () => {
    const mgr = seedManager();

    await mgr.handleClientNotification({
      level: 30,
      message: "Can't favorite 0xdeadbeef: protected-node limit (118) reached",
    });

    expect(setNodeFavorite).toHaveBeenCalledWith(NODE, false, SOURCE);
    expect(setNodeIgnoredAsync).not.toHaveBeenCalled();
    expect(emitNode).toHaveBeenCalledWith(NODE, { isFavorite: false }, SOURCE);
    // The refusal is itself a useful message — still surfaced.
    expect(emitClient).toHaveBeenCalledTimes(1);
  });

  it('reverts the ignore flag on an ignore-cap refusal', async () => {
    const mgr = seedManager();

    await mgr.handleClientNotification({
      level: 30,
      message: "Can't ignore 0xdeadbeef: protected-node limit (118) reached",
    });

    expect(setNodeIgnoredAsync).toHaveBeenCalledWith(NODE, false, SOURCE);
    expect(setNodeFavorite).not.toHaveBeenCalled();
    expect(emitNode).toHaveBeenCalledWith(NODE, { isIgnored: false }, SOURCE);
  });

  it('surfaces a normal device warning without mutating any node', async () => {
    const mgr = seedManager();

    await mgr.handleClientNotification({
      level: 30,
      message: 'Duty cycle limit exceeded. You can send again in 3 mins',
    });

    expect(setNodeFavorite).not.toHaveBeenCalled();
    expect(setNodeIgnoredAsync).not.toHaveBeenCalled();
    expect(emitClient).toHaveBeenCalledTimes(1);
  });

  it('suppresses the recurring power-save "sleeping for N interval" INFO', async () => {
    const mgr = seedManager();

    await mgr.handleClientNotification({
      level: 20,
      message: 'Sending telemetry and sleeping for 900s interval in a moment',
    });

    expect(emitClient).not.toHaveBeenCalled();
  });

  it('dedupes an identical message within the throttle window', async () => {
    const mgr = seedManager();
    const msg = 'Duty cycle limit exceeded. You can send again in 3 mins';

    await mgr.handleClientNotification({ level: 30, message: msg });
    await mgr.handleClientNotification({ level: 30, message: msg });

    expect(emitClient).toHaveBeenCalledTimes(1);
  });
});
