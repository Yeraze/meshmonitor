/**
 * Late-bound handle on `fallbackManager` (the unconfigured MeshtasticManager
 * in `meshtasticManager.ts`).
 *
 * Small helpers such as `resolveSourceManager` and
 * `resolveLocalNodeNameForSource` need the fallback only at call time. A
 * static import of it pulled the whole 17k-line manager (and everything it
 * imports) into every module that used those helpers, and closed an import
 * cycle (meshtasticManager → distanceDeleteScheduler →
 * autoDeleteByDistanceService → resolveSourceManager → meshtasticManager).
 *
 * `meshtasticManager.ts` registers its instance here as soon as it creates
 * it. The server entry point imports `meshtasticManager.ts` at startup, so
 * the instance is in place before any request or scheduler can ask for it.
 * This module imports nothing at runtime, so it cannot join a cycle.
 */
import type { MeshtasticManager } from './meshtasticManager.js';

let fallback: MeshtasticManager | null = null;

/** Called once by `meshtasticManager.ts` when it creates `fallbackManager`. */
export function registerFallbackManager(manager: MeshtasticManager): void {
  fallback = manager;
}

/**
 * The registered `fallbackManager`. Throws if `meshtasticManager.ts` has not
 * been loaded, which in production cannot happen once the server has started.
 */
export function getFallbackManager(): MeshtasticManager {
  if (!fallback) {
    throw new Error(
      'fallbackManager is not registered yet: import meshtasticManager.js before resolving a source manager'
    );
  }
  return fallback;
}
