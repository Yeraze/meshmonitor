/**
 * Favorites management (#3962 Phase 4.2a PR4 §4c).
 *
 * Extracted from MeshtasticManager: firmware favorites-support detection,
 * sending set/remove-favorite admin commands (fire-and-forget and
 * await-ack), and the auto-favorite check/sweep that (un)favorites 0-hop
 * nodes automatically.
 *
 * Wiring choice — `AdminTransactionService` is injected DIRECTLY (as a
 * second constructor arg), not reached via `this.mgr.sendAdminCommand(...)`:
 * `sendFavoriteNodeAwaitAck` is a pure request/response correlation with the
 * ack service and has no other manager-level side effects, so bouncing
 * through the manager's thin delegate would only add a hop with no
 * behavioral difference (the delegate just forwards to the same service
 * instance). Direct injection also decouples this service's construction
 * from the manager continuing to expose those delegates unchanged — spec §4e
 * (PR5, out of scope here) will add several more `AdminTransactionService`
 * consumers on the manager itself, and this service shouldn't need to change
 * if that surface moves around.
 *
 * Deviation from spec §4c's field list — `favoritesSupportCache` and
 * `autoFavoritingNodes` are NOT physically moved here, unlike
 * `autoFavoriteSweepRunning` (which IS a private field on this service).
 * Both are still poked directly by pinned tests that this PR must leave
 * unchanged (`meshtasticManager.favoritesSupport.test.ts` reads/relies on
 * `(mgr as any).favoritesSupportCache`; `meshtasticManager.passiveMode.test.ts`
 * seeds/asserts the same field across `handleDisconnected()`;
 * `meshtasticManager.autoFavorite.perSource.test.ts` resets
 * `manager.autoFavoritingNodes` directly between cases). Moving the fields
 * would silently desync those tests' direct pokes from the state this
 * service actually reads. Same rationale as `deviceNodeNums` staying on the
 * manager for `nodeDbMaintenanceService` — the fields stay put, bridged via
 * narrow accessors (`getFavoritesSupportCache`/`setFavoritesSupportCache`,
 * `isAutoFavoritingNode`/`addAutoFavoritingNode`/`removeAutoFavoritingNode`).
 * The three call sites that reset `favoritesSupportCache` outside these
 * methods (disconnect x2, firmware-metadata update) are untouched — they
 * still write the manager's own field directly, so no accessor was needed
 * for them.
 *
 * `checkAutoFavorite`/`autoFavoriteSweep` call `this.mgr.supportsFavorites()`
 * / `this.mgr.sendFavoriteNode()` / `this.mgr.sendRemoveFavoriteNode()`
 * (the manager's public delegates) rather than their own sibling methods
 * (`this.supportsFavorites()` etc.) on this service. Before extraction all
 * of these lived on one class, so `meshtasticManager.autoFavorite.perSource
 * .test.ts` monkey-patches `manager.sendFavoriteNode`/
 * `manager.sendRemoveFavoriteNode`/`manager.supportsFavorites` directly and
 * relies on `checkAutoFavorite`/`autoFavoriteSweep` (also on the manager back
 * then) picking up the override via `this.`. Routing through `this.mgr.*`
 * preserves that seam post-extraction; `sendFavoriteNode`/
 * `sendRemoveFavoriteNode`/`sendFavoriteNodeAwaitAck` themselves still call
 * their own `this.supportsFavorites()` since nothing monkey-patches through
 * them.
 *
 * Import-cycle discipline (task42a_spec.md §3): constructor-injected
 * `import type` references, never a static value import. `parseFirmwareVersion`
 * and `localNodeSettingKey` are `private` on MeshtasticManager and shared with
 * unmoved manager code (`firmwareVersionAtLeast`/many other call sites), so
 * — same pattern as `logOutgoingPacket` in `adminTransactionService.ts` and
 * `replaceAnnouncementTokens` in `autoAnnounceService.ts` — they were widened
 * from `private` to (default) public rather than duplicated or narrowly
 * wrapped.
 */
