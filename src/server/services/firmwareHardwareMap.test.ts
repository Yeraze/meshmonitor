/**
 * Firmware Hardware Map Service Tests
 *
 * Tests mapping of numeric hwModel enum values to firmware board names,
 * platform detection, OTA capability checks, and display name formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  getBoardName,
  getPlatformForBoard,
  isOtaCapable,
  getHardwareDisplayName,
} from './firmwareHardwareMap.js';

describe('firmwareHardwareMap', () => {
  describe('getBoardName', () => {
    it('should map HELTEC_V3 (43) to heltec-v3', () => {
      expect(getBoardName(43)).toBe('heltec-v3');
    });

    it('should map RAK4631 (9) to rak4631', () => {
      expect(getBoardName(9)).toBe('rak4631');
    });

    it('should map TBEAM (4) to tbeam via override', () => {
      expect(getBoardName(4)).toBe('tbeam');
    });

    it('should map LILYGO_TBEAM_S3_CORE (12) to tbeam-s3-core via override', () => {
      expect(getBoardName(12)).toBe('tbeam-s3-core');
    });

    it('should map TBEAM_V0P7 (6) to tbeam-v0p7 via override', () => {
      expect(getBoardName(6)).toBe('tbeam-v0p7');
    });

    it('should map T_ECHO (7) to t-echo via override', () => {
      expect(getBoardName(7)).toBe('t-echo');
    });

    it('should map T_ECHO_PLUS (33) to t-echo-plus via override', () => {
      expect(getBoardName(33)).toBe('t-echo-plus');
    });

    it('should map T_DECK (50) to t-deck via override', () => {
      expect(getBoardName(50)).toBe('t-deck');
    });

    it('should map T_WATCH_S3 (51) to t-watch-s3 via override', () => {
      expect(getBoardName(51)).toBe('t-watch-s3');
    });

    it('should map HELTEC_HT62 (53) to heltec-ht62-esp32c3-sx1262 via override', () => {
      expect(getBoardName(53)).toBe('heltec-ht62-esp32c3-sx1262');
    });

    it('should map SENSECAP_INDICATOR (70) to seeed-sensecap-indicator via override', () => {
      expect(getBoardName(70)).toBe('seeed-sensecap-indicator');
    });

    it('should map M5STACK (42) to m5stack-cores3 via override', () => {
      expect(getBoardName(42)).toBe('m5stack-cores3');
    });

    it('should map EBYTE_ESP32_S3 (54) to CDEBYTE_EoRa-S3 via override', () => {
      expect(getBoardName(54)).toBe('CDEBYTE_EoRa-S3');
    });

    it('should map STATION_G1 (25) to station-g1 via override', () => {
      expect(getBoardName(25)).toBe('station-g1');
    });

    it('should map STATION_G2 (31) to station-g2 via override', () => {
      expect(getBoardName(31)).toBe('station-g2');
    });

    it('should use default conversion for models without overrides', () => {
      // TLORA_V2 (1) -> tlora-v2
      expect(getBoardName(1)).toBe('tlora-v2');
      // HELTEC_V2_0 (5) -> heltec-v2-0
      expect(getBoardName(5)).toBe('heltec-v2-0');
      // HELTEC_WSL_V3 (44) -> heltec-wsl-v3
      expect(getBoardName(44)).toBe('heltec-wsl-v3');
    });

    it('should return null for UNSET (0)', () => {
      expect(getBoardName(0)).toBeNull();
    });

    it('should return null for ANDROID_SIM (38)', () => {
      expect(getBoardName(38)).toBeNull();
    });

    it('should return null for PORTDUINO (37)', () => {
      expect(getBoardName(37)).toBeNull();
    });

    it('should return null for unknown model numbers', () => {
      expect(getBoardName(99999)).toBeNull();
    });
  });

  describe('getPlatformForBoard', () => {
    it('should return esp32s3 for heltec-v3', () => {
      expect(getPlatformForBoard('heltec-v3')).toBe('esp32s3');
    });

    it('should return esp32 for tbeam', () => {
      expect(getPlatformForBoard('tbeam')).toBe('esp32');
    });

    it('should return nrf52840 for rak4631', () => {
      expect(getPlatformForBoard('rak4631')).toBe('nrf52840');
    });

    it('should return nrf52840 for t-echo', () => {
      expect(getPlatformForBoard('t-echo')).toBe('nrf52840');
    });

    it('should return esp32c3 for heltec-ht62-esp32c3-sx1262', () => {
      expect(getPlatformForBoard('heltec-ht62-esp32c3-sx1262')).toBe('esp32c3');
    });

    it('should return esp32s3 for tbeam-s3-core', () => {
      expect(getPlatformForBoard('tbeam-s3-core')).toBe('esp32s3');
    });

    it('should return esp32s3 for t-deck', () => {
      expect(getPlatformForBoard('t-deck')).toBe('esp32s3');
    });

    it('should return esp32s3 for station-g2', () => {
      expect(getPlatformForBoard('station-g2')).toBe('esp32s3');
    });

    it('should return rp2040 for rpi-pico', () => {
      expect(getPlatformForBoard('rpi-pico')).toBe('rp2040');
    });

    it('should return null for unknown board names', () => {
      expect(getPlatformForBoard('nonexistent-board')).toBeNull();
    });
  });

  describe('isOtaCapable', () => {
    it('should return true for esp32', () => {
      expect(isOtaCapable('esp32')).toBe(true);
    });

    it('should return true for esp32s3', () => {
      expect(isOtaCapable('esp32s3')).toBe(true);
    });

    it('should return true for esp32c3', () => {
      expect(isOtaCapable('esp32c3')).toBe(true);
    });

    it('should return true for esp32c6', () => {
      expect(isOtaCapable('esp32c6')).toBe(true);
    });

    it('should return false for nrf52840', () => {
      expect(isOtaCapable('nrf52840')).toBe(false);
    });

    it('should return false for rp2040', () => {
      expect(isOtaCapable('rp2040')).toBe(false);
    });

    it('should return false for unknown platforms', () => {
      expect(isOtaCapable('unknown')).toBe(false);
    });
  });

  describe('getHardwareDisplayName', () => {
    it('should return "Heltec V3" for hwModel 43', () => {
      expect(getHardwareDisplayName(43)).toBe('Heltec V3');
    });

    it('should return "RAK4631" for hwModel 9', () => {
      expect(getHardwareDisplayName(9)).toBe('RAK4631');
    });

    it('should return "TBeam" for hwModel 4', () => {
      expect(getHardwareDisplayName(4)).toBe('TBeam');
    });

    it('should return "T Echo" for hwModel 7', () => {
      expect(getHardwareDisplayName(7)).toBe('T Echo');
    });

    it('should return "T Deck" for hwModel 50', () => {
      expect(getHardwareDisplayName(50)).toBe('T Deck');
    });

    it('should return "Unknown" for unknown hwModel', () => {
      expect(getHardwareDisplayName(99999)).toBe('Unknown');
    });

    it('should return "Unknown" for UNSET (0)', () => {
      expect(getHardwareDisplayName(0)).toBe('Unknown');
    });
  });
});
