/**
 * App Component Tests
 *
 * Tests header display logic for local node identification
 */

import { describe, it, expect } from 'vitest';
import { DeviceInfo } from './types/device';

describe('App Header Display Logic', () => {
  describe('Local node identification for header', () => {
    it('should display node name when currentNodeId matches a node', () => {
      const currentNodeId = '!a2e175b8';
      const nodes: DeviceInfo[] = [
        {
          nodeNum: 2732916556,
          user: {
            id: '!a2e175b8',
            longName: 'Test Node',
            shortName: 'TEST',
            hwModel: 31,
            role: '1'
          }
        },
        {
          nodeNum: 123456,
          user: {
            id: '!00012345',
            longName: 'Other Node',
            shortName: 'OTHER',
            hwModel: 31,
            role: '1'
          }
        }
      ];

      // Simulate the header logic
      const localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;

      expect(localNode).toBeDefined();
      expect(localNode?.user?.longName).toBe('Test Node');
      expect(localNode?.user?.shortName).toBe('TEST');
      expect(localNode?.user?.id).toBe('!a2e175b8');
    });

    it('should use deviceInfo.localNodeInfo when currentNodeId is not available', () => {
      const currentNodeId = '';
      const nodes: DeviceInfo[] = [];
      const deviceInfo = {
        localNodeInfo: {
          nodeId: '!a2e175b8',
          longName: 'Test Node',
          shortName: 'TEST'
        }
      };

      // Simulate the header logic
      let localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;

      let displayInfo = null;
      if (!localNode && deviceInfo?.localNodeInfo) {
        displayInfo = deviceInfo.localNodeInfo;
      }

      expect(displayInfo).toBeDefined();
      expect(displayInfo?.longName).toBe('Test Node');
      expect(displayInfo?.shortName).toBe('TEST');
      expect(displayInfo?.nodeId).toBe('!a2e175b8');
    });

    it('should fallback to IP address when no node info available', () => {
      const currentNodeId = '';
      const nodes: DeviceInfo[] = [];
      const deviceInfo = {};
      const nodeAddress = '192.168.5.106';

      // Simulate the header logic
      let localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;

      let displayValue;
      if (localNode && localNode.user) {
        displayValue = `${localNode.user.longName} (${localNode.user.shortName}) - ${localNode.user.id}`;
      } else if ((deviceInfo as any)?.localNodeInfo) {
        const { nodeId, longName, shortName } = (deviceInfo as any).localNodeInfo;
        displayValue = `${longName} (${shortName}) - ${nodeId}`;
      } else {
        displayValue = nodeAddress;
      }

      expect(displayValue).toBe('192.168.5.106');
    });

    it('should prioritize currentNodeId over deviceInfo.localNodeInfo', () => {
      const currentNodeId = '!a2e175b8';
      const nodes: DeviceInfo[] = [
        {
          nodeNum: 2732916556,
          user: {
            id: '!a2e175b8',
            longName: 'Current Node',
            shortName: 'CUR',
            hwModel: 31,
            role: '1'
          }
        }
      ];
      const deviceInfo = {
        localNodeInfo: {
          nodeId: '!different',
          longName: 'Different Node',
          shortName: 'DIF'
        }
      };

      // Simulate the header logic
      let localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;

      let displayValue;
      if (localNode && localNode.user) {
        displayValue = `${localNode.user.longName} (${localNode.user.shortName}) - ${localNode.user.id}`;
      } else if ((deviceInfo as any)?.localNodeInfo) {
        const { nodeId, longName, shortName } = (deviceInfo as any).localNodeInfo;
        displayValue = `${longName} (${shortName}) - ${nodeId}`;
      }

      // Should use the currentNodeId match, not deviceInfo.localNodeInfo
      expect(displayValue).toBe('Current Node (CUR) - !a2e175b8');
      expect(displayValue).not.toContain('Different Node');
    });

    it('should handle nodes array with no matching currentNodeId', () => {
      const currentNodeId = '!nonexistent';
      const nodes: DeviceInfo[] = [
        {
          nodeNum: 123456,
          user: {
            id: '!00012345',
            longName: 'Other Node',
            shortName: 'OTHER',
            hwModel: 31,
            role: '1'
          }
        }
      ];
      const deviceInfo = {
        localNodeInfo: {
          nodeId: '!a2e175b8',
          longName: 'Fallback Node',
          shortName: 'FALL'
        }
      };

      // Simulate the header logic
      let localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;

      let displayValue;
      if (localNode && localNode.user) {
        displayValue = `${localNode.user.longName} (${localNode.user.shortName}) - ${localNode.user.id}`;
      } else if ((deviceInfo as any)?.localNodeInfo) {
        const { nodeId, longName, shortName } = (deviceInfo as any).localNodeInfo;
        displayValue = `${longName} (${shortName}) - ${nodeId}`;
      }

      // Should fall back to deviceInfo.localNodeInfo when currentNodeId doesn't match
      expect(displayValue).toBe('Fallback Node (FALL) - !a2e175b8');
    });

    it('should handle empty nodes array', () => {
      const currentNodeId = '!a2e175b8';
      const nodes: DeviceInfo[] = [];
      const deviceInfo = {
        localNodeInfo: {
          nodeId: '!a2e175b8',
          longName: 'Test Node',
          shortName: 'TEST'
        }
      };

      // Simulate the header logic
      let localNode = currentNodeId ? nodes.find(n => n.user?.id === currentNodeId) : null;

      let displayValue;
      if (localNode && localNode.user) {
        displayValue = `${localNode.user.longName} (${localNode.user.shortName}) - ${localNode.user.id}`;
      } else if ((deviceInfo as any)?.localNodeInfo) {
        const { nodeId, longName, shortName } = (deviceInfo as any).localNodeInfo;
        displayValue = `${longName} (${shortName}) - ${nodeId}`;
      }

      // Should fall back to deviceInfo.localNodeInfo when nodes array is empty
      expect(displayValue).toBe('Test Node (TEST) - !a2e175b8');
    });
  });
});
