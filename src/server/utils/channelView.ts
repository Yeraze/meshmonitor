/**
 * Shared channel response shaping.
 *
 * `transformChannel` is the single canonical whitelist used to project a
 * raw `channels` table row into a public-facing API response. It does NOT
 * include the `psk` column — channel PSKs are sensitive (32-byte symmetric
 * keys that authenticate AND encrypt mesh traffic) and must never reach
 * an HTTP response.
 *
 * Used by:
 *   - `routes/v1/channels.ts` (already)
 *   - `server.ts` /api/channels, /api/channels/all, and the poll handler
 *     (added for MM-SEC-2)
 */

export function getRoleName(role: number | undefined): string {
  switch (role) {
    case 0: return 'Disabled';
    case 1: return 'Primary';
    case 2: return 'Secondary';
    default: return 'Unknown';
  }
}

export function transformChannel(channel: any) {
  // `pskSet` is a derived boolean so callers (UI badges, system tests,
  // configuration export flows) can answer "is a PSK configured on this
  // channel?" without exposing the actual key material.
  return {
    id: channel.id,
    name: channel.name,
    role: channel.role,
    roleName: getRoleName(channel.role),
    uplinkEnabled: channel.uplinkEnabled,
    downlinkEnabled: channel.downlinkEnabled,
    positionPrecision: channel.positionPrecision,
    pskSet: !!channel.psk,
  };
}
