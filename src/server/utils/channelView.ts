/**
 * Shared channel response shaping.
 *
 * `transformChannel` is the single canonical whitelist used to project a
 * raw `channels` table row into a public-facing API response. The raw
 * `psk` column (32-byte symmetric key that authenticates AND encrypts mesh
 * traffic) is sensitive and is only included when the caller can prove
 * write access to that channel — see `includePsk` below.
 *
 * Used by:
 *   - `routes/v1/channels.ts`
 *   - `server.ts` /api/channels, /api/channels/all, and the poll handler
 */

/** Default public PSK (base64 of single byte 0x01) — known publicly, not secure. */
export const DEFAULT_PUBLIC_PSK = 'AQ==';

export type ChannelEncryptionStatus = 'none' | 'default' | 'secure';

/**
 * Classify a channel's PSK without exposing the key itself.
 *   - 'none'    no PSK configured (unencrypted)
 *   - 'default' the publicly known default key (`AQ==`)
 *   - 'secure'  any other (custom) key
 */
export function getEncryptionStatus(psk: string | null | undefined): ChannelEncryptionStatus {
  if (!psk || psk === '') return 'none';
  if (psk === DEFAULT_PUBLIC_PSK) return 'default';
  return 'secure';
}

export function getRoleName(role: number | undefined): string {
  switch (role) {
    case 0: return 'Disabled';
    case 1: return 'Primary';
    case 2: return 'Secondary';
    default: return 'Unknown';
  }
}

export interface TransformChannelOptions {
  /**
   * Include the raw `psk` field in the response. ONLY pass `true` when the
   * caller has been authenticated AND has write permission to the specific
   * channel (or is an admin). MM-SEC-2 forbids leaking PSKs to unprivileged
   * callers; see `transformChannelForUser` for the gated helper.
   */
  includePsk?: boolean;
}

/**
 * Project a raw `channels` row into the public response shape.
 *
 * Always returns: `id`, `name`, `role`, `roleName`, `uplinkEnabled`,
 * `downlinkEnabled`, `positionPrecision`, `pskSet` (boolean), and
 * `encryptionStatus` ('none' | 'default' | 'secure').
 *
 * When `options.includePsk === true`, the actual `psk` string is included
 * so an authorized admin can see/edit the existing key. The default is to
 * OMIT the key.
 */
export function transformChannel(channel: any, options: TransformChannelOptions = {}) {
  const base = {
    id: channel.id,
    name: channel.name,
    role: channel.role,
    roleName: getRoleName(channel.role),
    uplinkEnabled: channel.uplinkEnabled,
    downlinkEnabled: channel.downlinkEnabled,
    positionPrecision: channel.positionPrecision,
    pskSet: !!channel.psk,
    encryptionStatus: getEncryptionStatus(channel.psk),
  };
  if (options.includePsk) {
    return { ...base, psk: channel.psk ?? null };
  }
  return base;
}
