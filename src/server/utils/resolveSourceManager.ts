import { fallbackManager, type MeshtasticManager } from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager, getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';

/**
 * Resolve a per-source manager.
 *
 * - No sourceId → returns the registry's primary meshtastic_tcp manager, or
 *   `fallbackManager` when none is registered (S4 env-IP fallback / early
 *   module access before bootstrapSources runs). Preserves the behavior
 *   single-source clients rely on.
 * - sourceId provided and registered as a Meshtastic manager → returns that manager.
 * - sourceId provided but not Meshtastic (e.g. meshcore ids) → falls back to
 *   the primary/fallback resolution above. meshcore ids deliberately fall
 *   back because MeshCore sources use isMeshCoreManager-narrowed lookups
 *   in their own routes.
 *
 * Because of that fallback, NEVER use this to transmit or to write device
 * config for a caller-supplied sourceId: an MQTT broker/bridge id would act on
 * the primary TCP radio (#5367, #5375). Guard those routes with
 * `requireMeshtasticDeviceSource()` / `refuseNonMeshtasticSource()`, or use
 * {@link resolveOwnMeshtasticManager} and skip the device step on null.
 *
 * Centralizes the inline pattern that previously appeared in 60+ handlers.
 * NEVER returns undefined (invariant I2, #3962 Phase 4.2a) — every caller
 * relies on a non-optional manager instance.
 */
export function resolveSourceManager(
  sourceId: string | undefined | null
): MeshtasticManager {
  if (!sourceId) return getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
  const manager = sourceManagerRegistry.getManager(sourceId);
  if (manager && isMeshtasticManager(manager)) return manager as MeshtasticManager;
  // meshcore ids deliberately fall back to the primary/fallback manager
  return getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
}

/**
 * Resolve the Meshtastic manager that owns `sourceId`'s OWN device, or null.
 *
 * Unlike {@link resolveSourceManager}, this never borrows another source's
 * manager. An explicit sourceId that is not a registered Meshtastic manager
 * (an mqtt_broker / mqtt_bridge / meshcore / reticulum source, or a source
 * that is not connected) returns null. Use it anywhere the answer is "this
 * source's local node": identity, firmware, device config, keys. Falling back
 * there shows a different source's device (#5367).
 *
 * No sourceId keeps the legacy single-source resolution (primary, then
 * `fallbackManager`).
 */
export function resolveOwnMeshtasticManager(
  sourceId: string | undefined | null
): MeshtasticManager | null {
  if (!sourceId) return getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
  const manager = sourceManagerRegistry.getManager(sourceId);
  return manager && isMeshtasticManager(manager) ? (manager as MeshtasticManager) : null;
}
