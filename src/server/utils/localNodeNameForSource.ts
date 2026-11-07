/**
 * Local node name for the "Prefix with node name" notification option
 * (#6251).
 *
 * The prefix must name the node of the source the notification is about.
 * Push and Apprise used to read it from the primary Meshtastic manager for
 * every notification, so a MeshCore alert carried a Meshtastic node's name,
 * or no prefix when no Meshtastic source existed.
 *
 * Resolution, in order:
 *  1. A source id with a registered MeshCore manager: that device's own name.
 *  2. A source id with a registered Meshtastic manager: its live long name.
 *  3. A source id with any other or no manager: the stored local node for
 *     that source (covers startup, before the source connects).
 *  4. No source id: the primary Meshtastic source, live then stored, which
 *     is the behaviour every source-less caller had before.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { fallbackManager } from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { getPrimaryMeshtasticManager, isMeshCoreManager, isMeshtasticManager } from '../sourceManagerTypes.js';

async function storedLocalNodeName(sourceId: string): Promise<string | null> {
  const localNodeNumStr = await databaseService.settings.getLocalNodeNumForSource(sourceId);
  if (!localNodeNumStr) return null;
  const localNodeNum = parseInt(localNodeNumStr, 10);
  if (!Number.isFinite(localNodeNum)) return null;
  const localNode = await databaseService.nodesRepo?.getNode(localNodeNum, sourceId);
  return localNode?.longName || null;
}

export async function resolveLocalNodeNameForSource(sourceId?: string | null): Promise<string | null> {
  try {
    if (sourceId) {
      const manager = sourceManagerRegistry.getManager(sourceId);
      if (manager && isMeshCoreManager(manager)) {
        return manager.getLocalNode()?.name || null;
      }
      if (manager && isMeshtasticManager(manager)) {
        const live = manager.getLocalNodeInfo()?.longName;
        if (live) return live;
      }
      return await storedLocalNodeName(sourceId);
    }

    const primary = getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
    const live = primary.getLocalNodeInfo()?.longName;
    if (live) return live;
    return await storedLocalNodeName(primary.sourceId);
  } catch (err) {
    logger.debug(`📢 Could not resolve local node name for prefix (source ${sourceId ?? 'primary'}):`, err);
    return null;
  }
}
