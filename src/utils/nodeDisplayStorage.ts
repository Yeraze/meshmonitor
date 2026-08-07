/**
 * Namespaced localStorage mirror for the ten Node Display settings (epic
 * #4412 Phase 3 WP1).
 *
 * Today's bare keys (`maxNodeAgeHours`, `nodeDimmingEnabled`, …) are a
 * cross-source leak on first paint: navigate to source B and it briefly
 * renders source A's last-saved value before the network fetch lands. This
 * module namespaces every key under `nodeDisplay:{sourceId}:{key}` so each
 * source has its own mirror, and provides a one-time purge of the legacy
 * bare keys so a stale global value can never resurface.
 *
 * `sourceId === null` (legacy/single-source views, or a `SettingsProvider`
 * mounted outside a `SourceProvider`) has no localStorage slot at all —
 * reads return `null` and writes are silently dropped. This matches the
 * interview's "no runtime global fallback" decision: outside a concrete
 * source there is nothing to mirror.
 */

import type { NodeDisplaySettingKey } from '../constants/nodeDisplayDefaults.js';
import { NODE_DISPLAY_SETTING_KEYS } from '../constants/nodeDisplayDefaults.js';

function storageKey(sourceId: string, key: NodeDisplaySettingKey): string {
  return `nodeDisplay:${sourceId}:${key}`;
}

/** Read the namespaced mirror for `key` under `sourceId`. `null` if unset or `sourceId` is null. */
export function readNodeDisplayLocal(
  sourceId: string | null,
  key: NodeDisplaySettingKey,
): string | null {
  if (sourceId === null) return null;
  try {
    return localStorage.getItem(storageKey(sourceId, key));
  } catch {
    // Safari private mode (and similar) throws on localStorage access.
    return null;
  }
}

/** Write the namespaced mirror for `key` under `sourceId`. No-op if `sourceId` is null. */
export function writeNodeDisplayLocal(
  sourceId: string | null,
  key: NodeDisplaySettingKey,
  value: string,
): void {
  if (sourceId === null) return;
  try {
    localStorage.setItem(storageKey(sourceId, key), value);
  } catch {
    // Safari private mode (and similar) throws on localStorage access.
  }
}

/**
 * One-time removal of the ten legacy bare (un-namespaced) Node Display keys,
 * so a stale global value can never resurface under any source. Idempotent —
 * safe to call on every module load / provider mount.
 */
export function purgeLegacyNodeDisplayLocal(): void {
  try {
    for (const key of NODE_DISPLAY_SETTING_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // Safari private mode (and similar) throws on localStorage access.
  }
}
