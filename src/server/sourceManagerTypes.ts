/**
 * Type-guard predicates for narrowing ISourceManager to a concrete manager type.
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
 */

import type { ISourceManager } from './sourceManagerRegistry.js';
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
