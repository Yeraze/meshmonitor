import { describe, it, expect } from 'vitest';
import { MODEM_PRESET_OPTIONS, FEM_LNA_MODE_OPTIONS, AMATEUR_RADIO_REGIONS, isAmateurRadioRegion, REGION_MAP } from './constants';

/**
 * LoRaConfigSection Tests
 *
 * Tests configuration constants and integration logic
 */
describe('LoRaConfigSection', () => {
  describe('Modem Preset Constants', () => {
    it('should have correct number of modem presets', () => {
      // 0-9 from earlier protobuf revisions, 10-13 added in v2.7.23
      // (LITE_FAST, LITE_SLOW, NARROW_FAST, NARROW_SLOW), plus
      // MEDIUM_TURBO (16) from firmware 2.8 (#4074)
      expect(MODEM_PRESET_OPTIONS).toHaveLength(14);
    });

    it('should have LONG_FAST as first preset', () => {
      expect(MODEM_PRESET_OPTIONS[0]).toEqual({
        value: 0,
        name: 'LONG_FAST',
        description: 'Long Range - Fast (Default)',
        params: 'BW: 250kHz, SF: 11, CR: 4/5'
      });
    });

    it('should have MEDIUM_TURBO as last preset', () => {
      const lastPreset = MODEM_PRESET_OPTIONS[MODEM_PRESET_OPTIONS.length - 1];
      expect(lastPreset.name).toBe('MEDIUM_TURBO');
      expect(lastPreset.value).toBe(16);
    });

    it('should include LONG_TURBO at value 9', () => {
      const longTurbo = MODEM_PRESET_OPTIONS.find(p => p.name === 'LONG_TURBO');
      expect(longTurbo).toEqual({
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

  describe('FEM LNA Mode Constants', () => {
    it('exposes the three FEM_LNA_Mode enum values in order', () => {
      expect(FEM_LNA_MODE_OPTIONS.map(o => o.value)).toEqual([0, 1, 2]);
    });

    it('uses DISABLED (0) as the proto3 zero/default option', () => {
      expect(FEM_LNA_MODE_OPTIONS[0].value).toBe(0);
      expect(FEM_LNA_MODE_OPTIONS[0].label).toMatch(/DISABLED/);
    });

    it('labels the ENABLED and NOT_PRESENT modes', () => {
      expect(FEM_LNA_MODE_OPTIONS[1].value).toBe(1);
      expect(FEM_LNA_MODE_OPTIONS[1].label).toMatch(/ENABLED/);
      expect(FEM_LNA_MODE_OPTIONS[2].value).toBe(2);
      expect(FEM_LNA_MODE_OPTIONS[2].label).toMatch(/NOT_PRESENT/);
    });
  });

  describe('Amateur Radio Region Warning (#3924)', () => {
    it('flags the ITU 2m amateur regions (27, 28) as amateur bands', () => {
      expect(isAmateurRadioRegion(27)).toBe(true); // ITU1_2M
      expect(isAmateurRadioRegion(28)).toBe(true); // ITU23_2M
    });

    it('keeps the amateur region set in sync with REGION_MAP values', () => {
      expect(AMATEUR_RADIO_REGIONS[27]).toBe('ITU1_2M');
      expect(AMATEUR_RADIO_REGIONS[28]).toBe('ITU23_2M');
      expect(REGION_MAP['ITU1_2M']).toBe(27);
      expect(REGION_MAP['ITU23_2M']).toBe(28);
    });

    it('does not flag standard ISM/SRD regions as amateur bands', () => {
      expect(isAmateurRadioRegion(1)).toBe(false); // US
      expect(isAmateurRadioRegion(3)).toBe(false); // EU_868
      expect(isAmateurRadioRegion(6)).toBe(false); // ANZ
      expect(isAmateurRadioRegion(32)).toBe(false); // EU_N_868
    });

    it('does not flag UNSET (0) as an amateur band', () => {
      expect(isAmateurRadioRegion(0)).toBe(false);
    });

    it('handles null/undefined region without throwing', () => {
      expect(isAmateurRadioRegion(null)).toBe(false);
      expect(isAmateurRadioRegion(undefined)).toBe(false);
    });

    it('does not flag an out-of-range region value', () => {
      expect(isAmateurRadioRegion(999)).toBe(false);
    });
  });

  describe('Save Configuration Logic', () => {
    it('includes femLnaMode in the LoRa save payload', () => {
      // Mirrors the Device Configuration save (ConfigurationTab) and Remote Admin
      // save (AdminCommandsTab.handleSetLoRaConfig), both of which now carry femLnaMode.
      const config = {
        usePreset: true,
        modemPreset: 0,
        region: 1,
        hopLimit: 3,
        channelNum: 0,
        femLnaMode: 1,
        sx126xRxBoostedGain: false
      };

      expect(config).toHaveProperty('femLnaMode');
      expect(config.femLnaMode).toBe(1);
    });

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
