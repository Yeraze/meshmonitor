import { describe, it, expect, vi } from 'vitest';
import { enhanceNodeForClient, filterNodesByChannelPermission, checkNodeChannelAccess, maskNodeLocationByChannel } from './nodeEnhancer.js';

// Mock the auth middleware
vi.mock('../auth/authMiddleware.js', () => ({
  hasPermission: vi.fn((user, resource, action) => {
    // Basic mock implementation: only 'admin' has nodes_private:read
    if (resource === 'nodes_private' && action === 'read') {
      return user?.username === 'admin';
    }
    return false;
  })
}));

// Mock the database service for filterNodesByChannelPermission
vi.mock('../../services/database.js', () => ({
  default: {
    nodes: {
      getNode: vi.fn(async (nodeNum: number) => {
        // Node 0x00000001 (1) -> channel 0
        if (nodeNum === 1) return { channel: 0 };
        // Node 0x00000002 (2) -> channel 1
        if (nodeNum === 2) return { channel: 1 };
        // Node 0x00000003 (3) -> channel 3 (no permission for user 1)
        if (nodeNum === 3) return { channel: 3 };
        // Node 0x00000004 (4) -> no channel property (defaults to 0)
        if (nodeNum === 4) return {};
        // Unknown node
        return null;
      }),
    },
    getUserPermissionSetAsync: vi.fn(async (userId: number) => {
      // User 1: has access to channels 0 and 1
      if (userId === 1) {
        return {
          channel_0: { viewOnMap: true, read: true, write: false },
          channel_1: { viewOnMap: true, read: true, write: false },
        };
      }
      // User 2: has access to all channels
      if (userId === 2) {
        return {
          channel_0: { viewOnMap: true, read: true, write: true },
          channel_1: { viewOnMap: true, read: true, write: true },
          channel_2: { viewOnMap: true, read: true, write: true },
          channel_3: { viewOnMap: true, read: true, write: true },
          channel_4: { viewOnMap: true, read: true, write: true },
          channel_5: { viewOnMap: true, read: true, write: true },
          channel_6: { viewOnMap: true, read: true, write: true },
          channel_7: { viewOnMap: true, read: true, write: true },
        };
      }
      // Default: no permissions
      return {};
    }),
    getChannelDatabasePermissionsForUserAsSetAsync: vi.fn(async (userId: number) => {
      // User 1: has access to virtual channel 1 (channel_database id 1)
      if (userId === 1) {
        return {
          1: { viewOnMap: true, read: true },
        };
      }
      // User 2: has access to all virtual channels
      if (userId === 2) {
        return {
          1: { viewOnMap: true, read: true },
          2: { viewOnMap: true, read: true },
          3: { viewOnMap: true, read: true },
        };
      }
      // Default: no permissions
      return {};
    }),
  },
}));

describe('nodeEnhancer: enhanceNodeForClient', () => {
  const mockNode = {
    nodeNum: 1,
    user: { id: '!00000001' },
    position: { latitude: 10, longitude: 20 },
    positionOverrideEnabled: true,
    latitudeOverride: 30,
    longitudeOverride: 40,
    positionOverrideIsPrivate: true
  } as any;

  const adminUser = { username: 'admin' };
  const regularUser = { username: 'user1' };
  const anonymousUser = { username: 'anonymous' };

  it('should mask private override for anonymous user', async () => {
    const result = await enhanceNodeForClient(mockNode, anonymousUser);

    // Should NOT use override position
    expect(result.position.latitude).toBe(10);
    expect(result.position.longitude).toBe(20);
    expect(result.positionIsOverride).toBe(false);

    // Sensitive fields should be deleted
    expect(result.latitudeOverride).toBeUndefined();
    expect(result.longitudeOverride).toBeUndefined();
  });

  it('should mask private override for logged-in user without permission', async () => {
    const result = await enhanceNodeForClient(mockNode, regularUser);

    expect(result.position.latitude).toBe(10);
    expect(result.positionIsOverride).toBe(false);
    expect(result.latitudeOverride).toBeUndefined();
  });

  it('should show private override for user with permission', async () => {
    const result = await enhanceNodeForClient(mockNode, adminUser);

    // Should use override position
    expect(result.position.latitude).toBe(30);
    expect(result.position.longitude).toBe(40);
    expect(result.positionIsOverride).toBe(true);

    // Sensitive fields should be PRESERVED
    expect(result.latitudeOverride).toBe(30);
    expect(result.longitudeOverride).toBe(40);
  });

  it('should show public override for everyone', async () => {
    const publicNode = { ...mockNode, positionOverrideIsPrivate: false };

    const anonResult = await enhanceNodeForClient(publicNode, anonymousUser);
    expect(anonResult.position.latitude).toBe(30);
    expect(anonResult.positionIsOverride).toBe(true);

    const userResult = await enhanceNodeForClient(publicNode, regularUser);
    expect(userResult.position.latitude).toBe(30);
  });

  it('should fall back to estimated position if no regular position exists', async () => {
    const nodeWithoutPos = {
      ...mockNode,
      position: null,
      positionOverrideEnabled: false
    };

    const estimatedPositions = new Map();
    estimatedPositions.set('!00000001', { latitude: 50, longitude: 60 });

    const result = await enhanceNodeForClient(nodeWithoutPos, regularUser, estimatedPositions);

    expect(result.position.latitude).toBe(50);
    expect(result.position.longitude).toBe(60);
    expect(result.positionIsOverride).toBe(false);
  });
});

