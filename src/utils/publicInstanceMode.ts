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

/** True when `s` is exactly the placeholder the server puts in hidden text. */
export function isPublicHiddenText(s: unknown): boolean {
  return s === PUBLIC_INSTANCE_HIDDEN_TEXT;
}

/**
 * Position precision a viewer should use. A redacted viewer gets the stored
 * bits when they are already coarse (1..13), else the public cap (14), so a
 * node with missing or full precision still gets an accuracy cell and offset.
 */
export function viewerPrecisionBits(
  bits: number | null | undefined,
  coarse: boolean
): number | null | undefined {
  if (!coarse) return bits;
  return typeof bits === 'number' && bits >= 1 && bits <= 13 ? bits : PUBLIC_INSTANCE_PRECISION_BITS;
}

/**
 * True for a MeshCore key the server cut to its public prefix (#5156). Such a
 * key cannot address a node, so a request built from it only returns a 400.
 * Meshtastic ids (`!aabbccdd`, decimal nodeNums of at most 10 digits) never match.
 */
export function isTruncatedPublicKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.length === MESHCORE_ID_PREFIX_HEX && /^[0-9a-fA-F]+$/.test(key);
}
