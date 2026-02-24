/**
 * Hardware image utility
 * Maps hardware model IDs to their device images from Meshtastic web-flasher
 * Image source: https://github.com/meshtastic/web-flasher/tree/main/public/img/devices
 * Data source: https://github.com/meshtastic/web-flasher/blob/main/public/data/hardware-list.json
 */

const HARDWARE_IMAGES: Record<number, string | null> = {
  1: null,
  2: null,
  3: 'tlora-v2-1-1_6.svg',
  4: 'tbeam.svg',
  5: null,
  6: null,
  7: 't-echo.svg',
  8: null,
  9: 'rak4631.svg',
  10: null,
  11: null,
  12: 'tbeam-s3-core.svg',
  13: 'rak11200.svg',
  14: null,
  15: 'tlora-v2-1-1_8.svg',
  16: 'tlora-t3s3-epaper.svg',
  17: null,
  18: 'nano-g2-ultra.svg',
  19: null,
  20: null,
  21: 'wio-tracker-wm1110.svg',
  22: 'rak2560.svg',
  23: null,
  24: null,
  25: null,
  26: 'rak11310.svg',
  27: null,
  28: null,
  29: null,
  30: null,
  31: 'station-g2.svg',
  32: null,
  33: null,
  34: null,
  35: null,
  36: null,
  37: null,
  38: null,
  39: null,
  40: null,
  41: null,
  42: null,
  43: 'heltec-v3.svg',
  44: 'heltec-wsl-v3.svg',
  45: null,
  46: null,
  47: 'rpipicow.svg',
  48: 'heltec-wireless-tracker.svg',
  49: 'heltec-wireless-paper.svg',
  50: 't-deck.svg',
  51: 't-watch-s3.svg',
  52: null,
  53: 'heltec-ht62-esp32c3-sx1262.svg',
  54: null,
  55: null,
  56: null,
  57: 'heltec-wireless-paper-v1_0.svg',
  58: null,
  59: null,
  60: null,
  61: null,
  62: null,
  63: 'promicro.svg',
  64: null,
  65: null,
  66: 'heltec-vision-master-t190.svg',
  67: 'heltec-vision-master-e213.svg',
  68: 'heltec-vision-master-e290.svg',
  69: 'heltec-mesh-node-t114.svg',
  70: 'seeed-sensecap-indicator.svg',
  71: 'tracker-t1000-e.svg',
  72: null,
  73: null,
  74: null,
  75: null,
  76: null,
  77: null,
  78: null,
  79: null,
  80: null,
  81: 'seeed-xiao-s3.svg',
  82: null,
  83: null,
  84: 'rak-wismeshtap.svg',
  85: null,
  86: null,
  87: null,
  88: 'seeed_xiao_nrf52_kit.svg',
  89: 'thinknode_m1.svg',
  90: 'thinknode_m2.svg',
  91: null,
  92: null,
  93: null,
  94: 'heltec_mesh_pocket.svg',
  95: 'seeed_solar.svg',
  96: 'meteor_pro.svg',
  97: 'crowpanel_3_5.svg',
  98: null,
  99: 'wio_tracker_l1_case.svg',
  100: 'wio_tracker_l1_eink.svg',
  101: 'muzi_r1_neo.svg',
  102: 'tdeck_pro.svg',
  103: 'lilygo-tlora-pager.svg',
  104: null,
  105: 'rak_wismesh_tag.svg',
  106: 'rak_3312.svg',
  107: 'thinknode_m1.svg',
  108: 'heltec-mesh-solar.svg',
  109: 'techo_lite.svg',
  110: 'heltec_v4.svg',
  111: 'm5_c6l.svg',
  112: null,
  113: null,
  114: null,
  115: null,
};

const BASE_IMAGE_URL = 'https://raw.githubusercontent.com/meshtastic/web-flasher/main/public/img/devices/';

/**
 * Get hardware image URL for a given hardware model
 * @param hwModel - Numeric hardware model ID
 * @returns Image URL if available, null otherwise
 */
export function getHardwareImageUrl(hwModel: number | undefined): string | null {
  if (hwModel === undefined || hwModel === null) {
    return null;
  }

  const imageName = HARDWARE_IMAGES[hwModel];
  if (!imageName) {
    return null;
  }

  return `${BASE_IMAGE_URL}${imageName}`;
}

/**
 * Check if hardware model has an image available
 * @param hwModel - Numeric hardware model ID
 * @returns True if image is available, false otherwise
 */
export function hasHardwareImage(hwModel: number | undefined): boolean {
  if (hwModel === undefined || hwModel === null) {
    return false;
  }
  return HARDWARE_IMAGES[hwModel] !== null && HARDWARE_IMAGES[hwModel] !== undefined;
}