describe('nodeEnhancer: filterNodesByChannelPermission', () => {
  const testNodes = [
    { nodeId: '!00000001', channel: 0 },
    { nodeId: '!00000002', channel: 1 },
    { nodeId: '!00000003', channel: 2 },
    { nodeId: '!00000004', channel: 3 },
    { nodeId: '!00000005' }, // No channel (defaults to 0)
  ];

  it('should return all nodes for admin user', async () => {
    const adminUser = { id: 1, isAdmin: true } as any;
    const result = await filterNodesByChannelPermission(testNodes, adminUser);
    expect(result).toHaveLength(5);
  });

  it('should filter nodes based on channel permissions for regular user', async () => {
    // User 1 has permissions for channels 0 and 1 only
    const regularUser = { id: 1, isAdmin: false } as any;
    const result = await filterNodesByChannelPermission(testNodes, regularUser);

    // Should only see nodes on channel 0 (including the one with no channel) and channel 1
    expect(result).toHaveLength(3);
    expect(result.map(n => n.nodeId)).toContain('!00000001'); // channel 0
    expect(result.map(n => n.nodeId)).toContain('!00000002'); // channel 1
    expect(result.map(n => n.nodeId)).toContain('!00000005'); // no channel, defaults to 0
    expect(result.map(n => n.nodeId)).not.toContain('!00000003'); // channel 2
    expect(result.map(n => n.nodeId)).not.toContain('!00000004'); // channel 3
  });

  it('should return all nodes for user with all channel permissions', async () => {
    // User 2 has permissions for all channels
    const fullAccessUser = { id: 2, isAdmin: false } as any;
    const result = await filterNodesByChannelPermission(testNodes, fullAccessUser);
    expect(result).toHaveLength(5);
  });

  it('should return no nodes for user with no permissions', async () => {
    // User 99 has no permissions (not mocked)
    const noPermUser = { id: 99, isAdmin: false } as any;
    const result = await filterNodesByChannelPermission(testNodes, noPermUser);
    expect(result).toHaveLength(0);
  });

  it('should return no nodes for null user (anonymous without permissions)', async () => {
    const result = await filterNodesByChannelPermission(testNodes, null);
    expect(result).toHaveLength(0);
  });

  it('should return no nodes for undefined user', async () => {
    const result = await filterNodesByChannelPermission(testNodes, undefined);
    expect(result).toHaveLength(0);
  });

  it('should preserve original node type/shape', async () => {
    const adminUser = { id: 1, isAdmin: true } as any;
    const complexNodes = [
      { nodeId: '!00000001', channel: 0, extra: 'data', nested: { value: 1 } },
    ];
    const result = await filterNodesByChannelPermission(complexNodes, adminUser);

    expect(result[0]).toHaveProperty('extra', 'data');
    expect(result[0]).toHaveProperty('nested');
    expect((result[0] as any).nested.value).toBe(1);
  });
});

describe('nodeEnhancer: checkNodeChannelAccess', () => {
  it('should allow admin user access to any node', async () => {
    const adminUser = { id: 1, isAdmin: true } as any;
    expect(await checkNodeChannelAccess('!00000003', adminUser)).toBe(true);
  });

  it('should allow access when user has viewOnMap for the node channel', async () => {
    // User 1 has channel_0 and channel_1 viewOnMap
    const regularUser = { id: 1, isAdmin: false } as any;
    // Node 0x00000001 = nodeNum 1 -> channel 0
    expect(await checkNodeChannelAccess('!00000001', regularUser)).toBe(true);
    // Node 0x00000002 = nodeNum 2 -> channel 1
    expect(await checkNodeChannelAccess('!00000002', regularUser)).toBe(true);
  });

  it('should deny access when user lacks viewOnMap for the node channel', async () => {
    // User 1 has channel_0 and channel_1 only
    const regularUser = { id: 1, isAdmin: false } as any;
    // Node 0x00000003 = nodeNum 3 -> channel 3
    expect(await checkNodeChannelAccess('!00000003', regularUser)).toBe(false);
  });

  it('should default to channel 0 when node has no channel property', async () => {
    // User 1 has channel_0 viewOnMap
    const regularUser = { id: 1, isAdmin: false } as any;
    // Node 0x00000004 = nodeNum 4 -> no channel, defaults to 0
    expect(await checkNodeChannelAccess('!00000004', regularUser)).toBe(true);
  });

  it('should default to channel 0 when node is not found', async () => {
    // User 1 has channel_0 viewOnMap
    const regularUser = { id: 1, isAdmin: false } as any;
    // Node 0x000000ff = 255, not in mock -> getNode returns null, channel defaults to 0
    expect(await checkNodeChannelAccess('!000000ff', regularUser)).toBe(true);
  });

  it('should deny access for null user (anonymous)', async () => {
    expect(await checkNodeChannelAccess('!00000001', null)).toBe(false);
  });

  it('should deny access for undefined user', async () => {
    expect(await checkNodeChannelAccess('!00000001', undefined)).toBe(false);
  });

  it('should deny access for user with no permissions at all', async () => {
    const noPermUser = { id: 99, isAdmin: false } as any;
    expect(await checkNodeChannelAccess('!00000001', noPermUser)).toBe(false);
  });
});

