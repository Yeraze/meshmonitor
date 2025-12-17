import { describe, it, expect } from 'vitest';
import { calculateLoRaFrequency } from './loraFrequency';

describe('calculateLoRaFrequency', () => {
  describe('US region (region 1)', () => {
    it('should calculate correct frequency for slot 18', () => {
      const result = calculateLoRaFrequency(1, 18, 0, 0);
      expect(result).toBe('906.375 MHz');
    });

    it('should calculate correct frequency for slot 20 (LongFast default)', () => {
      const result = calculateLoRaFrequency(1, 20, 0, 0);
      expect(result).toBe('906.875 MHz');
    });

    it('should calculate correct frequency for slot 0', () => {
      const result = calculateLoRaFrequency(1, 0, 0, 0);
      expect(result).toBe('901.875 MHz');
    });

    it('should calculate correct frequency for slot 103 (max)', () => {
      const result = calculateLoRaFrequency(1, 103, 0, 0);
      expect(result).toBe('927.625 MHz');
    });

    it('should return "Invalid channel" for slot >= 104', () => {
      const result = calculateLoRaFrequency(1, 104, 0, 0);
      expect(result).toBe('Invalid channel');
    });

    it('should apply frequency offset correctly', () => {
      const result = calculateLoRaFrequency(1, 20, 0, 0.1);
      expect(result).toBe('906.975 MHz');
    });
  });

  describe('EU_433 region (region 2)', () => {
    it('should calculate correct frequency for slot 4 (default)', () => {
      const result = calculateLoRaFrequency(2, 4, 0, 0);
      expect(result).toBe('433.875 MHz');
    });

    it('should calculate correct frequency for slot 0', () => {
      const result = calculateLoRaFrequency(2, 0, 0, 0);
      expect(result).toBe('433.075 MHz');
    });

    it('should return "Invalid channel" for slot >= 5', () => {
      const result = calculateLoRaFrequency(2, 5, 0, 0);
      expect(result).toBe('Invalid channel');
    });
  });

  describe('EU_868 region (region 3)', () => {
    it('should calculate correct frequency for slot 1 (default)', () => {
      const result = calculateLoRaFrequency(3, 1, 0, 0);
      expect(result).toBe('869.525 MHz');
    });

    it('should calculate correct frequency for slot 0', () => {
      const result = calculateLoRaFrequency(3, 0, 0, 0);
      expect(result).toBe('869.325 MHz');
    });

    it('should return "Invalid channel" for slot >= 2', () => {
      const result = calculateLoRaFrequency(3, 2, 0, 0);
      expect(result).toBe('Invalid channel');
    });
  });

  describe('Override frequency', () => {
    it('should use override frequency when set', () => {
      const result = calculateLoRaFrequency(1, 20, 915.0, 0);
      expect(result).toBe('915.000 MHz');
    });

    it('should apply frequency offset to override frequency', () => {
      const result = calculateLoRaFrequency(1, 20, 915.0, 0.5);
      expect(result).toBe('915.500 MHz');
    });

    it('should ignore override frequency when zero', () => {
      const result = calculateLoRaFrequency(1, 20, 0, 0);
      expect(result).toBe('906.875 MHz');
    });
  });

  describe('Edge cases', () => {
    it('should return "Unknown" for region 0', () => {
      const result = calculateLoRaFrequency(0, 0, 0, 0);
      expect(result).toBe('Unknown');
    });

    it('should return "Unknown" for invalid region', () => {
      const result = calculateLoRaFrequency(999, 0, 0, 0);
      expect(result).toBe('Unknown');
    });

    it('should return "Invalid channel" for negative channel number', () => {
      const result = calculateLoRaFrequency(1, -1, 0, 0);
      expect(result).toBe('Invalid channel');
    });

    it('should handle frequency offset correctly with negative values', () => {
      const result = calculateLoRaFrequency(1, 20, 0, -0.1);
      expect(result).toBe('906.775 MHz');
    });
  });

  describe('Other regions', () => {
    it('should calculate frequency for CN region (region 4)', () => {
      const result = calculateLoRaFrequency(4, 0, 0, 0);
      expect(result).toBe('470.000 MHz');
    });

    it('should calculate frequency for JP region (region 5)', () => {
      const result = calculateLoRaFrequency(5, 0, 0, 0);
      expect(result).toBe('920.600 MHz');
    });

    it('should calculate frequency for LORA_24 region (region 13)', () => {
      const result = calculateLoRaFrequency(13, 0, 0, 0);
      expect(result).toBe('2400.000 MHz');
    });
  });
});

