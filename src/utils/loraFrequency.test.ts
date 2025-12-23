import { describe, it, expect } from 'vitest';
import { calculateLoRaFrequency } from './loraFrequency';

describe('calculateLoRaFrequency', () => {
  // Default bandwidth is 250 kHz (LongFast preset)
  // Formula: freq = freqStart + (bw / 2000) + (slot_index * (bw / 1000))
  // Note: channelNum is 1-based (Meshtastic protobuf), converted to 0-based slot internally
  // channelNum 0 = hash algorithm (defaults to slot 0), channelNum 1 = slot 0, channelNum 2 = slot 1, etc.

  describe('US region (region 1)', () => {
    // US: freqStart = 902.0 MHz, freqEnd = 928.0 MHz
    // With 250 kHz BW: halfBwOffset = 0.125 MHz, spacing = 0.25 MHz
    // Slot 0: 902.0 + 0.125 + 0 = 902.125 MHz

    it('should calculate correct frequency for channelNum 0 (hash default, slot 0)', () => {
      const result = calculateLoRaFrequency(1, 0, 0, 0);
      expect(result).toBe('902.125 MHz');
    });

    it('should calculate correct frequency for channelNum 1 (slot 0)', () => {
      const result = calculateLoRaFrequency(1, 1, 0, 0);
      expect(result).toBe('902.125 MHz');
    });

    it('should calculate correct frequency for channelNum 19 (slot 18)', () => {
      // 902.0 + 0.125 + (18 * 0.25) = 902.125 + 4.5 = 906.625 MHz
      const result = calculateLoRaFrequency(1, 19, 0, 0);
      expect(result).toBe('906.625 MHz');
    });

    it('should calculate correct frequency for channelNum 21 (slot 20, LongFast default)', () => {
      // 902.0 + 0.125 + (20 * 0.25) = 902.125 + 5.0 = 907.125 MHz
      const result = calculateLoRaFrequency(1, 21, 0, 0);
      expect(result).toBe('907.125 MHz');
    });

    it('should calculate correct frequency for channelNum 104 (slot 103, max with 250kHz BW)', () => {
      // US has (928-902)/0.25 = 104 slots (0-103)
      // 902.0 + 0.125 + (103 * 0.25) = 902.125 + 25.75 = 927.875 MHz
      const result = calculateLoRaFrequency(1, 104, 0, 0);
      expect(result).toBe('927.875 MHz');
    });

    it('should return "Invalid channel" for channelNum 105 (slot 104, out of range)', () => {
      const result = calculateLoRaFrequency(1, 105, 0, 0);
      expect(result).toBe('Invalid channel');
    });

    it('should apply frequency offset correctly', () => {
      // channelNum 21 = slot 20: 907.125 + 0.1 = 907.225 MHz
      const result = calculateLoRaFrequency(1, 21, 0, 0.1);
      expect(result).toBe('907.225 MHz');
    });

    it('should calculate correctly with 125kHz bandwidth', () => {
      // With 125 kHz BW: halfBwOffset = 0.0625 MHz, spacing = 0.125 MHz
      // channelNum 21 = slot 20: 902.0 + 0.0625 + (20 * 0.125) = 902.0625 + 2.5 = 904.5625 MHz
      const result = calculateLoRaFrequency(1, 21, 0, 0, 125);
      expect(result).toBe('904.563 MHz');
    });
  });

  describe('EU_433 region (region 2)', () => {
    // EU_433: freqStart = 433.0 MHz, freqEnd = 434.0 MHz
    // With 250 kHz BW: (434-433)/0.25 = 4 slots (0-3)
    // Slot 0: 433.0 + 0.125 = 433.125 MHz

    it('should calculate correct frequency for channelNum 1 (slot 0)', () => {
      const result = calculateLoRaFrequency(2, 1, 0, 0);
      expect(result).toBe('433.125 MHz');
    });

    it('should calculate correct frequency for channelNum 4 (slot 3, max with 250kHz BW)', () => {
      // 433.0 + 0.125 + (3 * 0.25) = 433.125 + 0.75 = 433.875 MHz
      const result = calculateLoRaFrequency(2, 4, 0, 0);
      expect(result).toBe('433.875 MHz');
    });

    it('should return "Invalid channel" for channelNum 5 (slot 4, out of range)', () => {
      const result = calculateLoRaFrequency(2, 5, 0, 0);
      expect(result).toBe('Invalid channel');
    });
  });

  describe('EU_868 region (region 3)', () => {
    // EU_868: freqStart = 869.4 MHz, freqEnd = 869.65 MHz (only 250 kHz span!)
    // With 250 kHz BW: (869.65-869.4)/0.25 = 1 slot (only slot 0)
    // Slot 0: 869.4 + 0.125 = 869.525 MHz

    it('should calculate correct frequency for channelNum 1 (slot 0, only valid slot with 250kHz BW)', () => {
      const result = calculateLoRaFrequency(3, 1, 0, 0);
      expect(result).toBe('869.525 MHz');
    });

    it('should return "Invalid channel" for channelNum 2 (slot 1) with 250kHz BW', () => {
      // EU_868 only has 1 slot with 250kHz bandwidth
      const result = calculateLoRaFrequency(3, 2, 0, 0);
      expect(result).toBe('Invalid channel');
    });

    it('should allow channelNum 2 (slot 1) with 125kHz bandwidth', () => {
      // With 125 kHz BW: (869.65-869.4)/0.125 = 2 slots (0-1)
      // Slot 1: 869.4 + 0.0625 + (1 * 0.125) = 869.4625 + 0.125 = 869.5875 MHz
      // Note: JavaScript floating-point rounds 869.5875 to 869.587 with toFixed(3)
      const result = calculateLoRaFrequency(3, 2, 0, 0, 125);
      expect(result).toBe('869.587 MHz');
    });
  });

  describe('RU region (region 9)', () => {
    // RU: freqStart = 868.7 MHz, freqEnd = 869.2 MHz (500 kHz span)
    // With 250 kHz BW: (869.2-868.7)/0.25 = 2 slots (0-1)
    // Slot 0: 868.7 + 0.125 = 868.825 MHz

    it('should calculate correct frequency for channelNum 1 (slot 0)', () => {
      const result = calculateLoRaFrequency(9, 1, 0, 0);
      expect(result).toBe('868.825 MHz');
    });

    it('should calculate correct frequency for channelNum 2 (slot 1)', () => {
      // 868.7 + 0.125 + (1 * 0.25) = 868.825 + 0.25 = 869.075 MHz
      const result = calculateLoRaFrequency(9, 2, 0, 0);
      expect(result).toBe('869.075 MHz');
    });

    it('should return "Invalid channel" for channelNum 3 (slot 2, out of range)', () => {
      const result = calculateLoRaFrequency(9, 3, 0, 0);
      expect(result).toBe('Invalid channel');
    });
  });

  describe('Override frequency', () => {
    it('should use override frequency when set', () => {
      const result = calculateLoRaFrequency(1, 21, 915.0, 0);
      expect(result).toBe('915.000 MHz');
    });

    it('should apply frequency offset to override frequency', () => {
      const result = calculateLoRaFrequency(1, 21, 915.0, 0.5);
      expect(result).toBe('915.500 MHz');
    });

    it('should ignore override frequency when zero', () => {
      const result = calculateLoRaFrequency(1, 21, 0, 0);
      expect(result).toBe('907.125 MHz');
    });
  });

  describe('Edge cases', () => {
    it('should return "Unknown" for region 0', () => {
      const result = calculateLoRaFrequency(0, 1, 0, 0);
      expect(result).toBe('Unknown');
    });

    it('should return "Unknown" for invalid region', () => {
      const result = calculateLoRaFrequency(999, 1, 0, 0);
      expect(result).toBe('Unknown');
    });

    it('should return "Invalid channel" for negative channel number', () => {
      const result = calculateLoRaFrequency(1, -1, 0, 0);
      expect(result).toBe('Invalid channel');
    });

    it('should handle frequency offset correctly with negative values', () => {
      // channelNum 21 = slot 20: 907.125 - 0.1 = 907.025 MHz
      const result = calculateLoRaFrequency(1, 21, 0, -0.1);
      expect(result).toBe('907.025 MHz');
    });

    it('should use default bandwidth when 0 is passed', () => {
      const result = calculateLoRaFrequency(1, 1, 0, 0, 0);
      expect(result).toBe('902.125 MHz'); // Same as default 250kHz
    });

    it('should treat channelNum 0 as slot 0 (hash algorithm default)', () => {
      // channelNum 0 means "use hash algorithm", which we default to slot 0
      const result = calculateLoRaFrequency(1, 0, 0, 0);
      expect(result).toBe('902.125 MHz');
    });
  });

  describe('Other regions', () => {
    it('should calculate frequency for CN region (region 4)', () => {
      // CN: freqStart = 470.0 MHz
      // channelNum 1 = slot 0: 470.0 + 0.125 = 470.125 MHz
      const result = calculateLoRaFrequency(4, 1, 0, 0);
      expect(result).toBe('470.125 MHz');
    });

    it('should calculate frequency for JP region (region 5)', () => {
      // JP: freqStart = 920.8 MHz
      // channelNum 1 = slot 0: 920.8 + 0.125 = 920.925 MHz
      const result = calculateLoRaFrequency(5, 1, 0, 0);
      expect(result).toBe('920.925 MHz');
    });

    it('should calculate frequency for LORA_24 region (region 13)', () => {
      // LORA_24: freqStart = 2400.0 MHz
      // channelNum 1 = slot 0: 2400.0 + 0.125 = 2400.125 MHz
      const result = calculateLoRaFrequency(13, 1, 0, 0);
      expect(result).toBe('2400.125 MHz');
    });
  });

  describe('Bandwidth variations', () => {
    it('should calculate correctly with 500kHz bandwidth', () => {
      // US region, channelNum 1 = slot 0, 500kHz BW
      // halfBwOffset = 0.25 MHz, spacing = 0.5 MHz
      // 902.0 + 0.25 = 902.25 MHz
      const result = calculateLoRaFrequency(1, 1, 0, 0, 500);
      expect(result).toBe('902.250 MHz');
    });

    it('should calculate correctly with 62.5kHz bandwidth', () => {
      // US region, channelNum 1 = slot 0, 62.5kHz BW
      // halfBwOffset = 0.03125 MHz, spacing = 0.0625 MHz
      // 902.0 + 0.03125 = 902.03125 MHz
      const result = calculateLoRaFrequency(1, 1, 0, 0, 62.5);
      expect(result).toBe('902.031 MHz');
    });
  });
});
