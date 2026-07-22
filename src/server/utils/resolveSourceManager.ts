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
