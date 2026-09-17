/**
 * DeviceMetadata.excluded_modules support (#5065).
 *
 * A firmware build can leave modules out (`MESHTASTIC_EXCLUDE_MODULES`, no-GPS
 * and vendor images), and the device says which ones through the
 * `excluded_modules` bitmask in DeviceMetadata. That beats inferring
 * availability from the firmware version string: exclusions are per build, not
 * per version.
 *
 * Bit values come from `enum ExcludedModules` in `protobufs/meshtastic/mesh.proto`.
 */

/** Module config sections MeshMonitor shows, keyed by the bit that excludes them. */
export const EXCLUDED_MODULE_BITS = {
  mqtt: 0x0001,
  serial: 0x0002,
  extnotif: 0x0004,
  storeforward: 0x0008,
  rangetest: 0x0010,
  telemetry: 0x0020,
  cannedmsg: 0x0040,
  audio: 0x0080,
  remotehardware: 0x0100,
  neighborinfo: 0x0200,
  ambientlighting: 0x0400,
  detectionsensor: 0x0800,
  paxcounter: 0x1000,
  bluetooth: 0x2000,
  network: 0x4000,
} as const;

export type ExcludedModuleKey = keyof typeof EXCLUDED_MODULE_BITS;

/** Every module key, in bit order. */
export const EXCLUDED_MODULE_KEYS = Object.keys(EXCLUDED_MODULE_BITS) as ExcludedModuleKey[];

/**
 * Read `excluded_modules` off a decoded DeviceMetadata.
 *
 * Returns undefined when the device never reported the field — firmware older
 * than the field, or a manager that has not seen DeviceMetadata yet. Callers
 * must treat undefined as "nothing excluded" (fail open), because a wrong
 * "not supported" notice on a working module is worse than showing config for
 * a module the device ignores.
 */
export function readExcludedModules(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = (metadata as { excludedModules?: unknown; excluded_modules?: unknown }).excludedModules
    ?? (metadata as { excluded_modules?: unknown }).excluded_modules;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

/**
 * Whether the device excluded one module. Unknown mask means "not excluded".
 */
export function isModuleExcluded(mask: number | undefined | null, key: ExcludedModuleKey): boolean {
  if (typeof mask !== 'number') return false;
  return (mask & EXCLUDED_MODULE_BITS[key]) !== 0;
}

/**
 * Availability of every module for the `supportedModules` payload: true when
 * the device kept it, false only when the device positively excluded it.
 */
export function moduleAvailabilityFromMask(
  mask: number | undefined | null,
): Record<ExcludedModuleKey, boolean> {
  const out = {} as Record<ExcludedModuleKey, boolean>;
  for (const key of EXCLUDED_MODULE_KEYS) {
    out[key] = !isModuleExcluded(mask, key);
  }
  return out;
}
