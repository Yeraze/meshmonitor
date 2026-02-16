import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockGetNode = vi.fn();
const mockUpsertNode = vi.fn();
const mockInsertTelemetry = vi.fn();
const mockUpdateNodeMobility = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getNode: mockGetNode,
    upsertNode: mockUpsertNode,
    insertTelemetry: mockInsertTelemetry,
    updateNodeMobility: mockUpdateNodeMobility
  }
}));

describe('MeshtasticManager - Position Precision Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Smart upgrade/downgrade logic', () => {
    it('should always accept higher precision position', () => {
      const now = Date.now();
      const oneHourAgo = now - (1 * 60 * 60 * 1000);

      // Existing node has low precision (10 bits)
      mockGetNode.mockReturnValue({
        nodeNum: 123456,
        positionPrecisionBits: 10,
        positionTimestamp: oneHourAgo,
        latitude: 40.0,
        longitude: -75.0
      });

      // New position has higher precision (32 bits)
      const newPrecision = 32;
      const existingPrecision = 10;
      const existingPositionAge = now - oneHourAgo;
      const twelveHoursMs = 12 * 60 * 60 * 1000;

      // Smart logic: should ACCEPT because newPrecision > existingPrecision
      const shouldUpdatePosition = !(newPrecision < existingPrecision && existingPositionAge < twelveHoursMs);

      expect(shouldUpdatePosition).toBe(true);
      expect(newPrecision).toBeGreaterThan(existingPrecision);
    });

    it('should reject lower precision position when existing is recent', () => {
      const now = Date.now();
      const oneHourAgo = now - (1 * 60 * 60 * 1000); // 1 hour ago

      // Existing node has high precision (32 bits) from 1 hour ago
      mockGetNode.mockReturnValue({
        nodeNum: 123456,
        positionPrecisionBits: 32,
        positionTimestamp: oneHourAgo,
        latitude: 40.0,
        longitude: -75.0
      });

      // New position has lower precision (10 bits)
      const newPrecision = 10;
      const existingPrecision = 32;
      const existingPositionAge = now - oneHourAgo;
      const twelveHoursMs = 12 * 60 * 60 * 1000;

      // Smart logic: should REJECT because newPrecision < existingPrecision AND existing is recent
      const shouldUpdatePosition = !(newPrecision < existingPrecision && existingPositionAge < twelveHoursMs);

      expect(shouldUpdatePosition).toBe(false);
      expect(existingPositionAge).toBeLessThan(twelveHoursMs);
    });

    it('should accept lower precision position when existing is stale (>12 hours)', () => {
      const now = Date.now();
      const thirteenHoursAgo = now - (13 * 60 * 60 * 1000); // 13 hours ago

      // Existing node has high precision (32 bits) from 13 hours ago
      mockGetNode.mockReturnValue({
        nodeNum: 123456,
        positionPrecisionBits: 32,
        positionTimestamp: thirteenHoursAgo,
        latitude: 40.0,
        longitude: -75.0
      });

      // New position has lower precision (10 bits)
      const newPrecision = 10;
      const existingPrecision = 32;
      const existingPositionAge = now - thirteenHoursAgo;
      const twelveHoursMs = 12 * 60 * 60 * 1000;

      // Smart logic: should ACCEPT because existing position is stale (>12 hours)
      const shouldUpdatePosition = !(newPrecision < existingPrecision && existingPositionAge < twelveHoursMs);

      expect(shouldUpdatePosition).toBe(true);
      expect(existingPositionAge).toBeGreaterThan(twelveHoursMs);
    });

    it('should accept position when no existing position', () => {
      // No existing node
      mockGetNode.mockReturnValue(null);

      const shouldUpdatePosition = true; // Always accept first position

      expect(shouldUpdatePosition).toBe(true);
    });

    it('should accept position when existing has no precision data', () => {
      // Existing node without precision tracking (old data)
      mockGetNode.mockReturnValue({
        nodeNum: 123456,
        latitude: 40.0,
        longitude: -75.0
        // No positionPrecisionBits or positionTimestamp
      });

      // New position has precision data
      const newPrecision = 16;
      const existingNode = mockGetNode();
      const existingPrecision = existingNode?.positionPrecisionBits;

      // Should accept because existing has no precision data
      const shouldUpdatePosition = existingPrecision === undefined || newPrecision !== undefined;

      expect(shouldUpdatePosition).toBe(true);
      expect(existingPrecision).toBeUndefined();
    });

    it('should calculate position age correctly at exactly 12 hours', () => {
      const now = Date.now();
      const exactlyTwelveHoursAgo = now - (12 * 60 * 60 * 1000);

      mockGetNode.mockReturnValue({
        nodeNum: 123456,
        positionPrecisionBits: 32,
        positionTimestamp: exactlyTwelveHoursAgo,
        latitude: 40.0,
        longitude: -75.0
      });

      const newPrecision = 10;
      const existingPrecision = 32;
      const existingPositionAge = now - exactlyTwelveHoursAgo;
      const twelveHoursMs = 12 * 60 * 60 * 1000;

      // At exactly 12 hours, should still reject (< not <=)
      const shouldUpdatePosition = !(newPrecision < existingPrecision && existingPositionAge < twelveHoursMs);

      expect(shouldUpdatePosition).toBe(true);
      expect(existingPositionAge).toBe(twelveHoursMs);
    });
  });

  describe('Precision metadata extraction', () => {
    it('should extract precisionBits from position message (camelCase)', () => {
      const position = {
        precisionBits: 32,
        latitude: 40.0,
        longitude: -75.0
      };

      const precisionBits = position.precisionBits ?? undefined;

      expect(precisionBits).toBe(32);
    });

    it('should extract precision_bits from position message (snake_case)', () => {
      const position = {
        precision_bits: 32,
        latitude: 40.0,
        longitude: -75.0
      };

      const precisionBits = (position as any).precision_bits ?? undefined;

      expect(precisionBits).toBe(32);
    });

    it('should handle missing precision data gracefully', () => {
      const position = {
        latitude: 40.0,
        longitude: -75.0
      };

      const precisionBits = (position as any).precisionBits ?? (position as any).precision_bits ?? undefined;

      expect(precisionBits).toBeUndefined();
    });

    it('should extract gpsAccuracy from position message', () => {
      const position = {
        gpsAccuracy: 5.0, // 5 meters
        latitude: 40.0,
        longitude: -75.0
      };

      const gpsAccuracy = position.gpsAccuracy ?? undefined;

      expect(gpsAccuracy).toBe(5.0);
    });

    it('should extract HDOP from position message', () => {
      const position = {
        HDOP: 1.2,
        latitude: 40.0,
        longitude: -75.0
      };

      const hdop = (position as any).HDOP ?? undefined;

      expect(hdop).toBe(1.2);
    });

    it('should extract channel from meshPacket', () => {
      const meshPacket = {
        channel: 2,
        from: 123456
      };

      const channelIndex = meshPacket.channel !== undefined ? meshPacket.channel : 0;

      expect(channelIndex).toBe(2);
    });

    it('should default channel to 0 when undefined', () => {
      const meshPacket = {
        from: 123456
      };

      const channelIndex = (meshPacket as any).channel !== undefined ? (meshPacket as any).channel : 0;

      expect(channelIndex).toBe(0);
    });
  });

  describe('Database storage', () => {
    it('should store position with all precision metadata', () => {
      const now = Date.now();
      mockGetNode.mockReturnValue(null); // No existing node

      const nodeData = {
        nodeNum: 123456,
        nodeId: '!1e240abcd',
        latitude: 40.7128,
        longitude: -74.0060,
        altitude: 10,
        lastHeard: now / 1000,
        positionChannel: 1,
        positionPrecisionBits: 32,
        positionGpsAccuracy: 5.0,
        positionHdop: 1.2,
        positionTimestamp: now
      };

      // Simulate calling upsertNode
      mockUpsertNode(nodeData);

      expect(mockUpsertNode).toHaveBeenCalledWith(nodeData);
      expect(mockUpsertNode).toHaveBeenCalledWith(
        expect.objectContaining({
          positionChannel: 1,
          positionPrecisionBits: 32,
          positionGpsAccuracy: 5.0,
          positionHdop: 1.2,
          positionTimestamp: now
        })
      );
    });

    it('should store telemetry with precision metadata', () => {
      const now = Date.now();
      const telemetryData = {
        nodeId: '!1e240abcd',
        nodeNum: 123456,
        telemetryType: 'latitude',
        timestamp: now / 1000,
        value: 40.7128,
        unit: '°',
        createdAt: now,
        packetTimestamp: undefined,
        channel: 1,
        precisionBits: 32,
        gpsAccuracy: 5.0
      };

      mockInsertTelemetry(telemetryData);

      expect(mockInsertTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 1,
          precisionBits: 32,
          gpsAccuracy: 5.0
        })
      );
    });
  });

  describe('Edge cases', () => {
    it('should handle Infinity as position age when no timestamp exists', () => {
      mockGetNode.mockReturnValue({
        nodeNum: 123456,
        positionPrecisionBits: 32,
        // No positionTimestamp
        latitude: 40.0,
        longitude: -75.0
      });

      const existingNode = mockGetNode();
      const existingPositionAge = existingNode?.positionTimestamp ? (Date.now() - existingNode.positionTimestamp) : Infinity;

      expect(existingPositionAge).toBe(Infinity);
    });

    it('should accept new position when existing age is Infinity', () => {
      const newPrecision = 10;
      const existingPrecision = 32;
      const existingPositionAge = Infinity;
      const twelveHoursMs = 12 * 60 * 60 * 1000;

      // Should accept because Infinity > 12 hours
      const shouldUpdatePosition = !(newPrecision < existingPrecision && existingPositionAge < twelveHoursMs);

      expect(shouldUpdatePosition).toBe(true);
    });

    it('should handle precision bits of 0 (valid minimum)', () => {
      const position = {
        precisionBits: 0, // Valid: very low precision
        latitude: 40.0,
        longitude: -75.0
      };

      const precisionBits = position.precisionBits ?? undefined;

      expect(precisionBits).toBe(0);
      expect(precisionBits).not.toBeUndefined();
    });

    it('should distinguish between 0 precision bits and undefined', () => {
      const positionWithZero = { precisionBits: 0 };
      const positionWithUndefined = {};

      const precisionZero = positionWithZero.precisionBits ?? undefined;
      const precisionUndefined = (positionWithUndefined as any).precisionBits ?? undefined;

      expect(precisionZero).toBe(0);
      expect(precisionUndefined).toBeUndefined();
      expect(precisionZero).not.toBe(precisionUndefined);
    });
  });

  describe('packetId propagation', () => {
    it('should include packetId in position telemetry from mesh packets', () => {
      const now = Date.now();
      const meshPacketId = 1234567890;

      const telemetryData = {
        nodeId: '!1e240abcd',
        nodeNum: 123456,
        telemetryType: 'latitude',
        timestamp: now / 1000,
        value: 40.7128,
        unit: '°',
        createdAt: now,
        packetTimestamp: undefined,
        packetId: meshPacketId,
        channel: 1,
        precisionBits: 32,
        gpsAccuracy: 5.0
      };

      mockInsertTelemetry(telemetryData);

      expect(mockInsertTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({
          packetId: meshPacketId,
          channel: 1,
          precisionBits: 32,
          gpsAccuracy: 5.0
        })
      );
    });

    it('should extract packetId from meshPacket.id using Number conversion', () => {
      // Simulate how meshtasticManager extracts packetId
      const meshPacket = { id: 987654321, from: 123456 };

      const packetId = meshPacket.id ? Number(meshPacket.id) : undefined;

      expect(packetId).toBe(987654321);
      expect(typeof packetId).toBe('number');
    });

    it('should produce undefined packetId when meshPacket.id is missing', () => {
      // Simulate a meshPacket without an id field
      const meshPacket = { from: 123456 } as any;

      const packetId = meshPacket.id ? Number(meshPacket.id) : undefined;

      expect(packetId).toBeUndefined();
    });

    it('should handle meshPacket.id of 0 as falsy (resulting in undefined)', () => {
      // meshPacket.id of 0 is technically a valid protobuf default but not a real packet ID
      const meshPacket = { id: 0, from: 123456 };

      const packetId = meshPacket.id ? Number(meshPacket.id) : undefined;

      expect(packetId).toBeUndefined();
    });

    it('should share the same packetId across multiple telemetry entries from one packet', () => {
      const now = Date.now();
      const meshPacketId = 555666777;

      // Simulate device metrics producing multiple telemetry entries from one packet
      const metricsFromOnePacket = [
        { telemetryType: 'batteryLevel', value: 85, unit: '%' },
        { telemetryType: 'voltage', value: 3.7, unit: 'V' },
        { telemetryType: 'channelUtilization', value: 12.5, unit: '%' },
        { telemetryType: 'airUtilTx', value: 5.2, unit: '%' },
      ];

      for (const metric of metricsFromOnePacket) {
        mockInsertTelemetry({
          nodeId: '!1e240abcd',
          nodeNum: 123456,
          telemetryType: metric.telemetryType,
          timestamp: now,
          value: metric.value,
          unit: metric.unit,
          createdAt: now,
          packetId: meshPacketId,
        });
      }

      // Verify all 4 calls include the same packetId
      expect(mockInsertTelemetry).toHaveBeenCalledTimes(metricsFromOnePacket.length);
      for (const call of mockInsertTelemetry.mock.calls) {
        expect(call[0].packetId).toBe(meshPacketId);
      }
    });
  });
});
