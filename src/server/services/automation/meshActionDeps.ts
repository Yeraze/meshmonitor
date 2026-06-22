/**
 * Real ActionDeps wiring (#3653, §4) — connects the engine's actions to the live
 * Meshtastic managers and the database.
 *
 * The concrete MeshtasticManager (obtained by casting the ISourceManager from the
 * registry) exposes sendTextMessage + the node-admin senders. Tapbacks reuse
 * sendTextMessage with the emoji flag = 1 and replyId = the triggering packet.
 *
 * NOTE: `notify` is not yet wired — appriseNotificationService has no clean
 * per-source notify entry point (only sendNotificationToUrls + a private config
 * resolver). It throws for now, so a notify action records a failed step in the
 * run-log rather than crashing. Tracked as remaining Phase-1a work.
 */
import databaseService from '../../../services/database.js';
import { sourceManagerRegistry } from '../../sourceManagerRegistry.js';
import { logger } from '../../../utils/logger.js';
import type { ActionDeps } from './actionExecutor.js';

interface MeshSendManager {
  sendTextMessage(text: string, channel?: number, destination?: number, replyId?: number, emoji?: number): Promise<number>;
  sendFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  sendRemoveFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  sendIgnoredNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
  sendRemoveIgnoredNode(nodeNum: number, destinationNodeNum?: number): Promise<void>;
}

function mgr(sourceId: string | null): MeshSendManager {
  if (!sourceId) throw new Error('automation action requires a target source');
  const m = sourceManagerRegistry.getManager(sourceId) as unknown as MeshSendManager | undefined;
  if (!m || typeof m.sendTextMessage !== 'function') {
    throw new Error(`source "${sourceId}" cannot send messages (not a Meshtastic manager)`);
  }
  return m;
}

export function createMeshActionDeps(): ActionDeps {
  return {
    async sendMessage({ sourceId, text, channel, destination, replyId }) {
      return mgr(sourceId).sendTextMessage(text, channel ?? 0, destination, replyId, 0);
    },

    async sendTapback({ sourceId, emoji, channel, destination, replyId }) {
      // emoji flag = 1 marks a tapback/reaction; route the way the trigger arrived.
      return mgr(sourceId).sendTextMessage(emoji, channel ?? 0, destination, replyId, 1);
    },

    async manageNode({ sourceId, nodeNum, op }) {
      const m = mgr(sourceId);
      switch (op) {
        case 'favorite': return m.sendFavoriteNode(nodeNum);
        case 'unfavorite': return m.sendRemoveFavoriteNode(nodeNum);
        case 'ignore': return m.sendIgnoredNode(nodeNum);
        case 'unignore': return m.sendRemoveIgnoredNode(nodeNum);
        case 'delete': {
          if (!sourceId) throw new Error('automation delete action requires a target source');
          await databaseService.deleteNodeAsync(nodeNum, sourceId);
          return;
        }
        default:
          throw new Error(`unsupported node op "${op}"`);
      }
    },

    async notify({ title, body }) {
      // TODO(#3653): wire to appriseNotificationService once a per-source notify
      // helper exists. Until then, surface clearly and fail this step only.
      logger.warn(`[AutomationEngine] notify action not yet wired — would send "${title}: ${body}"`);
      throw new Error('notify action is not yet available');
    },
  };
}
