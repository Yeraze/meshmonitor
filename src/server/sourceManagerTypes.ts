/**
 * Type-guard predicates and primary-manager resolution for ISourceManager.
 *
 * These are the ONE canonical narrowing idiom for the whole codebase.
 * Use these instead of `instanceof` checks or `as any[]` casts.
 *
 * Placement: a leaf module that imports manager *types* only (no runtime
 * imports) so there are no import cycles between sourceManagerRegistry and
 * the manager classes.
 *
 * Usage:
 *   import { isMeshCoreManager, isMeshtasticManager } from './sourceManagerTypes.js';
 *
 *   sourceManagerRegistry.getAllManagers().filter(isMeshCoreManager)     // MeshCoreManager[]
 *   sourceManagerRegistry.getAllManagers().filter(isMeshtasticManager)   // MeshtasticManager[]
 *
 * getPrimaryMeshtasticManager consults registry.getPrimaryMeshtasticSourceId()
 * (the explicitly designated primary set by bootstrapSources at startup) and
 * falls back to the first registered meshtastic_tcp manager in insertion order
 * when no explicit designation exists (e.g. tests with fresh registries, or
 * the interim window after a primary is cleared by removeManager).
 */

import type { ISourceManager, SourceManagerRegistry } from './sourceManagerRegistry.js';
import type { MeshCoreManager } from './meshcoreManager.js';
import type { MeshtasticManager } from './meshtasticManager.js';
import type { ReticulumManager } from './reticulumManager.js';

/**
 * Narrows an ISourceManager to MeshCoreManager.
 * Predicate is based on the sourceType discriminant — no instanceof, no import cycles.
 */
export function isMeshCoreManager(m: ISourceManager): m is MeshCoreManager {
  return m.sourceType === 'meshcore';
}

/**
 * Narrows an ISourceManager to MeshtasticManager.
 * Predicate is based on the sourceType discriminant — no instanceof, no import cycles.
 */
export function isMeshtasticManager(m: ISourceManager): m is MeshtasticManager {
  return m.sourceType === 'meshtastic_tcp';
}

/**
 * Narrows an ISourceManager to ReticulumManager.
 * Predicate is based on the sourceType discriminant — no instanceof, no import cycles.
 *
 * `Source['type']` does not include `'reticulum'` yet (union widening is
 * WP5's job, build spec §3.3 — `src/db/repositories/sources.ts` is
 * off-limits for WP4). Comparing `m.sourceType` directly against the string
 * literal `'reticulum'` would fail TS2367 ("no overlap") until that widening
 * lands, so the comparison goes through `string` here; WP5 can drop the cast
 * once the union includes `'reticulum'`.
 */
export function isReticulumManager(m: ISourceManager): m is ReticulumManager {
  return (m.sourceType as string) === 'reticulum';
}

/**
 * Resolve the primary MeshtasticManager from a registry.
 *
 * WP2 (this implementation): first checks the explicitly designated primary
 * via `registry.getPrimaryMeshtasticSourceId()` (set by
 * `registry.setPrimaryMeshtasticSource()` when the first TCP source is
 * registered at boot). Falls back to the first meshtastic_tcp manager in
 * insertion order when no explicit designation exists (e.g. during tests that
 * use fresh registries, or before WP3 wires the designation call).
 *
 * Returns `undefined` when no meshtastic_tcp manager is registered (e.g. all-
 * MeshCore, all-disabled-tcp, or autoConnect:false installs).
 */
export function getPrimaryMeshtasticManager(
  registry: SourceManagerRegistry,
): MeshtasticManager | undefined {
  // Prefer the explicitly designated primary (stable across later additions).
  const primaryId = registry.getPrimaryMeshtasticSourceId();
  if (primaryId !== null) {
    const mgr = registry.getManager(primaryId);
    if (mgr && isMeshtasticManager(mgr)) return mgr as MeshtasticManager;
  }
  // Fallback: first registered meshtastic_tcp manager in insertion order.
  return registry.getAllManagers().find(isMeshtasticManager) as MeshtasticManager | undefined;
}
