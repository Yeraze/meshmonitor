/**
 * Per-source policy for the MeshCore `senderName` override (#6282).
 *
 * Stored as one per-source setting, `meshcoreSenderNameOverride`, a JSON string
 * `{"enabled":boolean,"allowedNames":string[]}`. Default (missing or garbled):
 * off, empty list. A caller needs its normal send grants AND a name on this
 * list. Editing the list needs `configuration:write` on the source.
 */
import databaseService from '../../services/database.js';
import {
  SENDER_NAME_ALLOWLIST_MAX,
  normalizeSenderName,
  validateMeshcoreSenderName,
} from './meshcoreSenderName.js';

export const SENDER_NAME_POLICY_SETTING_KEY = 'meshcoreSenderNameOverride';

export interface SenderNamePolicy {
  enabled: boolean;
  allowedNames: string[];
}

export const DEFAULT_SENDER_NAME_POLICY: SenderNamePolicy = { enabled: false, allowedNames: [] };

/** Never throws; anything unreadable is the safe default (off). */
export function parseSenderNamePolicy(raw: string | null | undefined): SenderNamePolicy {
  if (!raw) return { ...DEFAULT_SENDER_NAME_POLICY, allowedNames: [] };
  try {
    const v = JSON.parse(raw) as { enabled?: unknown; allowedNames?: unknown };
    const names: string[] = [];
    if (Array.isArray(v.allowedNames)) {
      for (const n of v.allowedNames) {
        const r = validateMeshcoreSenderName(n);
        if (r.ok && !names.includes(r.name)) names.push(r.name);
        if (names.length >= SENDER_NAME_ALLOWLIST_MAX) break;
      }
    }
    return { enabled: v.enabled === true, allowedNames: names };
  } catch {
    return { ...DEFAULT_SENDER_NAME_POLICY, allowedNames: [] };
  }
}

export type PolicyValidation =
  | { ok: true; policy: SenderNamePolicy }
  | { ok: false; message: string };

/** Strict validation for a write (the route returns 400 on failure). */
export function validateSenderNamePolicyInput(input: unknown): PolicyValidation {
  if (!input || typeof input !== 'object') return { ok: false, message: 'Body must be an object' };
  const { enabled, allowedNames } = input as { enabled?: unknown; allowedNames?: unknown };
  if (typeof enabled !== 'boolean') return { ok: false, message: 'enabled must be a boolean' };
  if (!Array.isArray(allowedNames)) return { ok: false, message: 'allowedNames must be an array' };
  if (allowedNames.length > SENDER_NAME_ALLOWLIST_MAX) {
    return { ok: false, message: `At most ${SENDER_NAME_ALLOWLIST_MAX} names are allowed` };
  }
  const names: string[] = [];
  for (const n of allowedNames) {
    const r = validateMeshcoreSenderName(n);
    if (!r.ok) return { ok: false, message: `Invalid sender name (${r.reason})` };
    if (!names.includes(r.name)) names.push(r.name);
  }
  return { ok: true, policy: { enabled, allowedNames: names } };
}

export async function readSenderNamePolicy(sourceId: string): Promise<SenderNamePolicy> {
  const raw = await databaseService.settings.getSettingForSource(sourceId, SENDER_NAME_POLICY_SETTING_KEY);
  return parseSenderNamePolicy(raw);
}

export async function writeSenderNamePolicy(sourceId: string, policy: SenderNamePolicy): Promise<void> {
  await databaseService.settings.setSourceSetting(sourceId, SENDER_NAME_POLICY_SETTING_KEY, JSON.stringify(policy));
}

export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; code: 'SENDER_NAME_DISABLED' | 'SENDER_NAME_NOT_ALLOWED' | 'INVALID_INPUT'; message: string };

/**
 * Decide whether `input` may be used as a sender name under `policy`.
 * Disabled wins over everything (a disabled source never reveals its list).
 * Allowlist comparison is exact (NFC, trimmed, case-sensitive).
 */
export function checkSenderName(policy: SenderNamePolicy, input: unknown): NameCheck {
  if (!policy.enabled) {
    return { ok: false, code: 'SENDER_NAME_DISABLED', message: 'Sender name override is not enabled for this source' };
  }
  const v = validateMeshcoreSenderName(input);
  if (!v.ok) return { ok: false, code: 'INVALID_INPUT', message: `Invalid senderName (${v.reason})` };
  if (!policy.allowedNames.some((n) => normalizeSenderName(n) === v.name)) {
    return { ok: false, code: 'SENDER_NAME_NOT_ALLOWED', message: 'This sender name is not on the allowed list for this source' };
  }
  return { ok: true, name: v.name };
}
