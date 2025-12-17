import { describe, it, expect } from 'vitest';
import { encodePositionFlags, decodePositionFlags, PositionFlag } from './positionFlags';

describe('positionFlags utilities', () => {
  describe('encodePositionFlags', () => {
    it('should encode all flags to 0 when all are false', () => {
      const flags = {
        altitude: false,
        altitudeMsl: false,
        geoidalSeparation: false,
        dop: false,
        hvdop: false,
        satinview: false,
        seqNo: false,
        timestamp: false,
        heading: false,
        speed: false,
      };
      const result = encodePositionFlags(flags);
      expect(result).toBe(0);
    });

    it('should encode single flag correctly', () => {
      const flags = {
        altitude: true,
        altitudeMsl: false,
        geoidalSeparation: false,
        dop: false,
        hvdop: false,
        satinview: false,
        seqNo: false,
        timestamp: false,
        heading: false,
        speed: false,
      };
      const result = encodePositionFlags(flags);
      expect(result).toBe(PositionFlag.ALTITUDE);
    });

    it('should encode multiple flags correctly', () => {
      const flags = {
        altitude: true,
        altitudeMsl: true,
        geoidalSeparation: false,
        dop: true,
        hvdop: false,
        satinview: false,
        seqNo: false,
        timestamp: false,
        heading: false,
        speed: false,
      };
      const result = encodePositionFlags(flags);
      expect(result).toBe(PositionFlag.ALTITUDE | PositionFlag.ALTITUDE_MSL | PositionFlag.DOP);
    });

    it('should encode all flags correctly', () => {
      const flags = {
        altitude: true,
        altitudeMsl: true,
        geoidalSeparation: true,
        dop: true,
        hvdop: true,
        satinview: true,
        seqNo: true,
        timestamp: true,
        heading: true,
        speed: true,
      };
      const result = encodePositionFlags(flags);
      const expected = PositionFlag.ALTITUDE |
        PositionFlag.ALTITUDE_MSL |
        PositionFlag.GEOIDAL_SEPARATION |
        PositionFlag.DOP |
        PositionFlag.HVDOP |
        PositionFlag.SATINVIEW |
        PositionFlag.SEQ_NO |
        PositionFlag.TIMESTAMP |
        PositionFlag.HEADING |
        PositionFlag.SPEED;
      expect(result).toBe(expected);
    });
  });

  describe('decodePositionFlags', () => {
    it('should decode 0 to all flags false', () => {
      const result = decodePositionFlags(0);
      expect(result).toEqual({
        altitude: false,
        altitudeMsl: false,
        geoidalSeparation: false,
        dop: false,
        hvdop: false,
        satinview: false,
        seqNo: false,
        timestamp: false,
        heading: false,
        speed: false,
      });
    });

    it('should decode single flag correctly', () => {
      const result = decodePositionFlags(PositionFlag.ALTITUDE);
      expect(result.altitude).toBe(true);
      expect(result.altitudeMsl).toBe(false);
      expect(result.speed).toBe(false);
    });

    it('should decode multiple flags correctly', () => {
      const mask = PositionFlag.ALTITUDE | PositionFlag.ALTITUDE_MSL | PositionFlag.DOP;
      const result = decodePositionFlags(mask);
      expect(result.altitude).toBe(true);
      expect(result.altitudeMsl).toBe(true);
      expect(result.dop).toBe(true);
      expect(result.geoidalSeparation).toBe(false);
      expect(result.hvdop).toBe(false);
    });

    it('should decode all flags correctly', () => {
      const mask = PositionFlag.ALTITUDE |
        PositionFlag.ALTITUDE_MSL |
        PositionFlag.GEOIDAL_SEPARATION |
        PositionFlag.DOP |
        PositionFlag.HVDOP |
        PositionFlag.SATINVIEW |
        PositionFlag.SEQ_NO |
        PositionFlag.TIMESTAMP |
        PositionFlag.HEADING |
        PositionFlag.SPEED;
      const result = decodePositionFlags(mask);
      expect(result).toEqual({
        altitude: true,
        altitudeMsl: true,
        geoidalSeparation: true,
        dop: true,
        hvdop: true,
        satinview: true,
        seqNo: true,
        timestamp: true,
        heading: true,
        speed: true,
      });
    });
  });

  describe('round-trip encoding/decoding', () => {
    it('should maintain state through encode/decode cycle', () => {
      const original = {
        altitude: true,
        altitudeMsl: false,
        geoidalSeparation: true,
        dop: false,
        hvdop: true,
        satinview: false,
        seqNo: true,
        timestamp: false,
        heading: true,
        speed: false,
      };
      const encoded = encodePositionFlags(original);
      const decoded = decodePositionFlags(encoded);
      expect(decoded).toEqual(original);
    });

    it('should handle all combinations correctly', () => {
      // Test various combinations
      const testCases = [
        { altitude: true, speed: true },
        { dop: true, hvdop: true, timestamp: true },
        { altitudeMsl: true, geoidalSeparation: true, heading: true },
      ];

      testCases.forEach(testCase => {
        const fullFlags = {
          altitude: false,
          altitudeMsl: false,
          geoidalSeparation: false,
          dop: false,
          hvdop: false,
          satinview: false,
          seqNo: false,
          timestamp: false,
          heading: false,
          speed: false,
          ...testCase,
        };
        const encoded = encodePositionFlags(fullFlags);
        const decoded = decodePositionFlags(encoded);
        expect(decoded).toEqual(fullFlags);
      });
    });
  });
});

