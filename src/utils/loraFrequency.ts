/**
 * Calculate LoRa frequency from region, channel number, and bandwidth
 *
 * Uses the official Meshtastic formula from RadioInterface.cpp:
 *   freq = freqStart + (bw / 2000) + (channel_num * (bw / 1000))
 *
 * Where:
 * - freqStart: Region's starting frequency (MHz)
 * - bw: Bandwidth in kHz (e.g., 250 for LongFast, 125 for LongSlow)
 * - channel_num: Frequency slot (0-based)
 *
 * References:
 * - https://github.com/meshtastic/firmware/blob/master/src/mesh/RadioInterface.cpp
 * - https://meshtastic.org/docs/overview/radio-settings/
 *
 * @param region - Region code (1=US, 2=EU_433, 3=EU_868, etc.)
 * @param channelNum - Channel number (frequency slot, 0-based)
 * @param overrideFrequency - Override frequency in MHz (takes precedence if > 0)
 * @param frequencyOffset - Frequency offset in MHz to add to calculated frequency
 * @param bandwidth - Bandwidth in kHz (default 250 for LongFast preset)
 * @returns Formatted frequency string (e.g., "906.875 MHz") or "Unknown"/"Invalid channel"
 */
export function calculateLoRaFrequency(
  region: number,
  channelNum: number,
  overrideFrequency: number,
  frequencyOffset: number,
  bandwidth: number = 250 // Default to LongFast preset (250 kHz)
): string {
  // If overrideFrequency is set (non-zero), use it (takes precedence over calculated frequency)
  if (overrideFrequency && overrideFrequency > 0) {
    const freq = overrideFrequency + (frequencyOffset || 0);
    return `${freq.toFixed(3)} MHz`;
  }

  // Region frequency bounds from Meshtastic firmware RadioInterface.cpp
  // Format: region -> [freqStart (MHz), freqEnd (MHz)]
  // Reference: RDEF macros in RadioInterface.cpp
  const regionFrequencyBounds: { [key: number]: [number, number] } = {
    1: [902.0, 928.0],      // US: 902-928 MHz (FCC Part 15)
    2: [433.0, 434.0],      // EU_433: 433-434 MHz
    3: [869.4, 869.65],     // EU_868: 869.4-869.65 MHz (EN300220)
    4: [470.0, 510.0],      // CN: 470-510 MHz
    5: [920.8, 923.8],      // JP: 920.8-923.8 MHz
    6: [915.0, 928.0],      // ANZ: 915-928 MHz
    7: [920.0, 923.0],      // KR: 920-923 MHz
    8: [920.0, 925.0],      // TW: 920-925 MHz
    9: [433.0, 434.79],     // RU: 433-434.79 MHz
    10: [865.0, 867.0],     // IN: 865-867 MHz
    11: [864.0, 868.0],     // NZ_865: 864-868 MHz
    12: [920.0, 925.0],     // TH: 920-925 MHz
    13: [2400.0, 2483.5],   // LORA_24: 2.4 GHz ISM
    14: [433.0, 434.79],    // UA_433: 433-434.79 MHz
    15: [868.0, 868.6],     // UA_868: 868-868.6 MHz
    16: [433.0, 435.0],     // MY_433: 433-435 MHz
    17: [919.0, 924.0],     // MY_919: 919-924 MHz
    18: [920.0, 925.0],     // SG_923: 920-925 MHz
    19: [433.0, 435.0],     // PH_433: 433-435 MHz
    20: [868.0, 868.6],     // PH_868: 868-868.6 MHz
    21: [915.0, 928.0],     // PH_915: 915-928 MHz
    22: [433.0, 435.0],     // ANZ_433: 433-435 MHz
    23: [433.0, 435.0],     // KZ_433: 433-435 MHz
    24: [864.0, 865.0],     // KZ_863: 864-865 MHz (Note: region is named KZ_863 but uses 864-865)
    25: [865.0, 867.0],     // NP_865: 865-867 MHz
    26: [902.0, 907.5]      // BR_902: 902-907.5 MHz
  };

  if (!region || region === 0) {
    return 'Unknown';
  }

  const bounds = regionFrequencyBounds[region];
  if (!bounds) {
    return 'Unknown';
  }

  const [freqStart, freqEnd] = bounds;

  // Use bandwidth in kHz, default to 250 kHz (LongFast)
  const bw = bandwidth > 0 ? bandwidth : 250;

  // Calculate channel spacing based on bandwidth (bw is in kHz)
  const channelSpacing = bw / 1000; // Convert to MHz

  // Calculate maximum number of channels that fit in the frequency range
  const maxChannels = Math.floor((freqEnd - freqStart) / channelSpacing);

  // Validate channel number
  if (channelNum < 0 || channelNum >= maxChannels) {
    return 'Invalid channel';
  }

  // Official Meshtastic formula from RadioInterface.cpp:
  // freq = freqStart + (bw / 2000) + (channel_num * (bw / 1000))
  const halfBwOffset = bw / 2000; // Half bandwidth in MHz
  const calculatedFreq = freqStart + halfBwOffset + (channelNum * channelSpacing) + (frequencyOffset || 0);

  return `${calculatedFreq.toFixed(3)} MHz`;
}
