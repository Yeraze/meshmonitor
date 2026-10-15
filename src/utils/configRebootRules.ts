/**
 * Which Meshtastic config saves make the node reboot (#5823).
 *
 * Read from the firmware's `src/modules/AdminModule.cpp` at v2.7.9, v2.7.20,
 * v2.7.26, v2.8.0 and v2.8.1. `handleSetConfig`, `handleSetModuleConfig` and
 * `handleSetOwner` end in `saveChanges(…, shouldReboot = true)` unless a case
 * clears the flag, and the node then reboots about 7 s later
 * (`DEFAULT_REBOOT_SECONDS`). A `begin`/`commit_edit_settings` transaction
 * only moves the reboot to the commit. `set_fixed_position` and
 * `remove_fixed_position` never reboot.
 *
 * - `always`:   the node reboots after every save.
 * - `possible`: it reboots only when certain fields change. We do not compare
 *               fields; the UI says the node *may* restart.
 * - `never`:    the save applies live.
 *
 * Every Device Configuration save goes through `rebootExpectation()`, so a new
 * section only needs a row here.
 */
import { isFirmwareAtLeast } from './firmwareVersion.js';

export type RebootExpectation = 'always' | 'possible' | 'never';

export type ConfigSaveSection =
  // Config (handleSetConfig) and owner (handleSetOwner)
  | 'owner'
  | 'device'
  | 'position'
  | 'power'
  | 'network'
  | 'display'
  | 'lora'
  | 'bluetooth'
  | 'security'
  // ModuleConfig (handleSetModuleConfig)
  | 'mqtt'
  | 'serial'
  | 'extnotif'
  | 'storeforward'
  | 'rangetest'
  | 'telemetry'
  | 'cannedmsg'
  | 'audio'
  | 'remotehardware'
  | 'neighborinfo'
  | 'ambientlighting'
  | 'detectionsensor'
  | 'paxcounter'
  | 'statusmessage'
  | 'trafficmanagement'
  | 'tak'
  | 'meshbeacon';

interface RebootRule {
  /** Behaviour on firmware older than 2.8.0, or when the version is unknown. */
  before28: RebootExpectation;
  /** Behaviour on firmware 2.8.0 and later. */
  from28: RebootExpectation;
}

const same = (e: RebootExpectation): RebootRule => ({ before28: e, from28: e });

export const CONFIG_REBOOT_RULES: Readonly<Record<ConfigSaveSection, RebootRule>> = {
  // Reboots if any owner field changed.
  owner: same('possible'),
  // Reboots if button_gpio, buzzer_gpio, role or rebroadcast_mode changed.
  device: same('possible'),
  position: same('always'),
  // Reboots if a power-saving or sleep field changed.
  power: same('possible'),
  network: same('always'),
  // Reboots if screen_on_secs, flip_screen, oled or displaymode changed.
  display: same('possible'),
  // 2.7.x reboots when a radio field changed; 2.8.0+ applies every LoRa change
  // live through reconfigure(). We signal on every 2.7.x save, as before.
  lora: { before28: 'always', from28: 'never' },
  bluetooth: same('always'),
  // 2.7.x reboots only if debug_log_api_enabled or serial_enabled changed;
  // 2.8.1 always does. Treated as always on both.
  security: same('always'),

  mqtt: same('always'),
  serial: same('always'),
  extnotif: same('always'),
  storeforward: same('always'),
  rangetest: same('always'),
  telemetry: same('always'),
  cannedmsg: same('always'),
  audio: same('always'),
  remotehardware: same('always'),
  neighborinfo: same('always'),
  ambientlighting: same('always'),
  detectionsensor: same('always'),
  paxcounter: same('always'),
  // Clears shouldReboot on every firmware that has it (2.7.20+).
  statusmessage: same('never'),
  trafficmanagement: same('always'),
  tak: same('always'),
  // 2.8.0+ only; clears shouldReboot.
  meshbeacon: same('never'),
};

/**
 * What a successful save of `section` does to the node running
 * `firmwareVersion`. An unknown version reads as pre-2.8, which can only
 * over-warn, never miss a reboot.
 */
export function rebootExpectation(
  section: ConfigSaveSection,
  firmwareVersion: string | null | undefined,
): RebootExpectation {
  const rule = CONFIG_REBOOT_RULES[section];
  return isFirmwareAtLeast(firmwareVersion, 2, 8, 0) ? rule.from28 : rule.before28;
}
