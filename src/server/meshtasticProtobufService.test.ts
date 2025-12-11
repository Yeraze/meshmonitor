import { describe, it, expect, beforeAll } from 'vitest';
import { MeshtasticProtobufService } from './meshtasticProtobufService';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader';

describe('MeshtasticProtobufService', () => {
  // Use the singleton instance
  const service = MeshtasticProtobufService.getInstance();

  // Initialize protobuf definitions before running createNodeInfo tests
  beforeAll(async () => {
    await service.initialize();
    // Also load protobufs directly for decoding in tests
    await loadProtobufDefinitions();
  });

  // Helper function to decode FromRadio message
  function decodeFromRadio(data: Uint8Array): any {
    const root = getProtobufRoot();
    if (!root) return null;
    const FromRadio = root.lookupType('meshtastic.FromRadio');
    const decoded = FromRadio.decode(data);
    return FromRadio.toObject(decoded);
  }

  describe('normalizePortNum', () => {
    describe('number inputs', () => {
      it('should return valid number inputs unchanged', () => {
        expect(service.normalizePortNum(70)).toBe(70);
        expect(service.normalizePortNum(6)).toBe(6);
        expect(service.normalizePortNum(1)).toBe(1);
        expect(service.normalizePortNum(0)).toBe(0);
      });

      it('should handle all valid portnum values', () => {
        const validPorts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 32, 33, 34, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 76, 77, 256, 257, 511];
        validPorts.forEach(port => {
          expect(service.normalizePortNum(port)).toBe(port);
        });
      });

      it('should handle edge case numbers', () => {
        // MAX portnum value
        expect(service.normalizePortNum(511)).toBe(511);
        // UNKNOWN_APP
        expect(service.normalizePortNum(0)).toBe(0);
        // PRIVATE_APP
        expect(service.normalizePortNum(256)).toBe(256);
      });
    });

    describe('string enum inputs', () => {
      it('should convert TRACEROUTE_APP string to number 70', () => {
        expect(service.normalizePortNum('TRACEROUTE_APP')).toBe(70);
      });

      it('should convert ADMIN_APP string to number 6', () => {
        expect(service.normalizePortNum('ADMIN_APP')).toBe(6);
      });

      it('should convert TEXT_MESSAGE_APP string to number 1', () => {
        expect(service.normalizePortNum('TEXT_MESSAGE_APP')).toBe(1);
      });

      it('should convert all valid string enum values', () => {
        const enumMap: { [key: string]: number } = {
          'UNKNOWN_APP': 0,
          'TEXT_MESSAGE_APP': 1,
          'REMOTE_HARDWARE_APP': 2,
          'POSITION_APP': 3,
          'NODEINFO_APP': 4,
          'ROUTING_APP': 5,
          'ADMIN_APP': 6,
          'TEXT_MESSAGE_COMPRESSED_APP': 7,
          'WAYPOINT_APP': 8,
          'AUDIO_APP': 9,
          'DETECTION_SENSOR_APP': 10,
          'ALERT_APP': 11,
          'KEY_VERIFICATION_APP': 12,
          'REPLY_APP': 32,
          'IP_TUNNEL_APP': 33,
          'PAXCOUNTER_APP': 34,
          'SERIAL_APP': 64,
          'STORE_FORWARD_APP': 65,
          'RANGE_TEST_APP': 66,
          'TELEMETRY_APP': 67,
          'ZPS_APP': 68,
          'SIMULATOR_APP': 69,
          'TRACEROUTE_APP': 70,
          'NEIGHBORINFO_APP': 71,
          'ATAK_PLUGIN': 72,
          'MAP_REPORT_APP': 73,
          'POWERSTRESS_APP': 74,
          'RETICULUM_TUNNEL_APP': 76,
          'CAYENNE_APP': 77,
          'PRIVATE_APP': 256,
          'ATAK_FORWARDER': 257,
          'MAX': 511
        };

        Object.entries(enumMap).forEach(([key, value]) => {
          expect(service.normalizePortNum(key)).toBe(value);
        });
      });
    });

    describe('edge cases and invalid inputs', () => {
      it('should return undefined for undefined input', () => {
        expect(service.normalizePortNum(undefined)).toBe(undefined);
      });

      it('should return undefined for null input', () => {
        expect(service.normalizePortNum(null as any)).toBe(undefined);
      });

      it('should return undefined for unknown string values', () => {
        expect(service.normalizePortNum('INVALID_APP')).toBe(undefined);
        expect(service.normalizePortNum('random_string')).toBe(undefined);
        expect(service.normalizePortNum('')).toBe(undefined);
      });

      it('should handle numeric strings by returning undefined', () => {
        // The function explicitly does not support numeric strings
        // It expects either a number or a valid enum string
        expect(service.normalizePortNum('70' as any)).toBe(undefined);
        expect(service.normalizePortNum('6' as any)).toBe(undefined);
      });

      it('should return undefined for unexpected types', () => {
        expect(service.normalizePortNum({} as any)).toBe(undefined);
        expect(service.normalizePortNum([] as any)).toBe(undefined);
        expect(service.normalizePortNum(true as any)).toBe(undefined);
      });
    });

    describe('real-world scenarios', () => {
      it('should handle the issue #443 scenario - TRACEROUTE_APP vs ADMIN_APP confusion', () => {
        // When protobufjs returns 'TRACEROUTE_APP' as a string
        const stringPortnum = 'TRACEROUTE_APP';
        expect(service.normalizePortNum(stringPortnum)).toBe(70);

        // When protobufjs returns 70 as a number
        const numericPortnum = 70;
        expect(service.normalizePortNum(numericPortnum)).toBe(70);

        // Both should normalize to the same value
        expect(service.normalizePortNum(stringPortnum)).toBe(service.normalizePortNum(numericPortnum));

        // ADMIN_APP should be different
        expect(service.normalizePortNum('ADMIN_APP')).toBe(6);
        expect(service.normalizePortNum(6)).toBe(6);

        // Verify they're not confused
        expect(service.normalizePortNum('TRACEROUTE_APP')).not.toBe(service.normalizePortNum('ADMIN_APP'));
      });

      it('should ensure consistent normalization for blocked portnums check', () => {
        // Simulate virtualNodeServer.ts BLOCKED_PORTNUMS check
        const BLOCKED_PORTNUMS = [6]; // ADMIN_APP

        // String enum from protobufjs
        const tracerouteString = service.normalizePortNum('TRACEROUTE_APP');
        const adminString = service.normalizePortNum('ADMIN_APP');

        expect(BLOCKED_PORTNUMS.includes(tracerouteString!)).toBe(false);
        expect(BLOCKED_PORTNUMS.includes(adminString!)).toBe(true);

        // Numeric values
        const tracerouteNum = service.normalizePortNum(70);
        const adminNum = service.normalizePortNum(6);

        expect(BLOCKED_PORTNUMS.includes(tracerouteNum!)).toBe(false);
        expect(BLOCKED_PORTNUMS.includes(adminNum!)).toBe(true);
      });

      it('should work correctly in switch statements', () => {
        // Simulate meshtasticManager.ts switch statement
        const testPayloadProcessing = (portnum: number | string | undefined) => {
          const normalized = service.normalizePortNum(portnum);

          switch (normalized) {
            case 1: // TEXT_MESSAGE_APP
              return 'text';
            case 6: // ADMIN_APP
              return 'admin';
            case 70: // TRACEROUTE_APP
              return 'traceroute';
            default:
              return 'unknown';
          }
        };

        expect(testPayloadProcessing('TEXT_MESSAGE_APP')).toBe('text');
        expect(testPayloadProcessing(1)).toBe('text');

        expect(testPayloadProcessing('ADMIN_APP')).toBe('admin');
        expect(testPayloadProcessing(6)).toBe('admin');

        expect(testPayloadProcessing('TRACEROUTE_APP')).toBe('traceroute');
        expect(testPayloadProcessing(70)).toBe('traceroute');

        expect(testPayloadProcessing(undefined)).toBe('unknown');
        expect(testPayloadProcessing('INVALID')).toBe('unknown');
      });
    });
  });

  describe('getPortNumName', () => {
    it('should return correct names for numeric portnums', () => {
      expect(service.getPortNumName(70)).toBe('TRACEROUTE_APP');
      expect(service.getPortNumName(6)).toBe('ADMIN_APP');
      expect(service.getPortNumName(1)).toBe('TEXT_MESSAGE_APP');
    });

    it('should return correct names for string enum portnums', () => {
      expect(service.getPortNumName('TRACEROUTE_APP')).toBe('TRACEROUTE_APP');
      expect(service.getPortNumName('ADMIN_APP')).toBe('ADMIN_APP');
      expect(service.getPortNumName('TEXT_MESSAGE_APP')).toBe('TEXT_MESSAGE_APP');
    });

    it('should handle undefined and invalid inputs gracefully', () => {
      expect(service.getPortNumName(undefined)).toBe('UNKNOWN_undefined');
      expect(service.getPortNumName('INVALID_APP')).toBe('UNKNOWN_INVALID_APP');
    });

    it('should use normalizePortNum internally', () => {
      // Both string and number should return the same name
      expect(service.getPortNumName('TRACEROUTE_APP')).toBe(service.getPortNumName(70));
      expect(service.getPortNumName('ADMIN_APP')).toBe(service.getPortNumName(6));
    });
  });

  describe('createNodeInfo', () => {
    it('should create NodeInfo with viaMqtt=true', async () => {
      const result = await service.createNodeInfo({
        nodeNum: 123456789,
        user: {
          id: '!075bcd15',
          longName: 'MQTT Test Node',
          shortName: 'MQTT',
          hwModel: 255,
        },
        viaMqtt: true,
        isFavorite: false,
      });

      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Uint8Array);

      // Decode and verify viaMqtt is set
      const decoded = decodeFromRadio(result!);
      expect(decoded).not.toBeNull();
      expect(decoded.nodeInfo).toBeDefined();
      expect(decoded.nodeInfo.viaMqtt).toBe(true);
      expect(decoded.nodeInfo.num).toBe(123456789);
    });

    it('should create NodeInfo with viaMqtt=false', async () => {
      const result = await service.createNodeInfo({
        nodeNum: 987654321,
        user: {
          id: '!3ade68b1',
          longName: 'LoRa Test Node',
          shortName: 'LORA',
          hwModel: 43,
        },
        viaMqtt: false,
        isFavorite: true,
      });

      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Uint8Array);

      // Decode and verify viaMqtt is false
      const decoded = decodeFromRadio(result!);
      expect(decoded).not.toBeNull();
      expect(decoded.nodeInfo).toBeDefined();
      expect(decoded.nodeInfo.viaMqtt).toBe(false);
      expect(decoded.nodeInfo.isFavorite).toBe(true);
    });

    it('should create NodeInfo without viaMqtt when not provided', async () => {
      const result = await service.createNodeInfo({
        nodeNum: 111222333,
        user: {
          id: '!06a0b8d5',
          longName: 'No MQTT Field',
          shortName: 'NONE',
        },
        // viaMqtt not provided
      });

      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Uint8Array);

      // Decode and verify nodeInfo exists
      const decoded = decodeFromRadio(result!);
      expect(decoded).not.toBeNull();
      expect(decoded.nodeInfo).toBeDefined();
      expect(decoded.nodeInfo.num).toBe(111222333);
      // viaMqtt should be undefined or false when not provided
      expect(decoded.nodeInfo.viaMqtt).toBeFalsy();
    });

    it('should include all NodeInfo fields correctly', async () => {
      const result = await service.createNodeInfo({
        nodeNum: 444555666,
        user: {
          id: '!1a7f8e12',
          longName: 'Full Test Node',
          shortName: 'FULL',
          hwModel: 14,
          role: 1,
        },
        position: {
          latitude: 40.7128,
          longitude: -74.006,
          altitude: 10,
          time: 1702300000,
        },
        deviceMetrics: {
          batteryLevel: 85,
          voltage: 4.1,
          channelUtilization: 2.5,
          airUtilTx: 1.2,
        },
        snr: 8.5,
        lastHeard: 1702300100,
        hopsAway: 2,
        viaMqtt: true,
        isFavorite: true,
      });

      expect(result).not.toBeNull();

      const decoded = decodeFromRadio(result!);
      expect(decoded.nodeInfo).toBeDefined();
      expect(decoded.nodeInfo.num).toBe(444555666);
      expect(decoded.nodeInfo.viaMqtt).toBe(true);
      expect(decoded.nodeInfo.isFavorite).toBe(true);
      expect(decoded.nodeInfo.hopsAway).toBe(2);
      expect(decoded.nodeInfo.snr).toBeCloseTo(8.5, 1);
      expect(decoded.nodeInfo.lastHeard).toBe(1702300100);
      expect(decoded.nodeInfo.user).toBeDefined();
      expect(decoded.nodeInfo.user.longName).toBe('Full Test Node');
      expect(decoded.nodeInfo.position).toBeDefined();
      expect(decoded.nodeInfo.deviceMetrics).toBeDefined();
    });
  });
});
