import meshtasticManager from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

/**
 * Resolve a per-source manager.
 *
 * - No sourceId → returns the legacy primary meshtasticManager singleton
 *   (preserves the behavior single-source clients rely on).
 * - sourceId provided and registered → returns that manager.
 * - sourceId provided but NOT registered → returns the singleton fallback.
 *
 * Centralizes the inline pattern that previously appeared in 60+ handlers:
 *   sourceId
 *     ? (sourceManagerRegistry.getManager(sourceId) as typeof meshtasticManager ?? meshtasticManager)
 *     : meshtasticManager
 *
 * TODO(Sourcey GAP-M5 follow-up): when a sourceId is supplied but no
 * matching manager exists, this should respond with 404/503 rather than
 * silently fall back to the primary source. The helper here is the lever
 * that future PR will pull; touching it updates all call sites at once.
 * The behavior change is held out of this PR so the rename can land
 * mechanically and be reviewed without behavioral risk.
 */
export function resolveSourceManager(
  sourceId: string | undefined | null
): typeof meshtasticManager {
  if (!sourceId) return meshtasticManager;
  return (sourceManagerRegistry.getManager(sourceId) as typeof meshtasticManager) ?? meshtasticManager;
}
