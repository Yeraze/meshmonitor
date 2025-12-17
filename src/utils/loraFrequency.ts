/**
 * Calculate LoRa frequency from region and channel number (frequency slot)
 *
 * Meshtastic uses dynamic frequency slots based on:
 * - Region (defines the ISM band, e.g., 902-928 MHz for US)
 * - Bandwidth (125kHz, 250kHz, 500kHz) - affects number of available slots
 * - Channel number (frequency slot) - determines the specific frequency
 *
 * Frequency spacing is determined by bandwidth: narrower bandwidth allows more slots.
 * For US region with LongFast preset (250kHz BW): 104 slots with 0.25 MHz spacing
 *
 * References:
 * - https://meshtastic.org/docs/overview/radio-settings/
 * - https://meshtastic.org/docs/settings/channel
 *
 * @param region - Region code (1=US, 2=EU_433, 3=EU_868, etc.)
 * @param channelNum - Channel number (frequency slot, 0-based)
 * @param overrideFrequency - Override frequency in MHz (takes precedence if > 0)
 * @param frequencyOffset - Frequency offset in MHz to add to calculated frequency
 * @returns Formatted frequency string (e.g., "906.875 MHz") or "Unknown"/"Invalid channel"
 */
export function calculateLoRaFrequency(
  region: number,
  channelNum: number,
  overrideFrequency: number,
  frequencyOffset: number
): string {
  // If overrideFrequency is set (non-zero), use it (takes precedence over calculated frequency)
  if (overrideFrequency && overrideFrequency > 0) {
    const freq = overrideFrequency + (frequencyOffset || 0);
    return `${freq.toFixed(3)} MHz`;
  }

  // Frequency lookup table for Meshtastic frequency slots
  // Format: region -> [baseFreq (MHz), slotSpacing (MHz), maxSlots]
  // Note: Spacing depends on bandwidth - these values are for common presets (typically 250kHz BW)
  // References: https://meshtastic.org/docs/overview/radio-settings/
  // US region: 104 slots (0-103) for 250kHz BW, verified: slot 18=906.375, slot 20=906.875 (LongFast)
  // EU_433: 5 slots (0-4) for LongFast, default slot 4 = 433.875 MHz (band: 433-434 MHz)
  // EU_868: 2 slots (0-1) for LongFast, default slot 1 = 869.525 MHz (band: 869.40-869.65 MHz)
  const regionFrequencyParams: { [key: number]: [number, number, number] } = {
    1: [901.875, 0.25, 104],   // US: 901.875-927.875 MHz, 104 slots (250kHz BW), spacing=0.25 MHz
    2: [433.075, 0.2, 5],      // EU_433: 433-434 MHz, 5 slots (0-4) with LongFast, default slot 4=433.875 MHz
    3: [869.325, 0.2, 2],      // EU_868: 869.40-869.65 MHz, 2 slots (0-1) with LongFast, default slot 1=869.525 MHz
    4: [470.0, 0.2, 95],      // CN: 470.0-489.8 MHz, 95 channels
    5: [920.6, 0.2, 15],      // JP: 920.6-923.4 MHz, 15 channels
    6: [915.0, 0.2, 72],      // ANZ: 915.0-927.8 MHz, 72 channels
    7: [920.9, 0.2, 15],      // KR: 920.9-923.7 MHz, 15 channels
    8: [920.6, 0.2, 15],      // TW: 920.6-923.4 MHz, 15 channels
    9: [433.175, 0.2, 7],     // RU: 433.175-434.575 MHz, 7 channels
    10: [865.0625, 0.2, 15],  // IN: 865.0625-867.8625 MHz, 15 channels
    11: [865.0, 0.2, 15],     // NZ_865: 865.0-867.8 MHz, 15 channels
    12: [920.6, 0.2, 15],     // TH: 920.6-923.4 MHz, 15 channels
    13: [2400.0, 0.2, 15],    // LORA_24: 2400.0-2402.8 MHz, 15 channels
    14: [433.175, 0.2, 7],    // UA_433: 433.175-434.575 MHz, 7 channels
    15: [863.275, 0.2, 7],    // UA_868: 863.275-864.575 MHz, 7 channels
    16: [433.175, 0.2, 7],    // MY_433: 433.175-434.575 MHz, 7 channels
    17: [919.0, 0.2, 15],     // MY_919: 919.0-921.8 MHz, 15 channels
    18: [923.0, 0.2, 15],     // SG_923: 923.0-925.8 MHz, 15 channels
    19: [433.175, 0.2, 7],    // PH_433: 433.175-434.575 MHz, 7 channels
    20: [863.275, 0.2, 7],    // PH_868: 863.275-864.575 MHz, 7 channels
    21: [915.0, 0.2, 72],     // PH_915: 915.0-927.8 MHz, 72 channels
    22: [433.175, 0.2, 7],    // ANZ_433: 433.175-434.575 MHz, 7 channels
    23: [433.175, 0.2, 7],    // KZ_433: 433.175-434.575 MHz, 7 channels
    24: [863.0, 0.2, 7],      // KZ_863: 863.0-864.4 MHz, 7 channels
    25: [865.0, 0.2, 15],     // NP_865: 865.0-867.8 MHz, 15 channels
    26: [902.0, 0.2, 72]      // BR_902: 902.0-914.8 MHz, 72 channels
  };

  if (!region || region === 0) {
    return 'Unknown';
  }

  const params = regionFrequencyParams[region];
  if (!params) {
    return 'Unknown';
  }

  const [baseFreq, channelSpacing, maxChannels] = params;

  // Validate channel number
  if (channelNum < 0 || channelNum >= maxChannels) {
    return 'Invalid channel';
  }

  // Calculate frequency: baseFreq + (channelNum * channelSpacing) + frequencyOffset
  const calculatedFreq = baseFreq + (channelNum * channelSpacing) + (frequencyOffset || 0);
  return `${calculatedFreq.toFixed(3)} MHz`;
}

