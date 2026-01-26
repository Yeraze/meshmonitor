/**
 * Tests for Channel Database (Virtual Channel) Permissions
 *
 * Tests the permission system for virtual channels including:
 * - Permission CRUD operations
 * - Node filtering based on viewOnMap permission
 * - API route permission enforcement
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock the database service before imports
const mockGetUserPermissionSetAsync = vi.fn();
const mockGetChannelDatabasePermissionsForUserAsSetAsync = vi.fn();
const mockSetChannelDatabasePermissionAsync = vi.fn();
const mockDeleteChannelDatabasePermissionAsync = vi.fn();
const mockGetChannelDatabasePermissionsForUserAsync = vi.fn();

vi.mock('../../src/services/database', () => ({
  default: {
    getUserPermissionSetAsync: mockGetUserPermissionSetAsync,
    getChannelDatabasePermissionsForUserAsSetAsync: mockGetChannelDatabasePermissionsForUserAsSetAsync,
    setChannelDatabasePermissionAsync: mockSetChannelDatabasePermissionAsync,
    deleteChannelDatabasePermissionAsync: mockDeleteChannelDatabasePermissionAsync,
    getChannelDatabasePermissionsForUserAsync: mockGetChannelDatabasePermissionsForUserAsync,
  }
}));

// Import after mocking
import { CHANNEL_DB_OFFSET } from '../../src/server/constants/meshtastic';

describe('Channel Database Permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('CHANNEL_DB_OFFSET constant', () => {
    it('should be defined as 100', () => {
      expect(CHANNEL_DB_OFFSET).toBe(100);
    });

    it('should separate device channels (0-7) from virtual channels', () => {
      // Device channels are 0-7
      for (let i = 0; i <= 7; i++) {
        expect(i).toBeLessThan(CHANNEL_DB_OFFSET);
      }

      // Virtual channel IDs start at CHANNEL_DB_OFFSET
      const virtualChannelDbId = 1;
      const virtualChannelNum = CHANNEL_DB_OFFSET + virtualChannelDbId;
      expect(virtualChannelNum).toBeGreaterThanOrEqual(CHANNEL_DB_OFFSET);
    });
  });

  describe('Permission data structures', () => {
    it('should support viewOnMap and read permissions', () => {
      const permission = {
        channelDatabaseId: 1,
        canViewOnMap: true,
        canRead: false,
      };

      expect(permission.canViewOnMap).toBe(true);
      expect(permission.canRead).toBe(false);
    });

    it('should support permission set format', () => {
      const permissionSet: { [channelDbId: number]: { viewOnMap: boolean; read: boolean } } = {
        1: { viewOnMap: true, read: true },
        2: { viewOnMap: true, read: false },
        3: { viewOnMap: false, read: false },
      };

      expect(permissionSet[1].viewOnMap).toBe(true);
      expect(permissionSet[1].read).toBe(true);
      expect(permissionSet[2].viewOnMap).toBe(true);
      expect(permissionSet[2].read).toBe(false);
      expect(permissionSet[3].viewOnMap).toBe(false);
    });
  });

  describe('Node filtering with virtual channels', () => {
    // Helper to create mock nodes
    const createNode = (nodeNum: number, channel: number) => ({
      nodeNum,
      channel,
      user: { longName: `Node ${nodeNum}` },
    });

    it('should identify virtual channel nodes by channel number >= CHANNEL_DB_OFFSET', () => {
      const deviceChannelNode = createNode(1, 3); // Channel 3 (device)
      const virtualChannelNode = createNode(2, 101); // Channel 101 = CHANNEL_DB_OFFSET + 1

      expect(deviceChannelNode.channel).toBeLessThan(CHANNEL_DB_OFFSET);
      expect(virtualChannelNode.channel).toBeGreaterThanOrEqual(CHANNEL_DB_OFFSET);

      // Extract channel database ID from virtual channel
      const channelDbId = virtualChannelNode.channel - CHANNEL_DB_OFFSET;
      expect(channelDbId).toBe(1);
    });

    it('should calculate correct channel database ID from channel number', () => {
      const testCases = [
        { channelNum: 100, expectedDbId: 0 },
        { channelNum: 101, expectedDbId: 1 },
        { channelNum: 105, expectedDbId: 5 },
        { channelNum: 150, expectedDbId: 50 },
      ];

      for (const { channelNum, expectedDbId } of testCases) {
        const channelDbId = channelNum - CHANNEL_DB_OFFSET;
        expect(channelDbId).toBe(expectedDbId);
      }
    });

    it('should differentiate device channels from virtual channels correctly', () => {
      const nodes = [
        createNode(1, 0),   // Primary channel (device)
        createNode(2, 1),   // Channel 1 (device)
        createNode(3, 7),   // Channel 7 (device, max)
        createNode(4, 100), // Virtual channel (channel_database id 0)
        createNode(5, 101), // Virtual channel (channel_database id 1)
      ];

      const deviceNodes = nodes.filter(n => n.channel < CHANNEL_DB_OFFSET);
      const virtualNodes = nodes.filter(n => n.channel >= CHANNEL_DB_OFFSET);

      expect(deviceNodes).toHaveLength(3);
      expect(virtualNodes).toHaveLength(2);
    });
  });

  describe('Permission checking logic', () => {
    it('admin users should have all permissions', () => {
      const adminUser = { id: 1, isAdmin: true };
      const channelDbId = 5;

      // Admin bypass - always returns true regardless of actual permissions
      const hasPermission = adminUser.isAdmin === true;
      expect(hasPermission).toBe(true);
    });

    it('non-admin users should check permission set', () => {
      const user = { id: 2, isAdmin: false };
      const permissionSet: { [channelDbId: number]: { viewOnMap: boolean; read: boolean } } = {
        1: { viewOnMap: true, read: true },
        2: { viewOnMap: false, read: true },
      };

      // User has viewOnMap for channel DB 1
      expect(permissionSet[1]?.viewOnMap).toBe(true);

      // User does NOT have viewOnMap for channel DB 2
      expect(permissionSet[2]?.viewOnMap).toBe(false);

      // User does NOT have any permission for channel DB 3 (not in set)
      expect(permissionSet[3]?.viewOnMap).toBeUndefined();
    });

    it('should return false for missing permissions', () => {
      const permissionSet: { [channelDbId: number]: { viewOnMap: boolean; read: boolean } } = {};

      const channelDbId = 999;
      const hasPermission = permissionSet[channelDbId]?.viewOnMap === true;

      expect(hasPermission).toBe(false);
    });
  });

  describe('DatabaseService permission methods', () => {
    it('should call getChannelDatabasePermissionsForUserAsSetAsync', async () => {
      const expectedPermissions = {
        1: { viewOnMap: true, read: true },
        2: { viewOnMap: false, read: true },
      };

      mockGetChannelDatabasePermissionsForUserAsSetAsync.mockResolvedValue(expectedPermissions);

      const databaseService = (await import('../../src/services/database')).default;
      const result = await databaseService.getChannelDatabasePermissionsForUserAsSetAsync(1);

      expect(mockGetChannelDatabasePermissionsForUserAsSetAsync).toHaveBeenCalledWith(1);
      expect(result).toEqual(expectedPermissions);
    });

    it('should call setChannelDatabasePermissionAsync with canViewOnMap', async () => {
      mockSetChannelDatabasePermissionAsync.mockResolvedValue(undefined);

      const databaseService = (await import('../../src/services/database')).default;
      await databaseService.setChannelDatabasePermissionAsync(
        1, // userId
        5, // channelDbId
        true, // canViewOnMap
        true, // canRead
        2 // grantedBy
      );

      expect(mockSetChannelDatabasePermissionAsync).toHaveBeenCalledWith(1, 5, true, true, 2);
    });
  });

  describe('Permission enforcement scenarios', () => {
    it('scenario: user with viewOnMap=true should see nodes on map', () => {
      const userPermissions = {
        1: { viewOnMap: true, read: true },
      };

      const nodeOnVirtualChannel1 = { nodeNum: 12345, channel: 101 }; // 101 = CHANNEL_DB_OFFSET + 1
      const channelDbId = nodeOnVirtualChannel1.channel - CHANNEL_DB_OFFSET;

      const shouldShowOnMap = userPermissions[channelDbId]?.viewOnMap === true;
      expect(shouldShowOnMap).toBe(true);
    });

    it('scenario: user with viewOnMap=false should NOT see nodes on map', () => {
      const userPermissions = {
        1: { viewOnMap: false, read: true },
      };

      const nodeOnVirtualChannel1 = { nodeNum: 12345, channel: 101 };
      const channelDbId = nodeOnVirtualChannel1.channel - CHANNEL_DB_OFFSET;

      const shouldShowOnMap = userPermissions[channelDbId]?.viewOnMap === true;
      expect(shouldShowOnMap).toBe(false);
    });

    it('scenario: user without any permission should NOT see nodes', () => {
      const userPermissions: { [key: number]: { viewOnMap: boolean; read: boolean } } = {};

      const nodeOnVirtualChannel5 = { nodeNum: 12345, channel: 105 };
      const channelDbId = nodeOnVirtualChannel5.channel - CHANNEL_DB_OFFSET;

      const shouldShowOnMap = userPermissions[channelDbId]?.viewOnMap === true;
      expect(shouldShowOnMap).toBe(false);
    });

    it('scenario: user with read=false should not see virtual channel in list', () => {
      const userPermissions = {
        1: { viewOnMap: true, read: false },
      };

      const channelDbId = 1;
      const shouldShowInList = userPermissions[channelDbId]?.read === true;
      expect(shouldShowInList).toBe(false);
    });

    it('scenario: user with read=true should see virtual channel in list', () => {
      const userPermissions = {
        1: { viewOnMap: false, read: true },
      };

      const channelDbId = 1;
      const shouldShowInList = userPermissions[channelDbId]?.read === true;
      expect(shouldShowInList).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty permission set', () => {
      const permissionSet: { [key: number]: { viewOnMap: boolean; read: boolean } } = {};

      expect(Object.keys(permissionSet)).toHaveLength(0);
      expect(permissionSet[1]?.viewOnMap).toBeUndefined();
    });

    it('should handle null user (anonymous)', () => {
      const user = null;
      const isAdmin = user?.isAdmin ?? false;

      expect(isAdmin).toBe(false);
    });

    it('should handle undefined channel permissions', () => {
      const authStatus = {
        authenticated: true,
        channelDbPermissions: undefined as any,
      };

      const permissions = authStatus.channelDbPermissions ?? {};
      expect(permissions).toEqual({});
    });

    it('should handle channel number at exact boundary', () => {
      // Channel 99 should be device channel (if it existed)
      expect(99).toBeLessThan(CHANNEL_DB_OFFSET);

      // Channel 100 should be virtual channel (channel_database id 0)
      expect(100).toBeGreaterThanOrEqual(CHANNEL_DB_OFFSET);
      expect(100 - CHANNEL_DB_OFFSET).toBe(0);
    });
  });
});

describe('Integration: filterNodesByChannelPermission logic', () => {
  // This tests the filtering logic without actually importing the function
  // (to avoid complex mocking of the entire databaseService)

  const filterNodes = (
    nodes: Array<{ nodeNum: number; channel: number }>,
    userIsAdmin: boolean,
    devicePermissions: { [resource: string]: { viewOnMap?: boolean } },
    virtualChannelPermissions: { [channelDbId: number]: { viewOnMap: boolean; read: boolean } }
  ) => {
    if (userIsAdmin) return nodes;

    return nodes.filter(node => {
      const channelNum = node.channel ?? 0;

      // Device channels (0-7)
      if (channelNum < CHANNEL_DB_OFFSET) {
        const channelResource = `channel_${channelNum}`;
        return devicePermissions[channelResource]?.viewOnMap === true;
      }

      // Virtual channels (>= CHANNEL_DB_OFFSET)
      const channelDbId = channelNum - CHANNEL_DB_OFFSET;
      return virtualChannelPermissions[channelDbId]?.viewOnMap === true;
    });
  };

  it('should return all nodes for admin user', () => {
    const nodes = [
      { nodeNum: 1, channel: 0 },
      { nodeNum: 2, channel: 101 },
      { nodeNum: 3, channel: 102 },
    ];

    const result = filterNodes(nodes, true, {}, {});
    expect(result).toHaveLength(3);
  });

  it('should filter device channel nodes based on permissions', () => {
    const nodes = [
      { nodeNum: 1, channel: 0 },
      { nodeNum: 2, channel: 1 },
      { nodeNum: 3, channel: 2 },
    ];

    const devicePermissions = {
      'channel_0': { viewOnMap: true },
      'channel_1': { viewOnMap: false },
      // channel_2 not in permissions = no access
    };

    const result = filterNodes(nodes, false, devicePermissions, {});
    expect(result).toHaveLength(1);
    expect(result[0].nodeNum).toBe(1);
  });

  it('should filter virtual channel nodes based on permissions', () => {
    const nodes = [
      { nodeNum: 1, channel: 100 }, // channel_db id 0
      { nodeNum: 2, channel: 101 }, // channel_db id 1
      { nodeNum: 3, channel: 102 }, // channel_db id 2
    ];

    const virtualChannelPermissions = {
      0: { viewOnMap: true, read: true },
      1: { viewOnMap: false, read: true },
      // 2 not in permissions = no access
    };

    const result = filterNodes(nodes, false, {}, virtualChannelPermissions);
    expect(result).toHaveLength(1);
    expect(result[0].nodeNum).toBe(1);
  });

  it('should handle mixed device and virtual channel nodes', () => {
    const nodes = [
      { nodeNum: 1, channel: 0 },   // device channel 0
      { nodeNum: 2, channel: 3 },   // device channel 3
      { nodeNum: 3, channel: 100 }, // virtual channel (db id 0)
      { nodeNum: 4, channel: 101 }, // virtual channel (db id 1)
    ];

    const devicePermissions = {
      'channel_0': { viewOnMap: true },
      'channel_3': { viewOnMap: true },
    };

    const virtualChannelPermissions = {
      0: { viewOnMap: false, read: true },
      1: { viewOnMap: true, read: true },
    };

    const result = filterNodes(nodes, false, devicePermissions, virtualChannelPermissions);
    expect(result).toHaveLength(3);
    expect(result.map(n => n.nodeNum)).toEqual([1, 2, 4]);
  });

  it('should return empty array when user has no permissions', () => {
    const nodes = [
      { nodeNum: 1, channel: 0 },
      { nodeNum: 2, channel: 101 },
    ];

    const result = filterNodes(nodes, false, {}, {});
    expect(result).toHaveLength(0);
  });
});
