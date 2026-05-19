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
  /**
   * Firmware-derived channel name for the device's modem preset
   * (e.g. `MediumFast`, `LongFast`). When provided, this is used as the
   * `displayName` fallback for slot 0 if its `name` column is blank —
   * matching what the Meshtastic firmware actually publishes on the wire.
   * Callers compute this from the persisted `lora.preset.<sourceId>`
   * setting via `modemPresetChannelName`; pass `null` when no preset is
   * known for the source.
   */
  presetName?: string | null;
}

/** Slot 0 fallback when we can't derive a firmware-preset name. */
export const PRIMARY_CHANNEL_NAME = 'Primary';

/**
 * Compute the user-facing display name for a channel row, applying the
 * same rules as `unifiedChannelDisplayName` in unifiedRoutes.ts:
 *   1. If `name` is set, use it.
 *   2. Otherwise for slot 0, fall back to the modem-preset's firmware name
 *      ("MediumFast", "LongFast", etc.) when available, so per-source
 *      views collapse onto the same label MQTT gateways publish under.
 *   3. Otherwise for slot 0 with no preset hint, fall back to "Primary".
 *   4. Otherwise return whatever `name` is (typically empty/unused slot).
 */
export function computeChannelDisplayName(
  channel: { id: number; name?: string | null },
  presetName?: string | null,
): string {
  const trimmed = (channel.name ?? '').trim();
  if (trimmed) return trimmed;
  if (channel.id === 0) return presetName ?? PRIMARY_CHANNEL_NAME;
  return trimmed;
}

/**
 * Project a raw `channels` row into the public response shape.
 *
 * Always returns: `id`, `name`, `displayName`, `role`, `roleName`,
 * `uplinkEnabled`, `downlinkEnabled`, `positionPrecision`,
 * `pskSet` (boolean), and `encryptionStatus` ('none' | 'default' | 'secure').
 *
 * `name` is the raw DB column (may be empty for slot 0 when the device
 * runs on a modem preset). `displayName` is the user-facing label with
 * the preset/Primary fallback applied — frontends should render that.
 *
 * When `options.includePsk === true`, the actual `psk` string is included
 * so an authorized admin can see/edit the existing key. The default is to
 * OMIT the key.
 */
export function transformChannel(channel: any, options: TransformChannelOptions = {}) {
  const base = {
    id: channel.id,
    name: channel.name,
    displayName: computeChannelDisplayName(channel, options.presetName),
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