describe('nodeEnhancer: maskNodeLocationByChannel', () => {
  // User 1: channel_0 and channel_1 access; no channel_2 access
  // User 2: all channel access
  // User 99: no access

  it('should return all nodes unchanged for admin', async () => {
    const adminUser = { id: 1, isAdmin: true } as any;
    const nodes = [
      { nodeId: '!00000001', latitude: 10, longitude: 20, positionChannel: 2 },
    ];
    const result = await maskNodeLocationByChannel(nodes, adminUser);
    expect(result[0].latitude).toBe(10);
    expect(result[0].longitude).toBe(20);
    expect((result[0] as any).positionChannel).toBe(2);
  });

  it('should leave node unchanged when positionChannel is accessible', async () => {
    const user = { id: 1, isAdmin: false } as any;
    const nodes = [
      { nodeId: '!00000001', latitude: 10, longitude: 20, altitude: 100, positionChannel: 0 },
    ];
    const result = await maskNodeLocationByChannel(nodes, user);
    expect(result[0].latitude).toBe(10);
    expect(result[0].longitude).toBe(20);
    expect((result[0] as any).altitude).toBe(100);
  });

  it('should strip location fields when positionChannel is inaccessible', async () => {
    // User 1 has no access to channel_2
    const user = { id: 1, isAdmin: false } as any;
    const nodes = [
      {
        nodeId: '!00000001',
        channel: 0,         // node last heard on public channel (accessible)
        latitude: 10,
        longitude: 20,
        altitude: 100,
        positionChannel: 2, // location came from private channel (inaccessible)
        positionTimestamp: 1234567890,
        positionPrecisionBits: 32,
        positionGpsAccuracy: 5,
        positionHdop: 1.2,
      },
    ];
    const result = await maskNodeLocationByChannel(nodes, user);
    expect((result[0] as any).latitude).toBeUndefined();
    expect((result[0] as any).longitude).toBeUndefined();
    expect((result[0] as any).altitude).toBeUndefined();
    expect((result[0] as any).positionChannel).toBeUndefined();
    expect((result[0] as any).positionTimestamp).toBeUndefined();
    expect((result[0] as any).positionPrecisionBits).toBeUndefined();
    expect((result[0] as any).positionGpsAccuracy).toBeUndefined();
    expect((result[0] as any).positionHdop).toBeUndefined();
    // Non-location fields should be preserved
    expect((result[0] as any).nodeId).toBe('!00000001');
    expect((result[0] as any).channel).toBe(0);
  });

  it('should leave node unchanged when positionChannel is not set', async () => {
    const user = { id: 1, isAdmin: false } as any;
    const nodes = [
      { nodeId: '!00000001', latitude: 10, longitude: 20 },
    ];
    const result = await maskNodeLocationByChannel(nodes, user);
    expect(result[0].latitude).toBe(10);
    expect(result[0].longitude).toBe(20);
  });

  it('should strip location for null user when positionChannel is set', async () => {
    const nodes = [
      { nodeId: '!00000001', latitude: 10, longitude: 20, positionChannel: 0 },
    ];
    const result = await maskNodeLocationByChannel(nodes, null);
    expect((result[0] as any).latitude).toBeUndefined();
    expect((result[0] as any).longitude).toBeUndefined();
  });

  it('should handle mixed nodes — mask only those with inaccessible positionChannels', async () => {
    const user = { id: 1, isAdmin: false } as any;
    const nodes = [
      { nodeId: '!node1', latitude: 10, longitude: 20, positionChannel: 0 }, // accessible
      { nodeId: '!node2', latitude: 30, longitude: 40, positionChannel: 2 }, // inaccessible
      { nodeId: '!node3', latitude: 50, longitude: 60 },                     // no positionChannel
    ];
    const result = await maskNodeLocationByChannel(nodes, user);
    expect((result[0] as any).latitude).toBe(10);   // kept
    expect((result[1] as any).latitude).toBeUndefined(); // masked
    expect((result[2] as any).latitude).toBe(50);   // kept (no positionChannel)
  });
});
