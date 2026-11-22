/** Parse the sender-names GET body (#6341 P4). One parser for every consumer. */
import type { UsableSenderNames } from './useMeshCore';

/** The `{enabled, allowedNames, firmwareSupported}` payload, or null when unreadable. */
export function parseUsableSenderNames(body: unknown): UsableSenderNames | null {
  const b = body as { success?: boolean; data?: Partial<UsableSenderNames> } | null;
  const d = b?.data;
  if (!b?.success || !d || typeof d.enabled !== 'boolean' || !Array.isArray(d.allowedNames)) return null;
  return {
    enabled: d.enabled,
    allowedNames: d.allowedNames.filter((n): n is string => typeof n === 'string'),
    firmwareSupported: d.firmwareSupported === true,
  };
}

/** Names a picker may show: empty when off, unsupported, or unreadable. */
export function pickableSenderNames(r: UsableSenderNames | null): string[] {
  return r && r.enabled && r.firmwareSupported ? r.allowedNames : [];
}
