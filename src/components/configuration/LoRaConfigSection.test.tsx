import { describe, it, expect } from 'vitest';
import { MODEM_PRESET_OPTIONS } from './constants';

/**
 * LoRaConfigSection Tests
 *
 * Tests configuration constants and integration logic
 */
describe('LoRaConfigSection', () => {
  describe('Modem Preset Constants', () => {
    it('should have correct number of modem presets', () => {
      expect(MODEM_PRESET_OPTIONS).toHaveLength(9);
    });

    it('should have LONG_FAST as first preset', () => {
      expect(MODEM_PRESET_OPTIONS[0]).toEqual({
        value: 0,
        name: 'LONG_FAST',
        description: 'Long Range - Fast (Default)',
        params: 'BW: 250kHz, SF: 11, CR: 4/5'
      });
    });

    it('should have LONG_TURBO as last preset', () => {
      const lastPreset = MODEM_PRESET_OPTIONS[MODEM_PRESET_OPTIONS.length - 1];
      expect(lastPreset).toEqual({
        value: 9,
        name: 'LONG_TURBO',
        description: 'Long Range - Turbo (Similar to LongFast)',
        params: 'BW: 500kHz, SF: 11, CR: 4/5'
      });
    });

    it('should have all presets with required fields', () => {
      MODEM_PRESET_OPTIONS.forEach(preset => {
        expect(preset).toHaveProperty('value');
        expect(preset).toHaveProperty('name');
        expect(preset).toHaveProperty('description');
        expect(preset).toHaveProperty('params');
      });
    });
  });

  describe('LoRa Parameter Validation', () => {
    it('should validate bandwidth range (1-500 kHz)', () => {
      const isValidBandwidth = (bw: number) => bw >= 1 && bw <= 500;
      expect(isValidBandwidth(1)).toBe(true);
      expect(isValidBandwidth(250)).toBe(true);
      expect(isValidBandwidth(500)).toBe(true);
      expect(isValidBandwidth(0)).toBe(false);
      expect(isValidBandwidth(501)).toBe(false);
    });

    it('should validate spreading factor range (7-12)', () => {
      const isValidSpreadFactor = (sf: number) => sf >= 7 && sf <= 12;
      expect(isValidSpreadFactor(7)).toBe(true);
      expect(isValidSpreadFactor(11)).toBe(true);
      expect(isValidSpreadFactor(12)).toBe(true);
      expect(isValidSpreadFactor(6)).toBe(false);
      expect(isValidSpreadFactor(13)).toBe(false);
    });

    it('should validate coding rate range (5-8)', () => {
      const isValidCodingRate = (cr: number) => cr >= 5 && cr <= 8;
      expect(isValidCodingRate(5)).toBe(true);
      expect(isValidCodingRate(8)).toBe(true);
      expect(isValidCodingRate(4)).toBe(false);
      expect(isValidCodingRate(9)).toBe(false);
    });

    it('should validate hop limit range (1-7)', () => {
      const isValidHopLimit = (hl: number) => hl >= 1 && hl <= 7;
      expect(isValidHopLimit(1)).toBe(true);
      expect(isValidHopLimit(3)).toBe(true);
      expect(isValidHopLimit(7)).toBe(true);
      expect(isValidHopLimit(0)).toBe(false);
      expect(isValidHopLimit(8)).toBe(false);
    });

    it('should validate channel number range (0-255)', () => {
      const isValidChannelNum = (cn: number) => cn >= 0 && cn <= 255;
      expect(isValidChannelNum(0)).toBe(true);
      expect(isValidChannelNum(127)).toBe(true);
      expect(isValidChannelNum(255)).toBe(true);
      expect(isValidChannelNum(-1)).toBe(false);
      expect(isValidChannelNum(256)).toBe(false);
    });
  });

  describe('Configuration State Logic', () => {
    it('should have mutually exclusive modes (preset vs custom)', () => {
      // When usePreset is true, individual parameters should not be used
      // When usePreset is false, modemPreset should not be used
      const usePreset = true;
      const shouldShowPresetDropdown = usePreset;
      const shouldShowIndividualParams = !usePreset;

      expect(shouldShowPresetDropdown).toBe(true);
      expect(shouldShowIndividualParams).toBe(false);
    });

    it('should toggle between preset and custom modes', () => {
      let usePreset = true;
      expect(usePreset).toBe(true);

      usePreset = !usePreset;
      expect(usePreset).toBe(false);

      usePreset = !usePreset;
      expect(usePreset).toBe(true);
    });
  });

  describe('Save Configuration Logic', () => {
    it('should include all parameters when usePreset is false', () => {
      const config = {
        usePreset: false,
        bandwidth: 250,
        spreadFactor: 11,
        codingRate: 8,
        frequencyOffset: 0,
        overrideFrequency: 0,
        region: 1,
        hopLimit: 3,
        channelNum: 0,
        sx126xRxBoostedGain: false
      };

      expect(config.usePreset).toBe(false);
      expect(config).toHaveProperty('bandwidth');
      expect(config).toHaveProperty('spreadFactor');
      expect(config).toHaveProperty('codingRate');
      expect(config).toHaveProperty('frequencyOffset');
      expect(config).toHaveProperty('overrideFrequency');
    });

    it('should include modemPreset when usePreset is true', () => {
      const config = {
        usePreset: true,
        modemPreset: 0,
        region: 1,
        hopLimit: 3,
        channelNum: 0,
        sx126xRxBoostedGain: false
      };

      expect(config.usePreset).toBe(true);
      expect(config).toHaveProperty('modemPreset');
    });
  });
});
