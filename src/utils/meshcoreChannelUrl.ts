/**
 * MeshCore channel share URL (#6257, P8a S1). Isomorphic: the server adapter
 * and the share/import modals use the same encode/decode/validate code.
 *
 *   meshcore://channel/add?name=<urlenc>&secret=<32 hex>[&region_scope=<urlenc>]
 *
 * Format source: docs.meshcore.io/qr_codes ("Add Channel"). Hashtag names
 * (`#room`) may omit `secret`: it derives from the name, like the app does.
 * The firmware stores only 16-byte secrets, so a 32-byte secret is refused.
 */
import { MESHCORE_SECRET_BYTES, deriveHashtagSecretHex, isHashtagChannelName } from './meshcoreHelpers.js';

export const MESHCORE_CHANNEL_URL_PREFIX = 'meshcore://channel/add';
/** Channel names are limited to this many UTF-8 bytes on the device. */
export const MESHCORE_CHANNEL_NAME_MAX_BYTES = 31;
/** Slot count assumed when the device did not report `maxChannels`. */
export const MESHCORE_DEFAULT_MAX_CHANNELS = 8;

const SECRET_HEX_LEN = MESHCORE_SECRET_BYTES * 2;
const SCOPE_RE = /^[A-Za-z0-9-]{1,63}$/;

export type MeshcoreChannelUrlErrorCode =
  | 'WRONG_SCHEME'
  | 'NAME_REQUIRED'
  | 'NAME_TOO_LONG'
  | 'SECRET_REQUIRED'
  | 'SECRET_BAD_HEX'
  | 'SECRET_WRONG_LENGTH'
  | 'SECRET_ALL_ZERO'
  | 'SCOPE_INVALID';

export interface MeshcoreChannelShare {
  name: string;
  /** 32 lowercase hex chars. */
  secretHex: string;
  /** Plain region name (no '#'), or null. */
  regionScope: string | null;
}

export type MeshcoreChannelUrlResult =
  | { ok: true; channel: MeshcoreChannelShare; /** True when the URL had no secret and it was derived from the name. */ derived: boolean }
  | { ok: false; code: MeshcoreChannelUrlErrorCode; message: string };

const bad = (code: MeshcoreChannelUrlErrorCode, message: string): { ok: false; code: MeshcoreChannelUrlErrorCode; message: string } =>
  ({ ok: false, code, message });

