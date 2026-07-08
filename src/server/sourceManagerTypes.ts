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
 * WP2 will enhance getPrimaryMeshtasticManager to also consult
 * registry.getPrimaryMeshtasticSourceId() (the explicitly designated primary).
 * In WP1 it falls back to the first registered meshtastic_tcp manager.
 */

import type { ISourceManager, SourceManagerRegistry } from './sourceManagerRegistry.js';
import type { MeshCoreManager } from './meshcoreManager.js';
import type { MeshtasticManager } from './meshtasticManager.js';

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
 * Resolve the primary MeshtasticManager from a registry.
 *
 * WP1 (this implementation): returns the first registered meshtastic_tcp
 * manager in insertion order (the same manager that `firstTcpSourceConfigured`
 * gates in bootstrapSources). This is the fallback path.
 *
 * WP2 will prepend a check of `registry.getPrimaryMeshtasticSourceId()`
 * (an explicit designation set when the first TCP source is started), so
 * the primary is stable even after later sources are added ahead of it in
 * getAllManagers() order.
 *
 * Returns `undefined` when no meshtastic_tcp manager is registered (e.g. all-
 * MeshCore, all-disabled-tcp, or autoConnect:false installs).
 */
export function getPrimaryMeshtasticManager(
  registry: SourceManagerRegistry,
): MeshtasticManager | undefined {
  // WP2: also check registry.getPrimaryMeshtasticSourceId?.() here.
  return registry.getAllManagers().find(isMeshtasticManager) as MeshtasticManager | undefined;
}
