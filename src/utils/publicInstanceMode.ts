/**
 * Public-instance mode (epic #5156): shared constants and config parsing.
 * Pure, no I/O. Shared by the server redactor and the Phase 3 frontend.
 */

export const PUBLIC_INSTANCE_SETTING_KEYS = {
  enabled: 'publicInstanceModeEnabled',
  hideLongNames: 'publicInstanceHideLongNames',
  hidePublicKeys: 'publicInstanceHidePublicKeys',
  roundTimestamps: 'publicInstanceRoundTimestamps',
  hideMessageText: 'publicInstanceHideMessageText',
} as const;

export interface RedactionConfig {
  /** Master switch. Everything below applies only when this is true. */
  enabled: boolean;
  hideLongNames: boolean;
  hidePublicKeys: boolean;
  roundTimestamps: boolean;
  hideMessageText: boolean;
}

/** Position precision (bits) that anonymous viewers get at most. ~1.4 km cell. */
export const PUBLIC_INSTANCE_PRECISION_BITS = 14;

/** Hex chars kept of a 64-hex MeshCore key (its 6-byte pubkey_prefix). */
export const MESHCORE_ID_PREFIX_HEX = 12;

/** Placeholder that replaces hidden message text. */
export const PUBLIC_INSTANCE_HIDDEN_TEXT = '[hidden on this public instance]';

type RawSettings = Partial<Record<string, string | null | undefined>>;

const isOn = (v: string | null | undefined): boolean => v === '1' || v === 'true';
const notOff = (v: string | null | undefined): boolean => !(v === '0' || v === 'false');

/** Master is default-off (opt-in); sub-toggles are default-on (opt-out). */
export function parsePublicInstanceConfig(raw: RawSettings | null | undefined): RedactionConfig {
  const r = raw ?? {};
  const k = PUBLIC_INSTANCE_SETTING_KEYS;
  return {
    enabled: isOn(r[k.enabled]),
    hideLongNames: notOff(r[k.hideLongNames]),
    hidePublicKeys: notOff(r[k.hidePublicKeys]),
    roundTimestamps: notOff(r[k.roundTimestamps]),
    hideMessageText: notOff(r[k.hideMessageText]),
  };
}
