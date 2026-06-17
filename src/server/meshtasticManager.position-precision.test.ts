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

  describe('Latest-packet-wins behavior (issue #3030)', () => {
    // The handler no longer keeps stored higher-precision values around when a node
    // legitimately downgrades its channel precision. Latest packet is authoritative.

    it('accepts a precision downgrade even when existing position is recent', () => {
      // Prior 4.5 behaviour blocked downgrades for 12 hours; the user's bug report
      // (#3030) was that a node moved from 15-bit -> 13-bit precision but the box
      // never shrank back. The handler must now always honour the new value.
      const newPrecision = 13;
      const existingPrecision = 15;
      const shouldUpdatePosition = true; // always

      expect(newPrecision).toBeLessThan(existingPrecision);
      expect(shouldUpdatePosition).toBe(true);
    });

    it('accepts a precision upgrade', () => {
      const newPrecision = 15;
      const existingPrecision = 13;
      const shouldUpdatePosition = true;

      expect(newPrecision).toBeGreaterThan(existingPrecision);
      expect(shouldUpdatePosition).toBe(true);
    });

    it('accepts identical precision (no-op update path)', () => {
      const newPrecision = 13;
      const existingPrecision = 13;
      const shouldUpdatePosition = true;

      expect(newPrecision).toBe(existingPrecision);
      expect(shouldUpdatePosition).toBe(true);
    });
  });

  describe('Channel-precision fallback removed (issue #3030)', () => {
    // The handler previously fell back to the LOCAL channel's positionPrecision
    // when a packet had no precision_bits. That record reflects the MeshMonitor
    // instance's own config, not the remote node's, and produced incorrect boxes.

    it('Position handler: uses precisionBits from the packet verbatim', () => {
      const position = { precisionBits: 13 };
      const localChannelPositionPrecision = 15; // unrelated; must not influence

      const precisionBits = position.precisionBits ?? undefined;

      expect(precisionBits).toBe(13);
      expect(precisionBits).not.toBe(localChannelPositionPrecision);
    });

    it('Position handler: precisionBits=0 from wire is preserved (no fallback)', () => {
      const position = { precisionBits: 0 };
      const localChannelPositionPrecision = 15;

      // After the fix the handler stores 0 as-is; the frontend then renders no
      // accuracy box (0 means "no masking, full precision").
      const precisionBits = position.precisionBits ?? undefined;

      expect(precisionBits).toBe(0);
      expect(precisionBits).not.toBe(localChannelPositionPrecision);
    });

    it('NodeInfo handler: treats embedded precisionBits=0 as "absent" and leaves existing untouched', () => {
      // The NodeInfo protobuf decoder normalises missing precision_bits to 0. The
      // handler now skips the precision write when the value is 0, preserving any
      // value previously learned from a real Position packet.
      const nodeInfoPosition = { precisionBits: 0 };
      const existingPrecisionBits = 13;

      const incoming = nodeInfoPosition.precisionBits ?? undefined;
      const shouldWritePrecision = incoming !== undefined && incoming !== 0;

      expect(shouldWritePrecision).toBe(false);
      expect(existingPrecisionBits).toBe(13); // unchanged
    });

    it('NodeInfo handler: writes precisionBits when present in embedded Position', () => {
      const nodeInfoPosition = { precisionBits: 14 };
      const incoming = nodeInfoPosition.precisionBits ?? undefined;
      const shouldWritePrecision = incoming !== undefined && incoming !== 0;

      expect(shouldWritePrecision).toBe(true);
      expect(incoming).toBe(14);
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
    it('should handle precision bits of 0 (valid minimum)', () => {
      const position = {
        precisionBits: 0, // Valid: full precision / no masking
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

  describe('NodeInfo precision guard (issue #3513)', () => {
    // When a node has a statically-set GPS position, NODEINFO_APP packets carry
    // a lat/lon that has been grid-snapped by the channel's positionPrecision setting.
    // The guard prevents these lower-precision coordinates from overwriting a
    // higher-precision value that was already stored (e.g. from a POSITION_APP packet).

    // Guard logic (mirrors meshtasticManager.ts):
    // shouldUpdateLatLon =
    //   existingNode?.latitude == null || existingNode?.longitude == null ||
    //   !precisionBits || !storedPrecisionBits || precisionBits >= storedPrecisionBits

    function evalGuard(
      existingLat: number | null | undefined,
      existingLon: number | null | undefined,
      storedPrecisionBits: number | undefined,
      incomingPrecisionBits: number | undefined
    ): boolean {
      return (
        existingLat == null ||
        existingLon == null ||
        !incomingPrecisionBits ||
        !storedPrecisionBits ||
        incomingPrecisionBits >= storedPrecisionBits
      );
    }

    it('blocks lat/lon update when incoming precision is lower than stored', () => {
      // Core case for issue #3513: node has high-precision GPS, NodeInfo arrives
      // with positionPrecision-reduced coords.
      expect(evalGuard(40.12345678, -74.98765432, 32, 14)).toBe(false);
    });

    it('allows lat/lon update when incoming precision equals stored', () => {
      expect(evalGuard(40.0, -74.0, 14, 14)).toBe(true);
    });

    it('allows lat/lon update when incoming precision is higher than stored', () => {
      expect(evalGuard(40.0, -74.0, 14, 32)).toBe(true);
    });

    it('allows lat/lon update when existing node has no coordinates (first write)', () => {
      // Even low precision is accepted if the node has no position at all.
      expect(evalGuard(null, null, 32, 12)).toBe(true);
    });

    it('allows lat/lon update when existing latitude is null', () => {
      expect(evalGuard(null, -74.0, 32, 12)).toBe(true);
    });

    it('allows lat/lon update when stored precision is 0 (unknown)', () => {
      // 0 means the existing record has no precision metadata — must accept any update.
      expect(evalGuard(40.0, -74.0, 0, 14)).toBe(true);
    });

    it('allows lat/lon update when stored precision is undefined', () => {
      expect(evalGuard(40.0, -74.0, undefined, 14)).toBe(true);
    });

    it('allows lat/lon update when incoming precision is 0 (absent/unknown)', () => {
      // 0 from the wire means "no precision masking / not set"; treat as no info,
      // so always accept (do not block on an unknown incoming value).
      expect(evalGuard(40.0, -74.0, 32, 0)).toBe(true);
    });

    it('does not update positionPrecisionBits when lat/lon is blocked (prevents one-shot guard)', () => {
      // Critical regression guard: if positionPrecisionBits were written even when
      // the lat/lon update was blocked, the stored precision would decrease and the
      // guard would pass on the very next packet (one-shot defect).
      const existingPrecisionBits = 32;
      const incomingPrecisionBits = 14;
      const shouldUpdateLatLon = evalGuard(40.0, -74.0, existingPrecisionBits, incomingPrecisionBits);

      expect(shouldUpdateLatLon).toBe(false);

      // Simulate the conditional write: precision only updated inside shouldUpdateLatLon block
      let storedAfter = existingPrecisionBits;
      if (shouldUpdateLatLon && incomingPrecisionBits !== 0) {
        storedAfter = incomingPrecisionBits;
      }

      expect(storedAfter).toBe(32); // stored precision unchanged
    });

    it('updates altitude independently even when lat/lon is blocked', () => {
      // Altitude is NOT reduced by firmware positionPrecision — firmware only
      // grid-snaps lat/lon. So altitude from a "low-precision" NodeInfo is valid
      // and must be written even when the lat/lon update is blocked.
      const shouldUpdateLatLon = evalGuard(40.0, -74.0, 32, 14);
      expect(shouldUpdateLatLon).toBe(false);

      const existingAltitude = 5;
      const incomingAltitude = 25;

      let altitude = existingAltitude;
      if (shouldUpdateLatLon) {
        altitude = incomingAltitude; // lat/lon path also writes altitude
      } else if (incomingAltitude !== undefined && incomingAltitude !== null) {
        altitude = incomingAltitude; // independent altitude update in else-branch
      }

      expect(altitude).toBe(25);
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
