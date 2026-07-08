/**
 * @deprecated Deprecated compatibility shim. Use `sourceManagerRegistry` + `isMeshCoreManager`
 * for all new code. This module will be removed in the release after the one that landed #3962
 * (Task 2.1). All internal production code has been migrated; this exists only to avoid
 * breaking any stray external importers during the transition window.
 *
 * Removal note: delete this file after one release. Tracked by #3962 Task 2.1.
 */

import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { isMeshCoreManager } from './sourceManagerTypes.js';
import { logger } from '../utils/logger.js';

// Re-export the config helpers from their canonical location so callers that
// still import these from the old path continue to compile.
export {
  meshcoreConfigFromSource,
  virtualNodeConfigFromSource,
  DEFAULT_VIRTUAL_NODE_PORT,
  type MeshCoreSourceConfig,
} from './meshcoreConfig.js';

/**
 * @deprecated Use `sourceManagerRegistry.getManager(id)` + `isMeshCoreManager` for lookups,
 * `sourceManagerRegistry.getAllManagers().filter(isMeshCoreManager)` for enumeration,
 * and `sourceManagerRegistry.removeManager(id)` for removal.
 * Removed in the release after #3962 Task 2.1 lands.
 */
export const meshcoreManagerRegistry = {
  /** @deprecated Use `sourceManagerRegistry.getManager(id)` + `isMeshCoreManager`. */
  get(id: string) {
    const m = sourceManagerRegistry.getManager(id);
    return m && isMeshCoreManager(m) ? m : undefined;
  },

  /** @deprecated Use `sourceManagerRegistry.getAllManagers().filter(isMeshCoreManager)`. */
  list() {
    return sourceManagerRegistry.getAllManagers().filter(isMeshCoreManager);
  },

  /** @deprecated Use `sourceManagerRegistry.removeManager(id)`. */
  remove(id: string): Promise<void> {
    return sourceManagerRegistry.removeManager(id);
  },

  /** @deprecated Use `sourceManagerRegistry.stopAll()`. */
  disconnectAll(): Promise<void> {
    return sourceManagerRegistry.stopAll();
  },

  /**
   * @deprecated getOrCreate's "create without connect" contract cannot be reproduced
   * on the unified registry (addManager auto-starts). Migrate to the create-or-connect
   * recipe: new MeshCoreManager(id, name) → configure(cfg) → sourceManagerRegistry.addManager(mgr).
   * See #3962 Task 2.1 for details.
   */
  getOrCreate(_source: unknown): never {
    logger.error(
      '[meshcoreManagerRegistry.getOrCreate] Called on the deprecated shim — ' +
        'migrate to sourceManagerRegistry + isMeshCoreManager (#3962 Task 2.1).',
    );
    throw new Error(
      '[meshcoreManagerRegistry.getOrCreate] deprecated — ' +
        'migrate to sourceManagerRegistry + isMeshCoreManager. #3962 Task 2.1',
    );
  },
};