import type { MeshtasticManager } from '../meshtasticManager.js';
import type { AdminTransactionService } from './adminTransactionService.js';
import databaseService from '../../services/database.js';
import protobufService from '../protobufService.js';
import { isAutoFavoriteEligible } from '../constants/autoFavorite.js';
import { logger } from '../../utils/logger.js';

export class FavoritesService {
  private autoFavoriteSweepRunning = false;  // Prevent concurrent sweep operations

  constructor(
    private readonly mgr: MeshtasticManager,
    private readonly adminTx: AdminTransactionService,
  ) {}

  /**
   * Check if the local device firmware supports favorites feature (>= 2.7.0)
   * Result is cached to avoid redundant parsing and version comparisons
   */
  supportsFavorites(): boolean {
    const firmwareVersion = this.mgr.getLocalNodeInfo()?.firmwareVersion;

    // Firmware version not known yet (e.g. DeviceMetadata not received). Return
    // false but DO NOT cache it — otherwise the `false` sticks even after the
    // version is populated through a path that doesn't clear the cache.
    if (!firmwareVersion) {
      logger.debug('⚠️ Firmware version unknown, cannot determine favorites support');
      return false;
    }

    // Cache hit only when it was computed from the current firmware version.
    const cache = this.mgr.getFavoritesSupportCache();
    if (cache?.version === firmwareVersion) {
      return cache.result;
    }

    const version = this.mgr.parseFirmwareVersion(firmwareVersion);
    if (!version) {
      logger.debug(`⚠️ Could not parse firmware version: ${firmwareVersion}`);
      this.mgr.setFavoritesSupportCache({ version: firmwareVersion, result: false });
      return false;
    }

    // Favorites feature added in 2.7.0
    const supportsFavorites = version.major > 2 || (version.major === 2 && version.minor >= 7);

    if (!supportsFavorites) {
      logger.debug(`ℹ️ Firmware ${firmwareVersion} does not support favorites (requires >= 2.7.0)`);
    } else {
      logger.debug(`✅ Firmware ${firmwareVersion} supports favorites`);
    }

    this.mgr.setFavoritesSupportCache({ version: firmwareVersion, result: supportsFavorites });
    return supportsFavorites;
  }

  /**
   * Send admin message to set a node as favorite on the device
   */
  async sendFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support
    if (!this.supportsFavorites()) {
      throw new Error('FIRMWARE_NOT_SUPPORTED');
    }

    const localNodeNum = this.mgr.getLocalNodeInfo()?.nodeNum || 0;
    const destNode = destinationNodeNum || localNodeNum;
    const isRemote = destNode !== localNodeNum && destNode !== 0;

