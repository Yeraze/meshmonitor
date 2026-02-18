import { describe, it, expect } from 'vitest';
import { getEffectivePosition, getRoleName, getHardwareModelName, getNodeName, getNodeShortName, hasValidEffectivePosition, isNodeComplete } from './nodeHelpers';
import { ROLE_NAMES, HARDWARE_MODELS } from '../constants/index.js';
import type { DeviceInfo } from '../types/device';

describe('Node Helpers', () => {
  describe('getRoleName', () => {
    it('should return correct role names for all valid roles', () => {
      expect(getRoleName(0)).toBe('Client');
      expect(getRoleName(1)).toBe('Client Mute');
      expect(getRoleName(2)).toBe('Router');
      expect(getRoleName(3)).toBe('Router Client');
      expect(getRoleName(4)).toBe('Repeater');
      expect(getRoleName(5)).toBe('Tracker');
      expect(getRoleName(6)).toBe('Sensor');
      expect(getRoleName(7)).toBe('TAK');
      expect(getRoleName(8)).toBe('Client Hidden');
      expect(getRoleName(9)).toBe('Lost and Found');
      expect(getRoleName(10)).toBe('TAK Tracker');
      expect(getRoleName(11)).toBe('Router Late');
      expect(getRoleName(12)).toBe('Client Base');
    });

    it('should handle string role numbers', () => {
      expect(getRoleName('0')).toBe('Client');
      expect(getRoleName('2')).toBe('Router');
      expect(getRoleName('11')).toBe('Router Late');
      expect(getRoleName('12')).toBe('Client Base');
    });

    it('should return Unknown for invalid role numbers', () => {
      expect(getRoleName(99)).toBe('Unknown (99)');
      expect(getRoleName(-1)).toBe('Unknown (-1)');
      expect(getRoleName(13)).toBe('Unknown (13)');
    });

    it('should return null for undefined or null input', () => {
      expect(getRoleName(undefined)).toBeNull();
      expect(getRoleName(null as any)).toBeNull();
    });

    it('should return null for invalid string input', () => {
      expect(getRoleName('invalid')).toBeNull();
      expect(getRoleName('abc')).toBeNull();
    });

    it('should use ROLE_NAMES constant', () => {
      // Verify all roles from constant are tested
      Object.entries(ROLE_NAMES).forEach(([roleNum, roleName]) => {
        expect(getRoleName(parseInt(roleNum))).toBe(roleName);
      });
    });
  });

  describe('getHardwareModelName', () => {
    it('should return formatted hardware model names', () => {
      expect(getHardwareModelName(0)).toBe('Unset');
      expect(getHardwareModelName(1)).toBe('TLora V2');
      expect(getHardwareModelName(4)).toBe('TBeam');
      expect(getHardwareModelName(9)).toBe('RAK4631');
      expect(getHardwareModelName(43)).toBe('Heltec V3');
      expect(getHardwareModelName(255)).toBe('Private HW');
    });

    it('should return null for undefined or null input', () => {
      expect(getHardwareModelName(undefined)).toBeNull();
      expect(getHardwareModelName(null as any)).toBeNull();
    });

    it('should return Unknown for invalid hardware models', () => {
      expect(getHardwareModelName(999)).toBe('Unknown (999)');
      expect(getHardwareModelName(-1)).toBe('Unknown (-1)');
    });

    it('should format hardware names correctly', () => {
      // Verify key formatting patterns
      expect(getHardwareModelName(43)).toBe('Heltec V3'); // Brand capitalization
      expect(getHardwareModelName(50)).toBe('T Deck'); // Space insertion
      expect(getHardwareModelName(12)).toBe('Lilygo TBeam S3 Core'); // Multiple words
    });

    it('should use HARDWARE_MODELS constant', () => {
      // Verify we're using the actual constant
      const hwModel9 = HARDWARE_MODELS[9];
      expect(hwModel9).toBe('RAK4631');
      expect(getHardwareModelName(9)).toBe('RAK4631');
    });
  });

  describe('getNodeName', () => {
    const mockNodes: DeviceInfo[] = [
      {
        nodeNum: 123456789,
        user: {
          id: '!abc12345',
          longName: 'Test Node Alpha',
          shortName: 'TNA',
          hwModel: 9
        }
      },
      {
        nodeNum: 987654321,
        user: {
          id: '!def67890',
          longName: 'Base Station',
          shortName: 'BS',
          hwModel: 43
        }
      }
    ];

    it('should return long name for valid node ID', () => {
      expect(getNodeName(mockNodes, '!abc12345')).toBe('Test Node Alpha');
      expect(getNodeName(mockNodes, '!def67890')).toBe('Base Station');
    });

    it('should return node ID if node not found', () => {
      expect(getNodeName(mockNodes, '!xyz99999')).toBe('!xyz99999');
    });

    it('should return "Unknown" for empty node ID', () => {
      expect(getNodeName(mockNodes, '')).toBe('Unknown');
    });

    it('should handle empty nodes array', () => {
      expect(getNodeName([], '!abc12345')).toBe('!abc12345');
    });

    it('should handle nodes without user data', () => {
      const nodesWithoutUser: DeviceInfo[] = [
        {
          nodeNum: 111111111
        }
      ];
      expect(getNodeName(nodesWithoutUser, '!test1234')).toBe('!test1234');
    });
  });

  describe('getNodeShortName', () => {
    const mockNodes: DeviceInfo[] = [
      {
        nodeNum: 123456789,
        user: {
          id: '!abc12345',
          longName: 'Test Node Alpha',
          shortName: 'TNA',
          hwModel: 9
        }
      },
      {
        nodeNum: 987654321,
        user: {
          id: '!def67890',
          longName: 'Base Station',
          shortName: '  ',  // Empty short name (whitespace only)
          hwModel: 43
        }
      },
      {
        nodeNum: 555555555,
        user: {
          id: '!ghi11111',
          longName: 'Router Node',
          shortName: '',  // No short name
          hwModel: 2
        }
      }
    ];

    it('should return short name if available', () => {
      expect(getNodeShortName(mockNodes, '!abc12345')).toBe('TNA');
    });

    it('should extract last 4 chars from node ID if no short name', () => {
      expect(getNodeShortName(mockNodes, '!def67890')).toBe('7890'); // Whitespace-only short name
      expect(getNodeShortName(mockNodes, '!ghi11111')).toBe('1111'); // Empty short name
    });

    it('should extract last 4 chars for unknown nodes', () => {
      expect(getNodeShortName(mockNodes, '!xyz99999')).toBe('9999');
    });

    it('should handle node IDs shorter than 5 characters', () => {
      expect(getNodeShortName(mockNodes, '!abc')).toBe('!abc');
      expect(getNodeShortName(mockNodes, '!12')).toBe('!12');
    });

    it('should handle empty node ID', () => {
      expect(getNodeShortName(mockNodes, '')).toBe('');
    });

    it('should handle node IDs without ! prefix', () => {
      expect(getNodeShortName(mockNodes, 'abcd1234')).toBe('abcd1234');
    });

    it('should handle empty nodes array', () => {
      expect(getNodeShortName([], '!test1234')).toBe('1234');
    });

    it('should trim whitespace from short names', () => {
      const nodesWithWhitespace: DeviceInfo[] = [
        {
          nodeNum: 111111111,
          user: {
            id: '!test1234',
            longName: 'Test',
            shortName: '  ABC  ',
            hwModel: 1
          }
        }
      ];
      expect(getNodeShortName(nodesWithWhitespace, '!test1234')).toBe('ABC');
    });
  });

  describe('ROLE_NAMES constant completeness', () => {
    it('should have all 13 roles defined (0-12)', () => {
      expect(Object.keys(ROLE_NAMES).length).toBe(13);

      // Verify all expected roles are present
      for (let i = 0; i <= 12; i++) {
        expect(ROLE_NAMES).toHaveProperty(i.toString());
        expect(typeof ROLE_NAMES[i]).toBe('string');
        expect(ROLE_NAMES[i].length).toBeGreaterThan(0);
      }
    });

    it('should have correct role names for new roles', () => {
      expect(ROLE_NAMES[11]).toBe('Router Late');
      expect(ROLE_NAMES[12]).toBe('Client Base');
    });

    it('should not have gaps in role numbers', () => {
      const roleNumbers = Object.keys(ROLE_NAMES).map(Number).sort((a, b) => a - b);
      for (let i = 0; i < roleNumbers.length; i++) {
        expect(roleNumbers[i]).toBe(i);
      }
    });
  });

  describe('isNodeComplete', () => {
    describe('DeviceInfo format (frontend)', () => {
      it('should return true for a complete node with all fields', () => {
        const completeNode: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            longName: 'Test Node Alpha',
            shortName: 'TNA',
            hwModel: 9
          }
        };
        expect(isNodeComplete(completeNode)).toBe(true);
      });

      it('should return false for node with default longName format', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            longName: 'Node !abc12345',
            shortName: 'TNA',
            hwModel: 9
          }
        };
        expect(isNodeComplete(node)).toBe(false);
      });

      it('should return false for node without longName', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            shortName: 'TNA',
            hwModel: 9
          }
        };
        expect(isNodeComplete(node)).toBe(false);
      });

      it('should return false for node without shortName', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            longName: 'Test Node',
            hwModel: 9
          }
        };
        expect(isNodeComplete(node)).toBe(false);
      });

      it('should return false for node with default shortName (last 4 chars of nodeId)', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            longName: 'Test Node',
            shortName: '2345', // Last 4 chars of node ID
            hwModel: 9
          }
        };
        expect(isNodeComplete(node)).toBe(false);
      });

      it('should return false for node without hwModel', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            longName: 'Test Node',
            shortName: 'TNA'
          }
        };
        expect(isNodeComplete(node)).toBe(false);
      });

      it('should return false for node with null hwModel', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            longName: 'Test Node',
            shortName: 'TNA',
            hwModel: null as any
          }
        };
        expect(isNodeComplete(node)).toBe(false);
      });

      it('should return false for node without user object', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789
        };
        expect(isNodeComplete(node)).toBe(false);
      });

      it('should return false for null/undefined node', () => {
        expect(isNodeComplete(null as any)).toBe(false);
        expect(isNodeComplete(undefined as any)).toBe(false);
      });

      it('should return true for hwModel 0 (Unset is still a valid response)', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            longName: 'Test Node',
            shortName: 'TEST',
            hwModel: 0
          }
        };
        expect(isNodeComplete(node)).toBe(true);
      });
    });

    describe('Database node format (backend)', () => {
      it('should return true for a complete database node', () => {
        const dbNode = {
          nodeId: '!abc12345',
          longName: 'Test Node',
          shortName: 'TEST',
          hwModel: 9
        };
        expect(isNodeComplete(dbNode)).toBe(true);
      });

      it('should return false for database node with default longName', () => {
        const dbNode = {
          nodeId: '!abc12345',
          longName: 'Node !abc12345',
          shortName: 'TEST',
          hwModel: 9
        };
        expect(isNodeComplete(dbNode)).toBe(false);
      });

      it('should return false for database node with default shortName', () => {
        const dbNode = {
          nodeId: '!abc12345',
          longName: 'Test Node',
          shortName: '2345', // Default derived from last 4 chars of nodeId
          hwModel: 9
        };
        expect(isNodeComplete(dbNode)).toBe(false);
      });

      it('should return false for database node without hwModel', () => {
        const dbNode = {
          nodeId: '!abc12345',
          longName: 'Test Node',
          shortName: 'TEST'
        };
        expect(isNodeComplete(dbNode)).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle node with empty string longName', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            longName: '',
            shortName: 'TEST',
            hwModel: 9
          }
        };
        expect(isNodeComplete(node)).toBe(false);
      });

      it('should handle node with empty string shortName', () => {
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            id: '!abc12345',
            longName: 'Test Node',
            shortName: '',
            hwModel: 9
          }
        };
        expect(isNodeComplete(node)).toBe(false);
      });

      it('should handle node without nodeId when checking shortName default', () => {
        // If there's no nodeId to compare against, shortName is considered valid
        const node: DeviceInfo = {
          nodeNum: 123456789,
          user: {
            longName: 'Test Node',
            shortName: 'abc1',
            hwModel: 9
          } as any
        };
        expect(isNodeComplete(node)).toBe(true);
      });

      it('should handle broadcast node (special case)', () => {
        // Broadcast node is technically complete if it has proper fields
        const broadcastNode: DeviceInfo = {
          nodeNum: 4294967295,
          user: {
            id: '!ffffffff',
            longName: 'Broadcast',
            shortName: 'BCAST',
            hwModel: 0
          }
        };
        expect(isNodeComplete(broadcastNode)).toBe(true);
      });
    });
  });

  describe('getEffectivePosition', () => {
    it('should return undefined for null or undefined node', () => {
      const result1 = getEffectivePosition(null);
      expect(result1.latitude).toBeUndefined();
      expect(result1.longitude).toBeUndefined();
      expect(result1.altitude).toBeUndefined();

      const result2 = getEffectivePosition(undefined);
      expect(result2.latitude).toBeUndefined();
      expect(result2.longitude).toBeUndefined();
      expect(result2.altitude).toBeUndefined();
    });

    it('should return GPS position when override is disabled', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        position: { latitude: 40.0, longitude: -75.0, altitude: 100 },
        positionOverrideEnabled: false,
        latitudeOverride: 41.0,
        longitudeOverride: -76.0,
        altitudeOverride: 200
      };
      const result = getEffectivePosition(node);
      expect(result.latitude).toBe(40.0);
      expect(result.longitude).toBe(-75.0);
      expect(result.altitude).toBe(100);
    });

    it('should return override position when override is enabled with valid values', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        position: { latitude: 40.0, longitude: -75.0, altitude: 100 },
        positionOverrideEnabled: true,
        latitudeOverride: 41.0,
        longitudeOverride: -76.0,
        altitudeOverride: 200
      };
      const result = getEffectivePosition(node);
      expect(result.latitude).toBe(41.0);
      expect(result.longitude).toBe(-76.0);
      expect(result.altitude).toBe(200);
    });

    it('should return GPS position when override is enabled but override values are null', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        position: { latitude: 40.0, longitude: -75.0, altitude: 100 },
        positionOverrideEnabled: true,
        latitudeOverride: undefined,
        longitudeOverride: undefined
      };
      const result = getEffectivePosition(node);
      expect(result.latitude).toBe(40.0);
      expect(result.longitude).toBe(-75.0);
    });

    it('should return GPS position when override is enabled but only lat is set', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        position: { latitude: 40.0, longitude: -75.0 },
        positionOverrideEnabled: true,
        latitudeOverride: 41.0,
        longitudeOverride: undefined
      };
      const result = getEffectivePosition(node);
      expect(result.latitude).toBe(40.0);
      expect(result.longitude).toBe(-75.0);
    });

    it('should return undefined when no position data exists', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789
      };
      const result = getEffectivePosition(node);
      expect(result.latitude).toBeUndefined();
      expect(result.longitude).toBeUndefined();
    });

    it('should handle node with only position data (no override fields)', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        position: { latitude: 40.0, longitude: -75.0, altitude: 100 }
      };
      const result = getEffectivePosition(node);
      expect(result.latitude).toBe(40.0);
      expect(result.longitude).toBe(-75.0);
      expect(result.altitude).toBe(100);
    });

    it('should return override altitude when override is enabled', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        position: { latitude: 40.0, longitude: -75.0, altitude: 100 },
        positionOverrideEnabled: true,
        latitudeOverride: 41.0,
        longitudeOverride: -76.0,
        altitudeOverride: 500
      };
      const result = getEffectivePosition(node);
      expect(result.altitude).toBe(500);
    });
  });

  describe('hasValidEffectivePosition', () => {
    it('should return true for node with valid GPS position', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        position: { latitude: 40.0, longitude: -75.0 }
      };
      expect(hasValidEffectivePosition(node)).toBe(true);
    });

    it('should return true for node with valid override position', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        positionOverrideEnabled: true,
        latitudeOverride: 41.0,
        longitudeOverride: -76.0
      };
      expect(hasValidEffectivePosition(node)).toBe(true);
    });

    it('should return false for node without any position', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789
      };
      expect(hasValidEffectivePosition(node)).toBe(false);
    });

    it('should return false for node with only latitude', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        position: { latitude: 40.0 } as any
      };
      expect(hasValidEffectivePosition(node)).toBe(false);
    });

    it('should return false for node with enabled override but incomplete coordinates', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        positionOverrideEnabled: true,
        latitudeOverride: 41.0
        // longitude override missing
      };
      expect(hasValidEffectivePosition(node)).toBe(false);
    });

    it('should use GPS position when override is disabled even if override values exist', () => {
      const node: DeviceInfo = {
        nodeNum: 123456789,
        position: { latitude: 40.0, longitude: -75.0 },
        positionOverrideEnabled: false,
        latitudeOverride: 41.0,
        longitudeOverride: -76.0
      };
      expect(hasValidEffectivePosition(node)).toBe(true);
    });
  });
});
