import type { DeviceInfo } from '../types/device';

/**
 * Merge a partial node update (typically from a WebSocket `node:updated` event)
 * into the existing client-side node, rebuilding the nested `position` object
 * from flat lat/lng/alt fields when present.
 *
 * Skips position rebuild when the merged node has an active user-set override
 * (`positionOverrideEnabled === true` with non-null override coords) — incoming
 * device GPS packets must not displace the override on the client (issue #2847).
 */
export function mergeNodeUpdate(
  node: DeviceInfo,
  nodeUpdate: Partial<DeviceInfo>,
): DeviceInfo {
  const merged = { ...node, ...nodeUpdate };

  const hasOverride =
    (merged as any).positionOverrideEnabled === true &&
    (merged as any).latitudeOverride != null &&
    (merged as any).longitudeOverride != null;
  if (hasOverride) {
    return merged;
  }

  const lat = (nodeUpdate as any).latitude;
  const lng = (nodeUpdate as any).longitude;
  if (lat != null && lng != null) {
    merged.position = {
      latitude: lat,
      longitude: lng,
      altitude: (nodeUpdate as any).altitude ?? node.position?.altitude,
    };
  }

  return merged;
}