    try {
      let sessionPasskey: Uint8Array = new Uint8Array();
      if (isRemote) {
        const cached = this.mgr.getSessionPasskey(destNode);
        if (cached) {
          sessionPasskey = cached;
        } else {
          const requested = await this.mgr.requestRemoteSessionPasskey(destNode);
          if (!requested) throw new Error(`Failed to obtain session passkey for remote node ${destNode}`);
          sessionPasskey = requested;
        }
      }

      const setFavoriteMsg = protobufService.createSetFavoriteNodeMessage(nodeNum, sessionPasskey);
      await this.adminTx.sendAdminCommand(setFavoriteMsg, destNode);
      logger.debug(`⭐ Sent set_favorite_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')}) to ${isRemote ? 'remote' : 'local'} node ${destNode}`);
    } catch (error) {
      logger.error('❌ Error sending favorite node admin message:', error);
      throw error;
    }
  }

  /**
   * Send admin message to remove a node from favorites on the device
   */
  async sendRemoveFavoriteNode(nodeNum: number, destinationNodeNum?: number): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    // Check firmware version support
    if (!this.supportsFavorites()) {
      throw new Error('FIRMWARE_NOT_SUPPORTED');
    }

    const localNodeNum = this.mgr.getLocalNodeInfo()?.nodeNum || 0;
    const destNode = destinationNodeNum || localNodeNum;
    const isRemote = destNode !== localNodeNum && destNode !== 0;

    try {
      let sessionPasskey: Uint8Array = new Uint8Array();
      if (isRemote) {
        const cached = this.mgr.getSessionPasskey(destNode);
        if (cached) {
          sessionPasskey = cached;
        } else {
          const requested = await this.mgr.requestRemoteSessionPasskey(destNode);
          if (!requested) throw new Error(`Failed to obtain session passkey for remote node ${destNode}`);
          sessionPasskey = requested;
        }
      }

      const removeFavoriteMsg = protobufService.createRemoveFavoriteNodeMessage(nodeNum, sessionPasskey);
      await this.adminTx.sendAdminCommand(removeFavoriteMsg, destNode);
      logger.debug(`☆ Sent remove_favorite_node for ${nodeNum} (!${nodeNum.toString(16).padStart(8, '0')}) to ${isRemote ? 'remote' : 'local'} node ${destNode}`);
    } catch (error) {
      logger.error('❌ Error sending remove favorite node admin message:', error);
      throw error;
    }
  }

  /**
   * Send a set_favorite_node admin command and wait for its ACK. Handles the
   * remote session-passkey handshake exactly like sendFavoriteNode.
   */
  async sendFavoriteNodeAwaitAck(
    nodeNum: number,
    destinationNodeNum?: number,
    timeoutMs: number = 30000
  ): Promise<{ acked: boolean; errorReason: number | null; timedOut: boolean }> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }
    if (!this.supportsFavorites()) {
      throw new Error('FIRMWARE_NOT_SUPPORTED');
    }
    const localNodeNum = this.mgr.getLocalNodeInfo()?.nodeNum || 0;
    const destNode = destinationNodeNum || localNodeNum;
    const isRemote = destNode !== localNodeNum && destNode !== 0;

    let sessionPasskey: Uint8Array = new Uint8Array();
    if (isRemote) {
      const cached = this.mgr.getSessionPasskey(destNode);
      if (cached) {
        sessionPasskey = cached;
      } else {
        const requested = await this.mgr.requestRemoteSessionPasskey(destNode);
        if (!requested) throw new Error(`Failed to obtain session passkey for remote node ${destNode}`);
        sessionPasskey = requested;
      }
    }

    const setFavoriteMsg = protobufService.createSetFavoriteNodeMessage(nodeNum, sessionPasskey);
    const result = await this.adminTx.sendAdminCommandAwaitAck(setFavoriteMsg, destNode, timeoutMs);
    logger.debug(`⭐ set_favorite_node ${nodeNum} → node ${destNode}: acked=${result.acked} timedOut=${result.timedOut} err=${result.errorReason}`);
    return { acked: result.acked, errorReason: result.errorReason, timedOut: result.timedOut };
  }

  async checkAutoFavorite(nodeNum: number, nodeId: string): Promise<void> {
    try {
      const autoFavoriteEnabled = await databaseService.settings.getSettingForSource(this.mgr.sourceId, 'autoFavoriteEnabled');
      if (autoFavoriteEnabled !== 'true') {
        return;
      }

      // Routed through the manager's public delegate (not `this.supportsFavorites()`)
      // so that a test double which overrides `manager.supportsFavorites` directly
      // (meshtasticManager.autoFavorite.perSource.test.ts) is honored — see
      // favoritesService.ts's header comment.
      if (!this.mgr.supportsFavorites()) {
        return;
      }

      // Skip local node (read the per-source identity key so named sources don't
      // read another source's local node and short-circuit incorrectly).
      const localNodeNum = await databaseService.settings.getSetting(this.mgr.localNodeSettingKey('localNodeNum'));
      if (localNodeNum && parseInt(localNodeNum) === nodeNum) {
        return;
      }

      // Prevent duplicate concurrent operations
      if (this.mgr.isAutoFavoritingNode(nodeNum)) {
        return;
      }

      // Get local node role (scoped to this source — nodes table has composite PK (nodeNum, sourceId))
      const localNodeNumInt = localNodeNum ? parseInt(localNodeNum) : this.mgr.getLocalNodeInfo()?.nodeNum;
      if (!localNodeNumInt) return;
      const localNode = await databaseService.nodes.getNode(localNodeNumInt, this.mgr.sourceId);
      if (!localNode) return;

      const targetNode = await databaseService.nodes.getNode(nodeNum, this.mgr.sourceId);
      if (!targetNode) return;

      // Skip nodes where favoriteLocked is true — user has manually managed this node
      if (targetNode.favoriteLocked) return;

      // Check if already in auto-favorite list (backward compat belt-and-suspenders)
      const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(this.mgr.sourceId, 'autoFavoriteNodes') || '[]';
      const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);
      if (autoFavoriteNodes.includes(nodeNum)) {
        return; // Already auto-managed
      }

      // Check eligibility
      if (!isAutoFavoriteEligible(localNode.role, targetNode)) {
        return;
      }

      this.mgr.addAutoFavoritingNode(nodeNum);
      try {
        // Mark in DB — favoriteLocked=false since this is auto-managed
        await databaseService.nodes.setNodeFavorite(nodeNum, true, this.mgr.sourceId, false);

        // Sync to device — routed through the manager delegate, same rationale
        // as the `this.mgr.supportsFavorites()` call above.
        try {
          await this.mgr.sendFavoriteNode(nodeNum);
          logger.debug(`⭐ Auto-favorited node ${nodeId} (${targetNode.longName || 'Unknown'}) - 0-hop, role=${targetNode.role}`);
        } catch (error) {
          logger.warn(`⚠️ Auto-favorited node ${nodeId} in DB but device sync failed:`, error);
        }

        // Add to auto-favorite tracking list (per-source)
        autoFavoriteNodes.push(nodeNum);
        await databaseService.settings.setSourceSetting(this.mgr.sourceId, 'autoFavoriteNodes', JSON.stringify(autoFavoriteNodes));
      } finally {
        this.mgr.removeAutoFavoritingNode(nodeNum);
      }
    } catch (error) {
      logger.error('❌ Error in auto-favorite check:', error);
    }
  }

  async autoFavoriteSweep(): Promise<void> {
    if (this.autoFavoriteSweepRunning) return;
    this.autoFavoriteSweepRunning = true;
    try {
      const autoFavoriteEnabled = await databaseService.settings.getSettingForSource(this.mgr.sourceId, 'autoFavoriteEnabled');
      const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(this.mgr.sourceId, 'autoFavoriteNodes') || '[]';
      const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);

      if (autoFavoriteNodes.length === 0) {
        return;
      }

      // If feature was disabled, clean up all auto-favorited nodes (skip locked ones)
      if (autoFavoriteEnabled !== 'true') {
        logger.debug(`🧹 Auto-favorite disabled, cleaning up ${autoFavoriteNodes.length} auto-favorited nodes`);
        for (const nodeNum of autoFavoriteNodes) {
          try {
            const node = await databaseService.nodes.getNode(nodeNum, this.mgr.sourceId);
            if (node?.favoriteLocked) {
              logger.debug(`Skipping locked node ${nodeNum} during auto-favorite cleanup`);
              continue;
            }
            await databaseService.nodes.setNodeFavorite(nodeNum, false, this.mgr.sourceId, false);
            // Routed through the manager's public delegates — same rationale as
            // the `this.mgr.supportsFavorites()` call in checkAutoFavorite above.
            if (this.mgr.supportsFavorites() && this.mgr.isDeviceConnected()) {
              await this.mgr.sendRemoveFavoriteNode(nodeNum);
            }
          } catch (error) {
            logger.warn(`⚠️ Failed to unfavorite node ${nodeNum} during cleanup:`, error);
          }
        }
        await databaseService.settings.setSourceSetting(this.mgr.sourceId, 'autoFavoriteNodes', '[]');
        return;
      }

      if (!this.mgr.supportsFavorites()) return;

      const staleHours = parseInt(await databaseService.settings.getSettingForSource(this.mgr.sourceId, 'autoFavoriteStaleHours') || '72');
      const staleThreshold = Date.now() / 1000 - (staleHours * 3600);

      // Get local node role for re-evaluation (scoped to this source — both the
      // identity key and the node lookup are per-source).
      const localNodeNum = await databaseService.settings.getSetting(this.mgr.localNodeSettingKey('localNodeNum'));
      const localNodeNumInt = localNodeNum ? parseInt(localNodeNum) : this.mgr.getLocalNodeInfo()?.nodeNum;
      const localNode = localNodeNumInt ? await databaseService.nodes.getNode(localNodeNumInt, this.mgr.sourceId) : null;

      const nodesToRemove: number[] = [];

      for (const nodeNum of autoFavoriteNodes) {
        const node = await databaseService.nodes.getNode(nodeNum, this.mgr.sourceId);
        if (!node) {
          nodesToRemove.push(nodeNum);
          continue;
        }

        // Skip nodes where favoriteLocked is true — user has manually managed this node
        if (node.favoriteLocked) {
          continue;
        }

        let shouldRemove = false;
        let reason = '';

        // Check staleness
        if (node.lastHeard && node.lastHeard < staleThreshold) {
          shouldRemove = true;
          reason = `stale (not heard in ${staleHours}+ hours)`;
        }

        // Check hops changed
        if (!shouldRemove && (node.hopsAway == null || node.hopsAway > 0)) {
          shouldRemove = true;
          reason = `no longer 0-hop (hopsAway=${node.hopsAway})`;
        }

        // Check if received via MQTT (not a true RF neighbor)
        if (!shouldRemove && node.viaMqtt === true) {
          shouldRemove = true;
          reason = 'received via MQTT';
        }

        // Check role eligibility changed (for ROUTER/ROUTER_LATE local)
        if (!shouldRemove && localNode) {
          if (!isAutoFavoriteEligible(localNode.role, { ...node, isFavorite: false })) {
            shouldRemove = true;
            reason = 'no longer eligible (role changed)';
          }
        }

        if (shouldRemove) {
          nodesToRemove.push(nodeNum);
          try {
            await databaseService.nodes.setNodeFavorite(nodeNum, false, this.mgr.sourceId, false);
            if (this.mgr.isDeviceConnected()) {
              await this.mgr.sendRemoveFavoriteNode(nodeNum);
            }
            const nodeId = node.nodeId || `!${nodeNum.toString(16).padStart(8, '0')}`;
            logger.debug(`☆ Auto-unfavorited node ${nodeId} (${node.longName || 'Unknown'}) - ${reason}`);
          } catch (error) {
            logger.warn(`⚠️ Failed to auto-unfavorite node ${nodeNum}:`, error);
          }
        }
      }

      // Update the tracking list (per-source)
      if (nodesToRemove.length > 0) {
        const removeSet = new Set(nodesToRemove);
        const remaining = autoFavoriteNodes.filter(n => !removeSet.has(n));
        await databaseService.settings.setSourceSetting(this.mgr.sourceId, 'autoFavoriteNodes', JSON.stringify(remaining));
        logger.debug(`🧹 Auto-favorite sweep: removed ${nodesToRemove.length}, remaining ${remaining.length}`);
      }
    } catch (error) {
      logger.error('❌ Error in auto-favorite sweep:', error);
    } finally {
      this.autoFavoriteSweepRunning = false;
    }
  }
}
