/**
 * Regression tests for the MyNodeInfo / DeviceMetadata race.
 *
 * The firmware sends MyNodeInfo and DeviceMetadata back-to-back in the same
 * config-download burst, and MeshtasticManager processes inbound frames
 * concurrently (packetConcurrencyLimit, default 4). DeviceMetadata could
 * therefore overtake the DB awaits inside processMyNodeInfo() and find
 * localNodeInfo still null.
 *
 * The old handler dropped the payload in that window. Because the DB write
 * lives in the same branch, nodes.firmwareVersion also stayed null, so the next
 * reconnect read the empty column back and the source showed
 * "Firmware Version: Not Available" forever. The capability flags were lost the
 * same way, mis-gating isLocalNodeBridged() and the OTA firmware-update UI.
 *
 * DeviceMetadata is now buffered and drained once local identity is known.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockGetNode = vi.fn();
const mockUpsertNodeAsync = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    upsertNodeAsync: mockUpsertNodeAsync,
    deleteNodeAsync: vi.fn().mockResolvedValue(undefined),
    suppressGhostNodeAsync: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      getSettingForSource: vi.fn((_sourceId: string, key: string) => mockGetSetting(key)),
      setSettingForSource: vi.fn((_sourceId: string, key: string, value: string) => mockSetSetting(key, value)),
    },
    nodes: {
      getNode: mockGetNode,
      getAllNodes: vi.fn().mockResolvedValue([]),
      upsertNode: mockUpsertNodeAsync,
    },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

const LOCAL_NODE_NUM = 0x11111111;
const FIRMWARE = '2.7.11.abcdef';

describe('MeshtasticManager - DeviceMetadata arriving before MyNodeInfo', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockGetNode.mockResolvedValue(null);
    mockUpsertNodeAsync.mockResolvedValue(undefined);

    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    manager.localNodeInfo = null;
    manager.pendingDeviceMetadata = null;
  });

  it('buffers metadata that loses the race and applies it once MyNodeInfo lands', async () => {
    // Hold every settings read so MyNodeInfo is parked inside its DB awaits,
    // exactly where the real race window is.
    let releaseDb!: () => void;
    const dbGate = new Promise<void>((resolve) => { releaseDb = resolve; });
    mockGetSetting.mockImplementation(async () => { await dbGate; return null; });

    const myInfoDone = manager.processMyNodeInfo({ myNodeNum: LOCAL_NODE_NUM, rebootCount: 3 });

    // DeviceMetadata overtakes MyNodeInfo — identity is not established yet.
    await manager.processDeviceMetadata({
      firmwareVersion: FIRMWARE,
      hasWifi: true,
      hasBluetooth: true,
      hasEthernet: false,
    });
    expect(manager.localNodeInfo).toBeNull();
    expect(manager.pendingDeviceMetadata).not.toBeNull();

    releaseDb();
    await myInfoDone;

    expect(manager.localNodeInfo.firmwareVersion).toBe(FIRMWARE);
    expect(manager.localNodeInfo.hasWifi).toBe(true);
    expect(manager.localNodeInfo.hasEthernet).toBe(false);
    expect(manager.isLocalNodeBridged()).toBe(false);
    expect(manager.pendingDeviceMetadata).toBeNull();
  });

  it('persists the buffered firmware version so a reconnect does not read back an empty column', async () => {
    await manager.processDeviceMetadata({ firmwareVersion: FIRMWARE, hasWifi: true });
    expect(mockUpsertNodeAsync).not.toHaveBeenCalled();

    await manager.processMyNodeInfo({ myNodeNum: LOCAL_NODE_NUM, rebootCount: 1 });

    expect(mockUpsertNodeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ nodeNum: LOCAL_NODE_NUM, firmwareVersion: FIRMWARE }),
      expect.anything(),
    );
  });

  it('drains the buffer when MyNodeInfo takes the same-device reboot-merge path', async () => {
    // Same physical device, new nodeNum: processMyNodeInfo returns early from
    // the merge branch, so the drain cannot hang off the normal tail.
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key.includes('localNodeNum')) return String(0x22222222);
      if (key.includes('localNodeId')) return '!22222222';
      if (key.includes('localDeviceId')) return 'aabbccdd';
      return null;
    });
    mockGetNode.mockResolvedValue(null);

    await manager.processDeviceMetadata({ firmwareVersion: FIRMWARE, hasWifi: true });

    await manager.processMyNodeInfo({
      myNodeNum: LOCAL_NODE_NUM,
      rebootCount: 2,
      deviceId: Buffer.from('aabbccdd', 'hex'),
    });

    expect(manager.localNodeInfo.nodeNum).toBe(LOCAL_NODE_NUM);
    expect(manager.localNodeInfo.firmwareVersion).toBe(FIRMWARE);
    expect(manager.pendingDeviceMetadata).toBeNull();
  });

  it('leaves the stored firmware version alone when metadata carries none', async () => {
    manager.localNodeInfo = {
      nodeNum: LOCAL_NODE_NUM,
      nodeId: '!11111111',
      longName: 'Test Local Node',
      shortName: 'TLN',
      firmwareVersion: FIRMWARE,
    };

    await manager.processDeviceMetadata({ hasWifi: false, hasEthernet: false });

    expect(manager.localNodeInfo.firmwareVersion).toBe(FIRMWARE);
    expect(manager.isLocalNodeBridged()).toBe(true);
    expect(mockUpsertNodeAsync).not.toHaveBeenCalled();
  });
});
