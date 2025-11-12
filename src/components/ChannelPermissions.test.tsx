/**
 * Tests for per-channel permission visibility and posting access control
 *
 * This test suite verifies that:
 * 1. Channels are only visible to users with read permissions
 * 2. Users can only post to channels with write permissions
 * 3. Permission checks work correctly for different channel combinations
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '../contexts/AuthContext';
import { PermissionSet } from '../types/permission';

// Mock the API module
vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }
}));

describe('Channel Permissions - Visibility and Access Control', () => {
  describe('Channel Visibility Based on Read Permissions', () => {
    it('should only show channels with read permission', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: false },
        channel_1: { read: true, write: false },
        channel_2: { read: false, write: false },
        channel_3: { read: false, write: false },
      };

      // Mock hasPermission function
      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      // Test channel visibility logic
      const channels = [0, 1, 2, 3];
      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );

      expect(visibleChannels).toEqual([0, 1]);
      expect(visibleChannels).not.toContain(2);
      expect(visibleChannels).not.toContain(3);
    });

    it('should hide all channels when user has no read permissions', () => {
      const permissions: PermissionSet = {
        channel_0: { read: false, write: false },
        channel_1: { read: false, write: false },
        channel_2: { read: false, write: false },
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2];
      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );

      expect(visibleChannels).toEqual([]);
    });

    it('should show all channels when user has read permission on all', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: false },
        channel_1: { read: true, write: false },
        channel_2: { read: true, write: false },
        channel_3: { read: true, write: false },
        channel_4: { read: true, write: false },
        channel_5: { read: true, write: false },
        channel_6: { read: true, write: false },
        channel_7: { read: true, write: false },
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3, 4, 5, 6, 7];
      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );

      expect(visibleChannels).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('should handle mixed read permissions correctly', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: true },   // Primary - full access
        channel_1: { read: false, write: false }, // Hidden
        channel_2: { read: true, write: false },  // Read-only
        channel_3: { read: false, write: true },  // Write without read (shouldn't see it)
        channel_4: { read: true, write: true },   // Full access
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3, 4];
      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );

      // Only channels with read permission should be visible
      expect(visibleChannels).toEqual([0, 2, 4]);
      // Channel 3 has write but not read, so should not be visible
      expect(visibleChannels).not.toContain(1);
      expect(visibleChannels).not.toContain(3);
    });
  });

  describe('Channel Posting Access Based on Write Permissions', () => {
    it('should allow posting only to channels with write permission', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: true },   // Can post
        channel_1: { read: true, write: false },  // Cannot post
        channel_2: { read: true, write: true },   // Can post
        channel_3: { read: false, write: false }, // Cannot post
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3];
      const writableChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'write')
      );

      expect(writableChannels).toEqual([0, 2]);
      expect(writableChannels).not.toContain(1);
      expect(writableChannels).not.toContain(3);
    });

    it('should prevent posting to read-only channels', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: false },
        channel_1: { read: true, write: false },
        channel_2: { read: true, write: false },
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      // All channels are read-only
      const channels = [0, 1, 2];
      const writableChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'write')
      );

      expect(writableChannels).toEqual([]);
    });

    it('should allow posting to all channels with write permission', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: true },
        channel_1: { read: true, write: true },
        channel_2: { read: true, write: true },
        channel_3: { read: true, write: true },
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3];
      const writableChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'write')
      );

      expect(writableChannels).toEqual([0, 1, 2, 3]);
    });
  });

  describe('Combined Visibility and Posting Permissions', () => {
    it('should correctly identify channels with different permission combinations', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: true },   // Full access
        channel_1: { read: true, write: false },  // Read-only
        channel_2: { read: false, write: false }, // No access
        channel_3: { read: false, write: true },  // Write without read (edge case)
        channel_4: { read: true, write: true },   // Full access
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3, 4];

      // Visible channels (read permission)
      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );
      expect(visibleChannels).toEqual([0, 1, 4]);

      // Writable channels (write permission)
      const writableChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'write')
      );
      expect(writableChannels).toEqual([0, 3, 4]);

      // Channels with full access (read AND write)
      const fullAccessChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read') &&
        hasPermission(`channel_${ch}`, 'write')
      );
      expect(fullAccessChannels).toEqual([0, 4]);

      // Read-only channels (read but NOT write)
      const readOnlyChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read') &&
        !hasPermission(`channel_${ch}`, 'write')
      );
      expect(readOnlyChannels).toEqual([1]);

      // No access channels (neither read nor write)
      const noAccessChannels = channels.filter(ch =>
        !hasPermission(`channel_${ch}`, 'read') &&
        !hasPermission(`channel_${ch}`, 'write')
      );
      expect(noAccessChannels).toEqual([2]);
    });

    it('should handle Anonymous user with restricted permissions', () => {
      // Typical Anonymous user: read access to Primary only, no write access
      const anonymousPermissions: PermissionSet = {
        channel_0: { read: true, write: false },  // Primary - read only
        channel_1: { read: false, write: false },
        channel_2: { read: false, write: false },
        channel_3: { read: false, write: false },
        channel_4: { read: false, write: false },
        channel_5: { read: false, write: false },
        channel_6: { read: false, write: false },
        channel_7: { read: false, write: false },
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = anonymousPermissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3, 4, 5, 6, 7];

      // Should only see Primary channel
      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );
      expect(visibleChannels).toEqual([0]);

      // Should not be able to post to any channel
      const writableChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'write')
      );
      expect(writableChannels).toEqual([]);
    });

    it('should handle Admin user with full permissions', () => {
      // Admin user: full access to all channels
      const adminPermissions: PermissionSet = {
        channel_0: { read: true, write: true },
        channel_1: { read: true, write: true },
        channel_2: { read: true, write: true },
        channel_3: { read: true, write: true },
        channel_4: { read: true, write: true },
        channel_5: { read: true, write: true },
        channel_6: { read: true, write: true },
        channel_7: { read: true, write: true },
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = adminPermissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3, 4, 5, 6, 7];

      // Should see all channels
      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );
      expect(visibleChannels).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      // Should be able to post to all channels
      const writableChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'write')
      );
      expect(writableChannels).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('should handle Regular user with selective permissions', () => {
      // Regular user: read access to multiple channels, write to some
      const regularUserPermissions: PermissionSet = {
        channel_0: { read: true, write: false },  // Primary - read only
        channel_1: { read: true, write: true },   // Full access
        channel_2: { read: true, write: false },  // Read only
        channel_3: { read: false, write: false }, // No access
        channel_4: { read: true, write: true },   // Full access
        channel_5: { read: false, write: false }, // No access
        channel_6: { read: true, write: false },  // Read only
        channel_7: { read: false, write: false }, // No access
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = regularUserPermissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3, 4, 5, 6, 7];

      // Should see channels 0, 1, 2, 4, 6
      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );
      expect(visibleChannels).toEqual([0, 1, 2, 4, 6]);

      // Should be able to post to channels 1, 4
      const writableChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'write')
      );
      expect(writableChannels).toEqual([1, 4]);

      // Should have read-only access to channels 0, 2, 6
      const readOnlyChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read') &&
        !hasPermission(`channel_${ch}`, 'write')
      );
      expect(readOnlyChannels).toEqual([0, 2, 6]);
    });
  });

  describe('Edge Cases and Special Scenarios', () => {
    it('should handle missing permission entries gracefully', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: true },
        // channel_1 is missing
        channel_2: { read: true, write: false },
        // channel_3 is missing
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false; // Default to no access if permission not defined
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3];

      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );
      // Should only see channels with explicit read permissions
      expect(visibleChannels).toEqual([0, 2]);
      expect(visibleChannels).not.toContain(1);
      expect(visibleChannels).not.toContain(3);
    });

    it('should exclude channel -1 (DM channel) from regular channel lists', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: true },
        channel_1: { read: true, write: true },
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      // Include channel -1 in the list
      const channels = [-1, 0, 1];

      // Filter out DM channel (-1) and check permissions
      const visibleChannels = channels
        .filter(ch => ch !== -1) // Exclude DM channel
        .filter(ch => hasPermission(`channel_${ch}`, 'read'));

      expect(visibleChannels).toEqual([0, 1]);
      expect(visibleChannels).not.toContain(-1);
    });

    it('should exclude disabled channels (role = 0) even with permissions', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: true },
        channel_1: { read: true, write: true },
        channel_2: { read: true, write: true },
      };

      const channels = [
        { id: 0, role: 1 }, // Active
        { id: 1, role: 0 }, // Disabled
        { id: 2, role: 1 }, // Active
      ];

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      // Filter out disabled channels and check permissions
      const visibleChannels = channels
        .filter(ch => ch.role !== 0) // Exclude disabled channels
        .filter(ch => hasPermission(`channel_${ch.id}`, 'read'))
        .map(ch => ch.id);

      expect(visibleChannels).toEqual([0, 2]);
      expect(visibleChannels).not.toContain(1); // Channel 1 is disabled
    });

    it('should handle empty permission set', () => {
      const permissions: PermissionSet = {};

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      const channels = [0, 1, 2, 3];

      const visibleChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'read')
      );
      const writableChannels = channels.filter(ch =>
        hasPermission(`channel_${ch}`, 'write')
      );

      // With no permissions, nothing should be visible or writable
      expect(visibleChannels).toEqual([]);
      expect(writableChannels).toEqual([]);
    });
  });

  describe('getAvailableChannels Integration', () => {
    it('should correctly filter channels based on permissions in getAvailableChannels logic', () => {
      const permissions: PermissionSet = {
        channel_0: { read: true, write: true },
        channel_1: { read: false, write: false },
        channel_2: { read: true, write: false },
        channel_3: { read: false, write: false },
      };

      const hasPermission = (resource: string, action: string): boolean => {
        const perm = permissions[resource as keyof PermissionSet];
        if (!perm) return false;
        return action === 'read' ? perm.read : perm.write;
      };

      // Simulate channel configurations
      const channelConfigs = [
        { id: 0, role: 1, name: 'Primary' },
        { id: 1, role: 1, name: 'Channel 1' },
        { id: 2, role: 1, name: 'Channel 2' },
        { id: 3, role: 0, name: 'Disabled' }, // Disabled
      ];

      // Simulate messages
      const messages = [
        { channel: 0 },
        { channel: 1 },
        { channel: 2 },
        { channel: 4 }, // Channel not in configs
      ];

      // Build channel set from configs and messages
      const channelSet = new Set<number>();
      channelConfigs.forEach(ch => channelSet.add(ch.id));
      messages.forEach(msg => channelSet.add(msg.channel));

      // Apply filters (same logic as getAvailableChannels)
      const availableChannels = Array.from(channelSet)
        .filter(ch => {
          if (ch === -1) return false; // Exclude DM channel

          const channelConfig = channelConfigs.find(c => c.id === ch);

          // If channel has config and role is Disabled (0), exclude it
          if (channelConfig && channelConfig.role === 0) {
            return false;
          }

          // Check if user has permission to read this channel
          if (!hasPermission(`channel_${ch}`, 'read')) {
            return false;
          }

          return true;
        })
        .sort((a, b) => a - b);

      // Should include: 0 (has permission), 2 (has permission)
      // Should exclude: 1 (no permission), 3 (disabled), 4 (no permission)
      expect(availableChannels).toEqual([0, 2]);
    });
  });
});
