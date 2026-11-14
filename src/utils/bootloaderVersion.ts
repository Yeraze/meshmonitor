/**
 * #6321: DeviceMetadata.bootloader_version packs the nRF52 bootloader version
 * as `major << 16 | minor << 8 | patch`. 0 (or any non-positive / non-integer
 * value) means the node did not report one: a non-nRF52 device, or firmware
 * that predates the field.
 *
 * Returns "major.minor.patch", or null when there is nothing to show.
 */
export function formatBootloaderVersion(packed: number | null | undefined): string | null {
  if (typeof packed !== 'number' || !Number.isInteger(packed) || packed <= 0) return null;
  const major = (packed >>> 16) & 0xff;
  const minor = (packed >>> 8) & 0xff;
  const patch = packed & 0xff;
  return `${major}.${minor}.${patch}`;
}
