import { describe, it, expect, vi } from 'vitest';
import { enhanceNodeForClient, filterNodesByChannelPermission } from './nodeEnhancer.js';

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
