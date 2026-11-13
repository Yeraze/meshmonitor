/**
 * Node-name anti-spam sanitizer (#6382): constants shared by the server and
 * the Settings UI. Kept free of the RE2 import so the browser bundle can use
 * it.
 */

/** Settings keys. All four are global and admin-only. */
export const NODE_NAME_SANITIZE_ENABLED = 'nodeNameSanitizeEnabled';
export const NODE_NAME_SANITIZE_BUILTINS = 'nodeNameSanitizeBuiltins';
export const NODE_NAME_SANITIZE_CUSTOM_PATTERNS = 'nodeNameSanitizeCustomPatterns';
export const NODE_NAME_SANITIZE_PLACEHOLDER = 'nodeNameSanitizePlaceholder';

export const NODE_NAME_SANITIZE_KEYS = [
  NODE_NAME_SANITIZE_ENABLED,
  NODE_NAME_SANITIZE_BUILTINS,
  NODE_NAME_SANITIZE_CUSTOM_PATTERNS,
  NODE_NAME_SANITIZE_PLACEHOLDER,
] as const;

export const DEFAULT_NODE_NAME_PLACEHOLDER = '[spammer]';

/** Invite-link hosts the built-in rule strips when followed by `/`. */
export const BUILTIN_SPAM_HOSTS = [
  't.me',
  'telegram.me',
  'telegram.dog',
  'discord.gg',
  'wa.me',
  'chat.whatsapp.com',
] as const;

/** Longest custom pattern, in characters (same cap as the #5408 MeshCore rules). */
export const MAX_CUSTOM_PATTERN_LENGTH = 256;
/** Most custom patterns an admin may store. */
export const MAX_CUSTOM_PATTERNS = 50;
/** Longest placeholder, in UTF-8 bytes: it must fit a fw 2.8 long name. */
export const MAX_PLACEHOLDER_BYTES = 24;

/**
 * Meshtastic long_name limits: fw 2.8 clamps to 24 bytes, older firmware to
 * 39 (nanopb max_size 40 minus the NUL). short_name is 4 bytes. A MeshCore
 * advert name lives in a 32-byte field, so 31 usable bytes.
 */
export const MESHTASTIC_LONG_NAME_MIN_LIMIT = 24;
export const MESHTASTIC_LONG_NAME_MAX_LIMIT = 39;
export const MESHTASTIC_SHORT_NAME_LIMIT = 4;
export const MESHCORE_NAME_LIMIT = 31;

/** Parse the stored custom-pattern list (a JSON array of strings). */
export function parseCustomPatternList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  } catch {
    return [];
  }
}

/** UTF-8 byte length. */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
