import meshtasticManager from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager } from '../sourceManagerTypes.js';

/**
 * Resolve a per-source manager.
 *
 * - No sourceId → returns the legacy primary meshtasticManager singleton
 *   (preserves the behavior single-source clients rely on).
 * - sourceId provided and registered as a Meshtastic manager → returns that manager.
 * - sourceId provided but not Meshtastic (e.g. meshcore ids) → falls back to
 *   the meshtasticManager singleton. meshcore ids deliberately fall back to the
 *   singleton because MeshCore sources use isMeshCoreManager-narrowed lookups
 *   in their own routes.
 *
 * Centralizes the inline pattern that previously appeared in 60+ handlers:
 *   sourceId
 *     ? (sourceManagerRegistry.getManager(sourceId) as typeof meshtasticManager ?? meshtasticManager)
 *     : meshtasticManager
 */
export function resolveSourceManager(
  sourceId: string | undefined | null
): typeof meshtasticManager {
  if (!sourceId) return meshtasticManager;
  const manager = sourceManagerRegistry.getManager(sourceId);
  if (manager && isMeshtasticManager(manager)) return manager as typeof meshtasticManager;
  // meshcore ids deliberately fall back to the singleton
  return meshtasticManager;
}
