/**
 * Tests for bridged-node detection on MeshtasticManager:
 * - isLocalNodeBridged() across capability-flag states
 * - processDeviceMetadata captures hasWifi/hasEthernet/hasBluetooth from
 *   the connected node's DeviceMetadata so detection works
 *
 * A "bridged" node is a serial/BLE-only radio fronted by a TCP proxy
 * (meshtasticd, mesh-bridge, …): it reports no native WiFi and no Ethernet,
 * yet MeshMonitor reaches it over TCP. Such a node cannot serve an OTA HTTP
 * endpoint, so OTA firmware update must be disabled for it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
const mockUpsertNode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: mockSetSetting,
    settings: {
      getSetting: mockGetSetting,
      setSetting: mockSetSetting,
      getSettingForSource: vi.fn((_sourceId: string, key: string) => mockGetSetting(key)),
      setSettingForSource: vi.fn((_sourceId: string, key: string, value: string) => mockSetSetting(key, value)),
    },
    nodes: {
      getAllNodes: vi.fn().mockResolvedValue([]),
      upsertNode: mockUpsertNode,
    },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('MeshtasticManager - bridged node detection', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
    manager.localNodeInfo = {
      nodeNum: 0x11111111,
      nodeId: '!11111111',
      longName: 'Test Local Node',
      shortName: 'TLN',
    };
  });

  describe('isLocalNodeBridged', () => {
    it('returns false when there is no local node info', () => {
      manager.localNodeInfo = null;
      expect(manager.isLocalNodeBridged()).toBe(false);
    });

    it('returns false when capability flags are unknown (no DeviceMetadata yet)', () => {
      // Flags undefined => we have not received DeviceMetadata; do not block OTA.
      expect(manager.isLocalNodeBridged()).toBe(false);
    });

    it('returns true when the node has neither WiFi nor Ethernet', () => {
      manager.localNodeInfo.hasWifi = false;
      manager.localNodeInfo.hasEthernet = false;
      expect(manager.isLocalNodeBridged()).toBe(true);
    });

    it('returns false when the node has native WiFi', () => {
      manager.localNodeInfo.hasWifi = true;
      manager.localNodeInfo.hasEthernet = false;
      expect(manager.isLocalNodeBridged()).toBe(false);
    });

    it('returns false when the node has Ethernet', () => {
      manager.localNodeInfo.hasWifi = false;
      manager.localNodeInfo.hasEthernet = true;
      expect(manager.isLocalNodeBridged()).toBe(false);
    });
  });

  describe('processDeviceMetadata capability capture', () => {
    it('captures flags and flags a WiFi/Ethernet-less node as bridged', async () => {
      await manager.processDeviceMetadata({
        hasWifi: false,
        hasBluetooth: true,
        hasEthernet: false,
      });

      expect(manager.localNodeInfo.hasWifi).toBe(false);
      expect(manager.localNodeInfo.hasEthernet).toBe(false);
      expect(manager.localNodeInfo.hasBluetooth).toBe(true);
      expect(manager.isLocalNodeBridged()).toBe(true);
      // No firmwareVersion in the payload => no DB write on this path.
      expect(mockUpsertNode).not.toHaveBeenCalled();
    });

    it('does not flag a native WiFi node as bridged', async () => {
      await manager.processDeviceMetadata({
        hasWifi: true,
        hasBluetooth: true,
        hasEthernet: false,
      });

      expect(manager.localNodeInfo.hasWifi).toBe(true);
      expect(manager.isLocalNodeBridged()).toBe(false);
    });

    it('coerces missing proto bools to false (treats absent WiFi/Ethernet as bridged)', async () => {
      // protobufjs may omit default-false bools; the manager must coerce them.
      await manager.processDeviceMetadata({ firmwareVersion: '' });

      expect(manager.localNodeInfo.hasWifi).toBe(false);
      expect(manager.localNodeInfo.hasEthernet).toBe(false);
      expect(manager.isLocalNodeBridged()).toBe(true);
    });

    it('does nothing when localNodeInfo is not yet initialised', async () => {
      manager.localNodeInfo = null;
      await expect(
        manager.processDeviceMetadata({ hasWifi: false, hasEthernet: false })
      ).resolves.toBeUndefined();
      expect(manager.isLocalNodeBridged()).toBe(false);
    });
  });
});