/** True when `url` uses the MeshCore channel scheme (cheap dispatch check). */
export function isMeshcoreChannelUrl(url: string): boolean {
  return /^meshcore:\/\/channel\/add(\?|$)/i.test(url.trim());
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Validate and normalize name / secret / scope. Shared by encode and decode. */
function validateParts(
  nameRaw: string,
  secretRaw: string | null,
  scopeRaw: string | null,
): { ok: true; channel: MeshcoreChannelShare } | { ok: false; code: MeshcoreChannelUrlErrorCode; message: string } {
  const name = nameRaw.trim();
  if (!name) return bad('NAME_REQUIRED', 'Channel name is required');
  if (utf8Length(name) > MESHCORE_CHANNEL_NAME_MAX_BYTES) {
    return bad('NAME_TOO_LONG', `Channel name must be ${MESHCORE_CHANNEL_NAME_MAX_BYTES} bytes or less`);
  }
  const secret = (secretRaw ?? '').trim().toLowerCase();
  if (!secret) return bad('SECRET_REQUIRED', 'Channel secret is required');
  if (!/^[0-9a-f]+$/.test(secret)) return bad('SECRET_BAD_HEX', 'Channel secret must be hexadecimal');
  if (secret.length !== SECRET_HEX_LEN) {
    return bad(
      'SECRET_WRONG_LENGTH',
      `Channel secret must be exactly ${SECRET_HEX_LEN} hex characters (16 bytes); MeshCore firmware does not accept other lengths`,
    );
  }
  if (/^0+$/.test(secret)) return bad('SECRET_ALL_ZERO', 'Channel secret must not be all zeros');
  let regionScope: string | null = null;
  const scope = (scopeRaw ?? '').trim().replace(/^#/, '');
  if (scope) {
    if (!SCOPE_RE.test(scope)) return bad('SCOPE_INVALID', 'Region scope must be 1-63 chars: letters, digits, hyphen');
    regionScope = scope;
  }
  return { ok: true, channel: { name, secretHex: secret, regionScope } };
}

/** Build a share URL. Never throws: an invalid channel returns the error. */
export function encodeMeshcoreChannelUrl(
  channel: { name: string; secretHex: string; regionScope?: string | null },
): { ok: true; url: string } | { ok: false; code: MeshcoreChannelUrlErrorCode; message: string } {
  const v = validateParts(channel.name, channel.secretHex, channel.regionScope ?? null);
  if (!v.ok) return v;
  const { name, secretHex, regionScope } = v.channel;
  let url = `${MESHCORE_CHANNEL_URL_PREFIX}?name=${encodeURIComponent(name)}&secret=${secretHex}`;
  if (regionScope) url += `&region_scope=${encodeURIComponent(regionScope)}`;
  return { ok: true, url };
}

/** Parse and validate a share URL. Async only for the hashtag secret derive. */
export async function decodeMeshcoreChannelUrl(url: string): Promise<MeshcoreChannelUrlResult> {
  const trimmed = (url ?? '').trim();
  const m = /^meshcore:\/\/channel\/add\?(.*)$/is.exec(trimmed);
  if (!m) return bad('WRONG_SCHEME', 'Not a MeshCore channel URL (expected meshcore://channel/add?...)');
  // Parse the query by hand-off to URLSearchParams on the raw text, so an
  // unencoded `#` in a hashtag name is not read as a fragment.
  const params = new URLSearchParams(m[1]);
  const name = params.get('name') ?? '';
  let secret = params.get('secret');
  const scope = params.get('region_scope');
  let derived = false;
  if ((secret === null || secret.trim() === '') && isHashtagChannelName(name.trim())) {
    if (name.trim() && utf8Length(name.trim()) <= MESHCORE_CHANNEL_NAME_MAX_BYTES) {
      secret = await deriveHashtagSecretHex(name.trim());
      derived = true;
    }
  }
  const v = validateParts(name, secret, scope);
  if (!v.ok) return v;
  return { ok: true, channel: v.channel, derived };
}

/** Mask a hex secret for display: first 2 and last 2 chars visible. */
export function maskMeshcoreSecret(secretHex: string): string {
  if (secretHex.length <= 4) return '*'.repeat(secretHex.length);
  return `${secretHex.slice(0, 2)}${'*'.repeat(secretHex.length - 4)}${secretHex.slice(-2)}`;
}

/** A device slot as seen by the import planner. */
export interface MeshcoreSlotInfo {
  id: number;
  name?: string | null;
  /** Base64 or hex is NOT accepted here: pass lowercase hex, or null/'' when unset. */
  secretHex?: string | null;
}

export type MeshcoreImportPlan =
  | { kind: 'existing'; slot: number }
  | { kind: 'new'; slot: number }
  | { kind: 'full'; maxChannels: number };

/** Lowest free slot in 1..maxChannels-1, or null when full. Slot 0 is never a target. */
export function lowestFreeMeshcoreSlot(usedIds: Iterable<number>, maxChannels: number): number | null {
  const used = new Set(usedIds);
  const cap = Number.isFinite(maxChannels) && maxChannels >= 1 ? Math.floor(maxChannels) : MESHCORE_DEFAULT_MAX_CHANNELS;
  for (let i = 1; i < cap; i++) if (!used.has(i)) return i;
  return null;
}

/**
 * Decide where an imported channel goes: the slot already holding the same
 * secret (any slot, incl. 0), else the lowest free slot >= 1 below
 * `maxChannels`, else full. A slot is occupied when it has a name or a
 * non-zero secret.
 */
export function planMeshcoreChannelImport(
  secretHex: string,
  slots: MeshcoreSlotInfo[],
  maxChannels: number | null | undefined,
): MeshcoreImportPlan {
  const cap = maxChannels && maxChannels > 0 ? maxChannels : MESHCORE_DEFAULT_MAX_CHANNELS;
  const want = secretHex.toLowerCase();
  const same = slots.find((s) => (s.secretHex ?? '').toLowerCase() === want);
  if (same) return { kind: 'existing', slot: same.id };
  const occupied = slots
    .filter((s) => {
      const sec = (s.secretHex ?? '').toLowerCase();
      return (s.name ?? '').trim() !== '' || (sec !== '' && !/^0+$/.test(sec));
    })
    .map((s) => s.id);
  const slot = lowestFreeMeshcoreSlot(occupied, cap);
  return slot === null ? { kind: 'full', maxChannels: cap } : { kind: 'new', slot };
}
