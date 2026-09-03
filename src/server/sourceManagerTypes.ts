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
import type { MeshCoreMqttManager } from './meshcoreMqttManager.js';
import type { MeshtasticManager } from './meshtasticManager.js';
import type { ReticulumManager } from './reticulumManager.js';

/**
 * Narrows an ISourceManager to a **device-backed** MeshCoreManager.
 *
 * Note the "device-backed": `meshcore_mqtt` sources (#5040) are MeshCore too,
 * but have no radio, so this predicate deliberately excludes them. Every caller
 * that drives the device — the neighbours / remote-telemetry / room-sync /
 * telemetry-poll / time-sync schedulers, the config and device routes — wants
 * exactly this narrowing, and gets the exclusion for free.
 *
 * For a surface that should see MeshCore data regardless of where it came from
 * (node lists, automation triggers, notification services), use
 * {@link isAnyMeshCoreManager} instead. Picking the wrong one is the likely bug:
 * this predicate silently skips MQTT sources, which reads as "the feature just
 * doesn't work for that source" rather than as an error.
 *
 * Predicate is based on the sourceType discriminant — no instanceof, no import cycles.
 */
export function isMeshCoreManager(m: ISourceManager): m is MeshCoreManager {
  return m.sourceType === 'meshcore';
}

/**
 * Narrows an ISourceManager to the MQTT-fed MeshCore ingest manager (#5040).
 *
 * This source has no device: it subscribes to an analyzer broker and replays
 * what other observers heard. It can never transmit.
 */
export function isMeshCoreMqttManager(m: ISourceManager): m is MeshCoreMqttManager {
  return m.sourceType === 'meshcore_mqtt';
}

/**
 * True for any MeshCore source, device-backed or MQTT-fed.
 *
 * Use this for read/consume surfaces — node lists, automation triggers,
 * notification and analysis services — where "which transport delivered it"
 * is not the question being asked. Use {@link isMeshCoreManager} when the code
 * is going to talk to a radio.
 */
export function isAnyMeshCoreManager(
  m: ISourceManager,
): m is MeshCoreManager | MeshCoreMqttManager {
  return isMeshCoreManager(m) || isMeshCoreMqttManager(m);
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
 */
export function isReticulumManager(m: ISourceManager): m is ReticulumManager {
  return m.sourceType === 'reticulum';
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
