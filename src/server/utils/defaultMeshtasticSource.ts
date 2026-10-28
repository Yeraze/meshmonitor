/**
 * Default Meshtastic source (#5245).
 *
 * One global setting, `defaultMeshtasticSourceId`, names the Meshtastic TCP
 * source to use wherever a request names no source: legacy routes without a
 * `sourceId` (they go through `getPrimaryMeshtasticManager`), device routes
 * that fall back to the primary, and the v1 `default` alias. Empty means
 * Automatic, which is the behaviour every install had before the setting:
 * the first TCP source started at boot for the primary, the oldest enabled
 * source the caller can use for the `default` alias.
 *
 * An explicit `sourceId` always wins; nothing here touches that path.
 */

import type { SourceManagerRegistry } from '../sourceManagerRegistry.js';

export const DEFAULT_MESHTASTIC_SOURCE_SETTING = 'defaultMeshtasticSourceId';

interface OrderableSource {
  id: string;
  type: string;
  enabled: boolean;
}

/**
 * Move the configured default to the front of an already-ordered source list,
 * when it is in the list, enabled and a `meshtastic_tcp` source. Otherwise the
 * list comes back unchanged, so callers keep their own rule. Callers then walk
 * the list as before, so a caller who cannot use the default (no permission)
 * still gets the next source in the old order.
 */
export function preferConfiguredDefault<T extends OrderableSource>(
  ordered: T[],
  configuredId: string | null | undefined,
): T[] {
  if (!configuredId) return ordered;
  const idx = ordered.findIndex((s) => s.id === configuredId);
  if (idx <= 0) return ordered;
  const chosen = ordered[idx];
  if (!chosen.enabled || chosen.type !== 'meshtastic_tcp') return ordered;
  return [chosen, ...ordered.slice(0, idx), ...ordered.slice(idx + 1)];
}

/** Push a stored setting value into the registry. Empty clears it. */
export function applyDefaultMeshtasticSource(
  registry: Pick<SourceManagerRegistry, 'setPreferredMeshtasticSource'>,
  value: string | null | undefined,
): void {
  registry.setPreferredMeshtasticSource(value && value.trim() ? value.trim() : null);
}

/**
 * Read the stored default, or null. A failed read means Automatic: picking a
 * default source must never fail a request that names no source.
 */
export async function readConfiguredDefaultMeshtasticSourceId(
  db: { settings?: { getSetting?: (key: string) => Promise<string | null> } },
): Promise<string | null> {
  try {
    const value = await db.settings?.getSetting?.(DEFAULT_MESHTASTIC_SOURCE_SETTING);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}
