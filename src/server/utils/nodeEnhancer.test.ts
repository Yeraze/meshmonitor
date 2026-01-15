import { describe, it, expect, vi } from 'vitest';
import { enhanceNodeForClient } from './nodeEnhancer.js';

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
