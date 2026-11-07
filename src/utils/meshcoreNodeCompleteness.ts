/**
 * "Hide incomplete nodes" for MeshCore (#6258). MeshCore has no NODEINFO, so
 * the Meshtastic `isNodeComplete` cannot apply. A row is incomplete when it has
 * no advertised name (checked on the RAW name, before any 'Unknown' display
 * fallback) or an unknown device type (undefined, 0 = MeshCoreDeviceType.UNKNOWN).
 */
export function isMeshCoreRowComplete(r: { rawName?: string | null; advType?: number }): boolean {
  if (typeof r.rawName !== 'string' || r.rawName.trim() === '') return false;
  if (!r.advType) return false;
  return true;
}
