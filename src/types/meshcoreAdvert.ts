/**
 * MeshCore self-advert reach, shared by the server and the client.
 *
 * - `zero_hop` — heard only by nodes in direct radio range; no repeater
 *   re-broadcasts it. Firmware default for CMD_SEND_SELF_ADVERT (type byte 0)
 *   and the repeater CLI verb `advert.zerohop`.
 * - `flood` — every repeater within 8 hops re-broadcasts it (type byte 1, CLI
 *   verb `advert`). With ~20 repeaters in reach that is roughly 9 s (US) /
 *   25 s (EU) of shared channel time per advert.
 */
export const MESHCORE_ADVERT_MODES = ['zero_hop', 'flood'] as const;
export type MeshCoreAdvertMode = (typeof MESHCORE_ADVERT_MODES)[number];

/** Mode for every NEW config and for the manual advert button. */
export const DEFAULT_MESHCORE_ADVERT_MODE: MeshCoreAdvertMode = 'zero_hop';

/**
 * Mode assumed for a config saved before the mode field existed (auto-announce
 * advert burst, timer triggers, automation actions). Those always flooded, so
 * they keep flooding rather than change behaviour silently. They still fall
 * under the automated flood floor below.
 */
export const LEGACY_MESHCORE_ADVERT_MODE: MeshCoreAdvertMode = 'flood';

/**
 * Automated flood adverts (auto-announce burst, timer triggers, automation
 * actions) may fire at most once per this window, per source. Manual floods
 * are never blocked, but they do restart the window.
 */
export const MESHCORE_AUTOMATED_FLOOD_ADVERT_MIN_INTERVAL_MS = 60 * 60 * 1000;

export function isMeshCoreAdvertMode(value: unknown): value is MeshCoreAdvertMode {
  return typeof value === 'string' && (MESHCORE_ADVERT_MODES as readonly string[]).includes(value);
}

/**
 * Read a stored/requested mode, falling back when it is absent or unknown.
 * Callers pick the fallback: LEGACY for a stored automated config, DEFAULT for
 * a new request.
 */
export function resolveMeshCoreAdvertMode(value: unknown, fallback: MeshCoreAdvertMode): MeshCoreAdvertMode {
  return isMeshCoreAdvertMode(value) ? value : fallback;
}
