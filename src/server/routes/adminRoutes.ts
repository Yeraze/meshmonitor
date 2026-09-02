/**
 * Admin Routes
 *
 * All handlers require requireAdmin(). Covers remote-favorites target config,
 * device config load/export/import, channel/owner load, device metadata,
 * reboot/set-time, suppressed-ghost management, and the generic admin
 * command dispatcher.
 *
 * Extracted verbatim from server.ts (was 17 inline `apiRouter.*('/admin/...')`
 * handlers interleaved with the settings block, L2985–L4531 pre-extraction)
 * as part of #3502 PR2. Mounted at '/admin' in server.ts. `bytesToBase64` and
 * `AUTO_FAVORITE_DEFAULTS` moved here as module-private — this route group is
 * their sole consumer.
 */
import express from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAdmin } from '../auth/authMiddleware.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { getRoutingErrorName, MESH_BEACON_MESSAGE_MAX_BYTES } from '../constants/meshtastic.js';
import { CONFIG_TYPE_MAP, MODULE_FIELD_BY_ID, DEVICE_FIELD_BY_ID } from '../constants/configTypes.js';
import { autoFavoriteManagementScheduler } from '../services/autoFavoriteManagementService.js';
import protobufService from '../protobufService.js';
import { fail, ok } from '../utils/apiResponse.js';
import { isTxDisabledError } from '../errors/txDisabledError.js';
import {
  adminOperationService,
  type AdminOperationStatus,
  type AdminOperationResult,
} from '../services/adminOperationService.js';
import { isValidMeshtasticKey, derivePublicKey, normalizeMeshtasticKey } from '../utils/meshtasticKeys.js';

const router = express.Router();

/** Convert protobuf bytes (Uint8Array, Buffer, byte array, or object) to base64 string */
function bytesToBase64(key: any): string {
  if (key instanceof Uint8Array || Buffer.isBuffer(key)) {
    return Buffer.from(key).toString('base64');
  }
  if (key && typeof key === 'object' && key.type === 'Buffer' && Array.isArray(key.data)) {
    return Buffer.from(key.data).toString('base64');
  }
  if (Array.isArray(key)) {
    return Buffer.from(key).toString('base64');
  }
  if (typeof key === 'string') {
    return key;
  }
  // Handle generic iterables/objects with byte data (e.g., protobuf Bytes wrappers)
  if (key && typeof key === 'object') {
    try {
      return Buffer.from(Object.values(key) as number[]).toString('base64');
    } catch {
      // fall through
    }
  }
  logger.warn('Unknown admin key format:', typeof key, key);
  return '';
}

// ---------------------------------------------------------------------------
// Automated Remote Favorites Management (issue #2608)
// Per-source, per-target config for keeping favorites up to date on remote
// infrastructure nodes via Remote Admin. Admin-only.
// ---------------------------------------------------------------------------

const AUTO_FAVORITE_DEFAULTS = {
  enabled: false,
  useNeighborInfo: true,
  useTraceroutes: true,
  intervalHours: 24,
  maxNewPerCycle: 1,
  maxRefavoritePerCycle: 1,
  maxNeighborAgeHours: 24,
  eligibleRoles: [2, 11, 12], // Router, Router Late, Client Base
};


router.get('/auto-favorite-targets/:nodeNum', requireAdmin(), async (req, res) => {
  try {
    const targetNodeNum = Number(req.params.nodeNum);
    const sourceId = (req.query.sourceId as string) || undefined;
    if (!Number.isFinite(targetNodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required' });
    }

    const config = await databaseService.autoFavoriteTargets.getTarget(sourceId, targetNodeNum);
    const assignments = config
      ? await databaseService.autoFavoriteTargets.getAssignments(sourceId, targetNodeNum)
      : [];

    if (!config) {
      return res.json({
        configured: false,
        sourceId,
        targetNodeNum,
        ...AUTO_FAVORITE_DEFAULTS,
        lastRunAt: null,
        lastNeighborRequestAt: null,
        assignments: [],
      });
    }

    res.json({
      configured: true,
      sourceId,
      targetNodeNum,
      enabled: config.enabled,
      useNeighborInfo: config.useNeighborInfo,
      useTraceroutes: config.useTraceroutes,
      intervalHours: config.intervalHours,
      maxNewPerCycle: config.maxNewPerCycle,
      maxRefavoritePerCycle: config.maxRefavoritePerCycle,
      maxNeighborAgeHours: config.maxNeighborAgeHours,
      eligibleRoles: (() => { try { return JSON.parse(config.eligibleRoles); } catch { return AUTO_FAVORITE_DEFAULTS.eligibleRoles; } })(),
      lastRunAt: config.lastRunAt ?? null,
      lastNeighborRequestAt: config.lastNeighborRequestAt ?? null,
      assignments: assignments.map((a) => ({
        favoriteNodeNum: a.favoriteNodeNum,
        discoverySource: a.discoverySource ?? null,
        firstAssignedAt: a.firstAssignedAt,
        lastAssignedAt: a.lastAssignedAt,
        lastAckStatus: a.lastAckStatus ?? null,
        lastAckAt: a.lastAckAt ?? null,
      })),
    });
  } catch (error) {
    logger.error('Error fetching auto-favorite target config:', error);
    res.status(500).json({ error: 'Failed to fetch auto-favorite config' });
  }
});

router.put('/auto-favorite-targets/:nodeNum', requireAdmin(), async (req, res) => {
  try {
    const targetNodeNum = Number(req.params.nodeNum);
    const { sourceId } = req.body ?? {};
    if (!Number.isFinite(targetNodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    if (!sourceId || typeof sourceId !== 'string') {
      return res.status(400).json({ error: 'sourceId is required' });
    }

    const b = req.body ?? {};
    const clampInt = (v: any, def: number, min: number) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= min ? n : def;
    };
    const roles = Array.isArray(b.eligibleRoles)
      ? b.eligibleRoles.map((r: any) => Number(r)).filter((r: number) => Number.isFinite(r))
      : AUTO_FAVORITE_DEFAULTS.eligibleRoles;

    await databaseService.autoFavoriteTargets.upsertTarget({
      sourceId,
      targetNodeNum,
      enabled: b.enabled === true,
      useNeighborInfo: b.useNeighborInfo !== false,
      useTraceroutes: b.useTraceroutes !== false,
      intervalHours: clampInt(b.intervalHours, AUTO_FAVORITE_DEFAULTS.intervalHours, 1),
      maxNeighborAgeHours: clampInt(b.maxNeighborAgeHours, AUTO_FAVORITE_DEFAULTS.maxNeighborAgeHours, 0),
      maxNewPerCycle: clampInt(b.maxNewPerCycle, AUTO_FAVORITE_DEFAULTS.maxNewPerCycle, 0),
      maxRefavoritePerCycle: clampInt(b.maxRefavoritePerCycle, AUTO_FAVORITE_DEFAULTS.maxRefavoritePerCycle, 0),
      eligibleRoles: JSON.stringify(roles),
    });

    void databaseService.auditLogAsync(
      req.user!.id,
      'auto_favorite_config',
      'admin',
      `Updated auto-favorite config for target ${targetNodeNum} (source ${sourceId}): enabled=${b.enabled === true}`,
      req.ip || null,
      null,
      null
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Error saving auto-favorite target config:', error);
    res.status(500).json({ error: 'Failed to save auto-favorite config' });
  }
});

router.delete('/auto-favorite-targets/:nodeNum', requireAdmin(), async (req, res) => {
  try {
    const targetNodeNum = Number(req.params.nodeNum);
    const sourceId = (req.query.sourceId as string) || (req.body && req.body.sourceId) || undefined;
    if (!Number.isFinite(targetNodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    await databaseService.autoFavoriteTargets.deleteTarget(sourceId, targetNodeNum);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting auto-favorite target config:', error);
    res.status(500).json({ error: 'Failed to delete auto-favorite config' });
  }
});

router.post('/auto-favorite-targets/:nodeNum/run', requireAdmin(), async (req, res) => {
  try {
    const targetNodeNum = Number(req.params.nodeNum);
    const { sourceId } = req.body ?? {};
    if (!Number.isFinite(targetNodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    if (!sourceId || typeof sourceId !== 'string') {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    const result = await autoFavoriteManagementScheduler.runCycleNow(sourceId, targetNodeNum);
    res.json(result);
  } catch (error) {
    logger.error('Error running auto-favorite cycle:', error);
    res.status(500).json({ error: 'Failed to run auto-favorite cycle' });
  }
});

router.post('/load-config', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, configType, channelIndex, sourceId: adminLoadSourceId } = req.body;

    if (!configType) {
      return res.status(400).json({ error: 'configType is required' });
    }

    const adminLoadManager = resolveSourceManager(adminLoadSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (adminLoadManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = adminLoadManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    let config: any = null;

    try {
      if (isLocalNode) {
        // Local node - use existing config or request it
        let currentConfig = adminLoadManager.getCurrentConfig();
        
        // Canonical config/module type registry (see configTypes.ts). Previously
        // this local-node branch used an incomplete inline copy that omitted
        // power/display/serial/etc., so a local GET of those configs 400'd with
        // "Unknown config type"; using the full registry resolves that.
        const configInfo = CONFIG_TYPE_MAP[configType];
        if (!configInfo && configType !== 'channel') {
          return res.status(400).json({ error: `Unknown config type: ${configType}` });
        }

        // Check if we need to request the specific config type
        let needsRequest = false;
        if (configInfo) {
          if (configInfo.isModule) {
            const moduleKey = MODULE_FIELD_BY_ID[configType];
            if (moduleKey && !currentConfig?.moduleConfig?.[moduleKey]) needsRequest = true;
          } else {
            const deviceKey = DEVICE_FIELD_BY_ID[configType];
            if (deviceKey && !currentConfig?.deviceConfig?.[deviceKey]) needsRequest = true;
          }
        }
        
        if (needsRequest && configInfo) {
          // Try to request the specific config type
          logger.debug(`Config type '${configType}' not available, requesting from device...`);
          try {
            if (configInfo.isModule) {
              await adminLoadManager.requestModuleConfig(configInfo.type);
            } else {
              await adminLoadManager.requestConfig(configInfo.type);
            }
            // Wait a bit for response
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (error) {
            logger.warn(`Failed to request ${configType} config:`, error);
          }

          // Check again
          const retryConfig = adminLoadManager.getCurrentConfig();
          if (!retryConfig) {
            return res.status(404).json({ error: `Device configuration not yet loaded. Please ensure the device is connected and try again in a few seconds.` });
          }
          // Use the retried config
          currentConfig = retryConfig;
        }
        
        const finalConfig = currentConfig;
        
        switch (configType) {
          case 'device':
            if (finalConfig.deviceConfig?.device) {
              config = {
                role: finalConfig.deviceConfig.device.role,
                nodeInfoBroadcastSecs: finalConfig.deviceConfig.device.nodeInfoBroadcastSecs,
                rebroadcastMode: finalConfig.deviceConfig.device.rebroadcastMode,
                tzdef: finalConfig.deviceConfig.device.tzdef,
                doubleTapAsButtonPress: finalConfig.deviceConfig.device.doubleTapAsButtonPress,
                disableTripleClick: finalConfig.deviceConfig.device.disableTripleClick,
                ledHeartbeatDisabled: finalConfig.deviceConfig.device.ledHeartbeatDisabled,
                buzzerMode: finalConfig.deviceConfig.device.buzzerMode,
                buttonGpio: finalConfig.deviceConfig.device.buttonGpio,
                buzzerGpio: finalConfig.deviceConfig.device.buzzerGpio,
              };
            } else {
              return res.status(404).json({ error: 'Device config not available. The device may not have sent its configuration yet.' });
            }
            break;
          case 'lora':
            if (finalConfig.deviceConfig?.lora) {
              config = {
                usePreset: finalConfig.deviceConfig.lora.usePreset,
                modemPreset: finalConfig.deviceConfig.lora.modemPreset,
                bandwidth: finalConfig.deviceConfig.lora.bandwidth,
                spreadFactor: finalConfig.deviceConfig.lora.spreadFactor,
                codingRate: finalConfig.deviceConfig.lora.codingRate,
                frequencyOffset: finalConfig.deviceConfig.lora.frequencyOffset,
                overrideFrequency: finalConfig.deviceConfig.lora.overrideFrequency,
                region: finalConfig.deviceConfig.lora.region,
                hopLimit: finalConfig.deviceConfig.lora.hopLimit,
                txPower: finalConfig.deviceConfig.lora.txPower,
                channelNum: finalConfig.deviceConfig.lora.channelNum,
                sx126xRxBoostedGain: finalConfig.deviceConfig.lora.sx126xRxBoostedGain,
                ignoreMqtt: finalConfig.deviceConfig.lora.ignoreMqtt,
                configOkToMqtt: finalConfig.deviceConfig.lora.configOkToMqtt,
                femLnaMode: finalConfig.deviceConfig.lora.femLnaMode
              };
            } else {
              return res.status(404).json({ error: 'LoRa config not available. The device may not have sent its configuration yet.' });
            }
            break;
          case 'position':
            if (finalConfig.deviceConfig?.position) {
              config = {
                positionBroadcastSecs: finalConfig.deviceConfig.position.positionBroadcastSecs,
                positionBroadcastSmartEnabled: finalConfig.deviceConfig.position.positionBroadcastSmartEnabled,
                fixedPosition: finalConfig.deviceConfig.position.fixedPosition,
                fixedAltitude: finalConfig.deviceConfig.position.fixedAltitude,
                gpsUpdateInterval: finalConfig.deviceConfig.position.gpsUpdateInterval,
                positionFlags: finalConfig.deviceConfig.position.positionFlags,
                rxGpio: finalConfig.deviceConfig.position.rxGpio,
                txGpio: finalConfig.deviceConfig.position.txGpio,
                broadcastSmartMinimumDistance: finalConfig.deviceConfig.position.broadcastSmartMinimumDistance,
                broadcastSmartMinimumIntervalSecs: finalConfig.deviceConfig.position.broadcastSmartMinimumIntervalSecs,
                gpsEnGpio: finalConfig.deviceConfig.position.gpsEnGpio,
                gpsMode: finalConfig.deviceConfig.position.gpsMode,
                // Fixed lat/lng are not in PositionConfig protobuf - they're stored as the node's position
                // When fixedPosition is true, fetch from database
                fixedLatitude: 0,
                fixedLongitude: 0
              };
              // If fixedPosition is enabled, get the coordinates from the node's stored position.
              // Scope to adminLoadSourceId so multi-source deployments resolve the correct
              // copy of the local node — otherwise we might pull fixedPosition coords from a
              // stale row on a different source that shares the same nodeNum.
              // Use the effective position so a user-set override takes precedence over the
              // device-reported lat/lon — that's the position the user wants displayed and
              // pushed back to the device when saving the config (issue #2847).
              if (finalConfig.deviceConfig.position.fixedPosition && localNodeNum) {
                const nodeData = await databaseService.nodes.getNode(localNodeNum, adminLoadSourceId);
                const eff = getEffectiveDbNodePosition(nodeData);
                if (eff.latitude != null && eff.longitude != null) {
                  config.fixedLatitude = eff.latitude;
                  config.fixedLongitude = eff.longitude;
                }
                if (eff.altitude != null) {
                  config.fixedAltitude = eff.altitude;
                }
              }
            } else {
              return res.status(404).json({ error: 'Position config not available. The device may not have sent its configuration yet.' });
            }
            break;
          case 'mqtt':
            if (finalConfig.moduleConfig?.mqtt) {
              config = {
                enabled: finalConfig.moduleConfig.mqtt.enabled || false,
                address: finalConfig.moduleConfig.mqtt.address || '',
                username: finalConfig.moduleConfig.mqtt.username || '',
                password: finalConfig.moduleConfig.mqtt.password || '',
                encryptionEnabled: finalConfig.moduleConfig.mqtt.encryptionEnabled !== false,
                jsonEnabled: finalConfig.moduleConfig.mqtt.jsonEnabled || false,
                root: finalConfig.moduleConfig.mqtt.root || ''
              };
            } else {
              // MQTT config might not exist if it's not configured, return empty config
              config = {
                enabled: false,
                address: '',
                username: '',
                password: '',
                encryptionEnabled: true,
                jsonEnabled: false,
                root: ''
              };
            }
            break;
          case 'security':
            if (finalConfig.deviceConfig?.security) {
              // Convert admin keys from Uint8Array to base64 strings for UI
              const localAdminKeys = finalConfig.deviceConfig.security.adminKey || [];
              config = {
                adminKeys: localAdminKeys.map((key: any) => bytesToBase64(key)),
                isManaged: finalConfig.deviceConfig.security.isManaged,
                serialEnabled: finalConfig.deviceConfig.security.serialEnabled,
                debugLogApiEnabled: finalConfig.deviceConfig.security.debugLogApiEnabled,
                adminChannelEnabled: finalConfig.deviceConfig.security.adminChannelEnabled
              };
            } else {
              return res.status(404).json({ error: 'Security config not available. The device may not have sent its configuration yet.' });
            }
            break;
          // Additional device configs - return raw config for now
          case 'power':
          case 'network':
          case 'display':
          case 'bluetooth':
          case 'sessionkey':
          case 'deviceui':
            const deviceConfigKey = configType === 'sessionkey' ? 'sessionkey' : configType;
            if (finalConfig.deviceConfig?.[deviceConfigKey]) {
              config = finalConfig.deviceConfig[deviceConfigKey];
            } else {
              return res.status(404).json({ error: `${configType} config not available. The device may not have sent its configuration yet.` });
            }
            break;
          // Additional module configs - return raw config for now
          case 'serial':
          case 'extnotif':
          case 'storeforward':
          case 'rangetest':
          case 'telemetry':
          case 'cannedmsg':
          case 'audio':
          case 'remotehardware':
          case 'neighborinfo':
          case 'ambientlighting':
          case 'detectionsensor':
          case 'paxcounter':
          case 'statusmessage':
          case 'trafficmanagement':
          case 'meshbeacon':
            const moduleKey = MODULE_FIELD_BY_ID[configType];
            if (moduleKey && finalConfig.moduleConfig?.[moduleKey]) {
              config = finalConfig.moduleConfig[moduleKey];
            } else {
              // Module configs might not exist if not configured, return empty/default config
              config = { enabled: false };
            }
            break;
        }
      } else {
        // Remote node - request config with session passkey
        logger.debug(`Requesting ${configType} config from remote node ${destinationNodeNum}`);
        
        // Canonical config/module type registry (see configTypes.ts).
        const configInfo = CONFIG_TYPE_MAP[configType];
        if (!configInfo) {
          return res.status(400).json({ error: `Unknown config type: ${configType}` });
        }

        // Request config from remote node
        const remoteConfig = await adminLoadManager.requestRemoteConfig(
          destinationNodeNum,
          configInfo.type,
          configInfo.isModule
        );

        if (!remoteConfig) {
          return res.status(404).json({ error: `Config type '${configType}' not received from remote node ${destinationNodeNum}. The node may not be reachable or may not have responded.` });
        }

        // Format the response based on config type
        switch (configType) {
          case 'device':
            config = {
              role: remoteConfig.role,
              nodeInfoBroadcastSecs: remoteConfig.nodeInfoBroadcastSecs,
              rebroadcastMode: remoteConfig.rebroadcastMode,
              tzdef: remoteConfig.tzdef,
              doubleTapAsButtonPress: remoteConfig.doubleTapAsButtonPress,
              disableTripleClick: remoteConfig.disableTripleClick,
              ledHeartbeatDisabled: remoteConfig.ledHeartbeatDisabled,
              buzzerMode: remoteConfig.buzzerMode,
              buttonGpio: remoteConfig.buttonGpio,
              buzzerGpio: remoteConfig.buzzerGpio,
            };
            break;
          case 'lora':
            config = {
              usePreset: remoteConfig.usePreset,
              modemPreset: remoteConfig.modemPreset,
              bandwidth: remoteConfig.bandwidth,
              spreadFactor: remoteConfig.spreadFactor,
              codingRate: remoteConfig.codingRate,
              frequencyOffset: remoteConfig.frequencyOffset,
              overrideFrequency: remoteConfig.overrideFrequency,
              region: remoteConfig.region,
              hopLimit: remoteConfig.hopLimit,
              txPower: remoteConfig.txPower,
              channelNum: remoteConfig.channelNum,
              sx126xRxBoostedGain: remoteConfig.sx126xRxBoostedGain,
              ignoreMqtt: remoteConfig.ignoreMqtt,
              configOkToMqtt: remoteConfig.configOkToMqtt,
              femLnaMode: remoteConfig.femLnaMode
            };
            break;
          case 'position':
            config = {
              positionBroadcastSecs: remoteConfig.positionBroadcastSecs,
              positionBroadcastSmartEnabled: remoteConfig.positionBroadcastSmartEnabled,
              fixedPosition: remoteConfig.fixedPosition,
              fixedAltitude: remoteConfig.fixedAltitude,
              gpsUpdateInterval: remoteConfig.gpsUpdateInterval,
              positionFlags: remoteConfig.positionFlags,
              rxGpio: remoteConfig.rxGpio,
              txGpio: remoteConfig.txGpio,
              broadcastSmartMinimumDistance: remoteConfig.broadcastSmartMinimumDistance,
              broadcastSmartMinimumIntervalSecs: remoteConfig.broadcastSmartMinimumIntervalSecs,
              gpsEnGpio: remoteConfig.gpsEnGpio,
              gpsMode: remoteConfig.gpsMode,
              // Fixed lat/lng are not in PositionConfig protobuf - they're stored as the node's position
              fixedLatitude: 0,
              fixedLongitude: 0
            };
            // If fixedPosition is enabled, get the coordinates from the node's stored position.
            // Scope to adminLoadSourceId so the remote node lookup resolves the row
            // belonging to the source the admin is operating on. Honor any user-set
            // position override so the displayed/saved fixed coords match the user's
            // intent rather than the device's stale value (issue #2847).
            if (remoteConfig.fixedPosition) {
              const nodeData = await databaseService.nodes.getNode(destinationNodeNum, adminLoadSourceId);
              const eff = getEffectiveDbNodePosition(nodeData);
              if (eff.latitude != null && eff.longitude != null) {
                config.fixedLatitude = eff.latitude;
                config.fixedLongitude = eff.longitude;
              }
              if (eff.altitude != null) {
                config.fixedAltitude = eff.altitude;
              }
            }
            break;
          case 'mqtt':
            config = {
              enabled: remoteConfig.enabled || false,
              address: remoteConfig.address || '',
              username: remoteConfig.username || '',
              password: remoteConfig.password || '',
              encryptionEnabled: remoteConfig.encryptionEnabled !== false,
              jsonEnabled: remoteConfig.jsonEnabled || false,
              root: remoteConfig.root || ''
            };
            break;
          case 'security':
            // Convert admin keys from Uint8Array to base64 strings for UI
            const remoteAdminKeys = remoteConfig.adminKey || [];
            config = {
              adminKeys: remoteAdminKeys.map((key: any) => bytesToBase64(key)),
              isManaged: remoteConfig.isManaged,
              serialEnabled: remoteConfig.serialEnabled,
              debugLogApiEnabled: remoteConfig.debugLogApiEnabled,
              adminChannelEnabled: remoteConfig.adminChannelEnabled
            };
            break;
          // Additional device configs - return raw config
          case 'power':
          case 'network':
          case 'display':
          case 'bluetooth':
          case 'sessionkey':
          case 'deviceui':
            config = remoteConfig;
            break;
          // Additional module configs - return raw config
          case 'serial':
          case 'extnotif':
          case 'storeforward':
          case 'rangetest':
          case 'telemetry':
          case 'cannedmsg':
          case 'audio':
          case 'remotehardware':
          case 'neighborinfo':
          case 'ambientlighting':
          case 'detectionsensor':
          case 'paxcounter':
          case 'statusmessage':
          case 'trafficmanagement':
          case 'meshbeacon':
            config = remoteConfig || { enabled: false };
            break;
        }
      }

      // Handle channel config (works for both local and remote)
      if (configType === 'channel') {
        if (channelIndex === undefined) {
          return res.status(400).json({ error: 'channelIndex is required for channel config' });
        }
        if (isLocalNode) {
          // Request channel config
          await adminLoadManager.requestConfig(0); // CHANNEL_CONFIG = 0
          // Note: Channel config loading requires waiting for response, which is complex
          // For now, return a placeholder
          config = {
            name: '',
            psk: '',
            role: channelIndex === 0 ? 1 : 0,
            uplinkEnabled: false,
            downlinkEnabled: false,
            positionPrecision: 32
          };
        } else {
          // Remote node channel config not yet supported
          return res.status(501).json({ error: 'Channel config loading from remote nodes is not yet supported' });
        }
      }

      if (!config && configType !== 'channel') {
        return res.status(400).json({ error: `Unknown config type: ${configType}` });
      }

      res.json({ config });
    } catch (error: unknown) {
      if (isTxDisabledError(error)) {
        return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error loading ${configType} config:`, error);
      res.status(500).json({ error: `Failed to load ${configType} config: ${message}` });
    }
  } catch (error: any) {
    logger.error('Error in load-config endpoint:', error);
    res.status(500).json({ error: error.message || 'Failed to load config' });
  }
});

router.post('/ensure-session-passkey', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, sourceId: espSourceId } = req.body;

    const espManager = resolveSourceManager(espSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (espManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = espManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // Local node doesn't need session passkey
      return res.json({ success: true, message: 'Local node does not require session passkey' });
    }

    // Already cached — answer immediately, no mesh round-trip needed.
    const cachedPasskey = espManager.getSessionPasskey(destinationNodeNum);
    if (cachedPasskey) {
      return res.json({
        success: true,
        message: 'Session passkey available',
        ...espManager.getSessionPasskeyStatus(destinationNodeNum)
      });
    }

    // Acquisition costs up to 45s of mesh time. Holding the request open for
    // that is what produced upstream 502s (#4482), so hand back an operation
    // id and finish in the background.
    const operation = adminOperationService.create({
      command: 'ensureSessionPasskey',
      sourceId: espManager.sourceId,
      destinationNodeNum,
      userId: req.session?.userId ?? null,
    });

    void (async () => {
      try {
        adminOperationService.setStatus(operation.id, 'awaiting_passkey');
        logger.debug(`Requesting session passkey for remote node ${destinationNodeNum}`);
        const passkey = await espManager.requestRemoteSessionPasskey(destinationNodeNum);
        if (!passkey) {
          adminOperationService.fail(operation.id, {
            code: 'PASSKEY_TIMEOUT',
            message: `Failed to obtain session passkey for remote node ${destinationNodeNum}`,
          });
          return;
        }
        adminOperationService.succeed(operation.id, {
          message: 'Session passkey available',
          ...espManager.getSessionPasskeyStatus(destinationNodeNum),
        });
      } catch (error) {
        if (isTxDisabledError(error)) {
          adminOperationService.fail(operation.id, { code: 'TX_DISABLED', message: 'Transmit is disabled on this source' });
          return;
        }
        logger.error(`Error ensuring session passkey (operation ${operation.id}):`, error);
        const coded = error as { code?: string; message?: string } | null;
        adminOperationService.fail(operation.id, {
          code: coded?.code || 'PASSKEY_FAILED',
          message: coded?.message || 'Failed to ensure session passkey',
        });
      }
    })();

    return res.status(202).json({
      success: true,
      operationId: operation.id,
      status: operation.status,
      message: `Session passkey requested for node ${destinationNodeNum}`,
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error ensuring session passkey:', error);
    return fail(res, 500, 'PASSKEY_FAILED', error.message || 'Failed to ensure session passkey');
  }
});

router.post('/session-passkey-status', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, sourceId: spsSourceId } = req.body;

    const spsManager = resolveSourceManager(spsSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (spsManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = spsManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      return res.json({
        success: true,
        isLocalNode: true,
        hasPasskey: true,
        expiresAt: null,
        remainingSeconds: null
      });
    }

    const status = spsManager.getSessionPasskeyStatus(destinationNodeNum);
    return res.json({ success: true, isLocalNode: false, ...status });
  } catch (error: any) {
    logger.error('Error getting session passkey status:', error);
    res.status(500).json({ error: error.message || 'Failed to get session passkey status' });
  }
});

router.post('/get-channel', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, channelIndex, sourceId: gcSourceId } = req.body;

    if (channelIndex === undefined) {
      return res.status(400).json({ error: 'channelIndex is required' });
    }

    const gcManager = resolveSourceManager(gcSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (gcManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = gcManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // For local node, get from database (scoped to source — #3712)
      const gcScopedSourceId = typeof gcSourceId === 'string' && gcSourceId.length > 0 ? gcSourceId : undefined;
      const channel = await databaseService.channels.getChannelById(channelIndex, gcScopedSourceId);
      if (channel) {
        return res.json({ channel: {
          name: channel.name || '',
          psk: channel.psk || '',
          role: channel.role !== undefined ? channel.role : (channelIndex === 0 ? 1 : 0),
          uplinkEnabled: channel.uplinkEnabled !== undefined ? channel.uplinkEnabled : false,
          downlinkEnabled: channel.downlinkEnabled !== undefined ? channel.downlinkEnabled : false,
          positionPrecision: channel.positionPrecision !== undefined ? channel.positionPrecision : 32
        }});
      } else {
        return res.json({ channel: {
          name: '',
          psk: '',
          role: channelIndex === 0 ? 1 : 0,
          uplinkEnabled: false,
          downlinkEnabled: false,
          positionPrecision: 32
        }});
      }
    } else {
      // For remote node, request channel
      const channel = await gcManager.requestRemoteChannel(destinationNodeNum, channelIndex);
      if (channel) {
        // Convert channel response to our format
        // Protobuf may use snake_case or camelCase depending on how it's decoded
        const settings = channel.settings || {};
        
        // Handle both camelCase and snake_case field names
        const name = settings.name || '';
        const psk = settings.psk;
        const pskString = psk ? (Buffer.isBuffer(psk) ? Buffer.from(psk).toString('base64') : (typeof psk === 'string' ? psk : Buffer.from(psk).toString('base64'))) : '';
        
        // Handle both camelCase and snake_case for boolean fields
        const uplinkEnabled = settings.uplinkEnabled !== undefined ? settings.uplinkEnabled : 
                             (settings.uplink_enabled !== undefined ? settings.uplink_enabled : true);
        const downlinkEnabled = settings.downlinkEnabled !== undefined ? settings.downlinkEnabled : 
                               (settings.downlink_enabled !== undefined ? settings.downlink_enabled : true);
        
        // Handle module settings (may be moduleSettings or module_settings)
        const moduleSettings = settings.moduleSettings || settings.module_settings || {};
        const positionPrecision = moduleSettings.positionPrecision !== undefined ? moduleSettings.positionPrecision :
                                 (moduleSettings.position_precision !== undefined ? moduleSettings.position_precision : 32);
        
        logger.debug(`📡 Converting channel ${channelIndex} from remote node ${destinationNodeNum}`, {
          name,
          hasPsk: !!psk,
          role: channel.role,
          uplinkEnabled,
          downlinkEnabled,
          positionPrecision,
          settingsKeys: Object.keys(settings),
          moduleSettingsKeys: Object.keys(moduleSettings)
        });
        
        return res.json({ channel: {
          name: name,
          psk: pskString,
          role: channel.role !== undefined ? channel.role : (channelIndex === 0 ? 1 : 0),
          uplinkEnabled: uplinkEnabled,
          downlinkEnabled: downlinkEnabled,
          positionPrecision: positionPrecision
        }});
      } else {
        // Channel not received - could be timeout, doesn't exist, or not configured
        // Return 404 but with a more descriptive message
        logger.debug(`⚠️ Channel ${channelIndex} not received from remote node ${destinationNodeNum} (timeout or not configured)`);
        return res.status(404).json({ error: `Channel ${channelIndex} not received from remote node ${destinationNodeNum}. The channel may not exist, may be disabled, or the request timed out.` });
      }
    }
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error getting channel:', error);
    res.status(500).json({ error: error.message || 'Failed to get channel' });
  }
});

router.post('/load-owner', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, sourceId: loSourceId } = req.body;

    const loManager = resolveSourceManager(loSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (loManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = loManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // For local node, use cached info and database (public key is obtained from security config at connection)
      const localNodeInfo = loManager.getLocalNodeInfo();
      if (localNodeInfo) {
        // Get the public key from database if available (stored from security config).
        // Scope the lookup to loSourceId so we read the local node row for this
        // specific source, not a possibly-stale row with the same nodeNum on
        // another source.
        let publicKeyBase64: string | undefined;
        // #3684: read the persisted User capability flags so the Config tab's
        // "Unmessageable"/"Licensed" checkboxes reflect the local node's actual
        // setting instead of always showing unchecked. nodeNum may be absent
        // before the local node row exists — fall back to false in that case.
        let isUnmessagable = false;
        let isLicensed = false;
        if (localNodeInfo.nodeNum) {
          const nodeData = await databaseService.nodes.getNode(localNodeInfo.nodeNum, loSourceId);
          publicKeyBase64 = nodeData?.publicKey || undefined;
          isUnmessagable = nodeData?.isUnmessagable ?? false;
          isLicensed = nodeData?.isLicensed ?? false;
        }
        return res.json({ owner: {
          longName: localNodeInfo.longName || '' ,
          shortName: localNodeInfo.shortName || '' ,
          isUnmessagable,
          isLicensed,
          publicKey: publicKeyBase64
        }});
      } else {
        return res.status(404).json({ error: 'Local node information not available' });
      }
    } else {
      // For remote node, request owner info
      const owner = await loManager.requestRemoteOwner(destinationNodeNum);
      if (owner) {
        return res.json({ owner: {
          longName: owner.longName || '' ,
          shortName: owner.shortName || '' ,
          isUnmessagable: owner.isUnmessagable || false,
          isLicensed: owner.isLicensed || false
        }});
      } else {
        return res.status(404).json({ error: `Owner info not received from remote node ${destinationNodeNum}` });
      }
    }
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error getting owner:', error);
    res.status(500).json({ error: error.message || 'Failed to get owner info' });
  }
});

router.post('/get-device-metadata', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, sourceId: gdmSourceId } = req.body;

    const gdmManager = resolveSourceManager(gdmSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (gdmManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = gdmManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // For local node, return cached device metadata from local node info
      const localNodeInfo = gdmManager.getLocalNodeInfo();
      if (localNodeInfo) {
        // Get node data from database for additional info.
        // Scope to gdmSourceId so multi-source deployments read the row
        // belonging to the source whose device metadata is being requested.
        const nodeData = localNodeInfo.nodeNum ? await databaseService.nodes.getNode(localNodeInfo.nodeNum, gdmSourceId) : null;
        return res.json({
          deviceMetadata: {
            firmwareVersion: localNodeInfo.firmwareVersion || 'Unknown',
            hwModel: nodeData?.hwModel || 0,
            role: nodeData?.role || 0,
            // Capability flags captured from the local node's DeviceMetadata
            // (undefined until metadata arrives — coerce to false for the wire).
            hasWifi: localNodeInfo.hasWifi ?? false,
            hasBluetooth: localNodeInfo.hasBluetooth ?? false,
            hasEthernet: localNodeInfo.hasEthernet ?? false,
            hasXeddsa: localNodeInfo.hasXeddsa ?? false,
            isBridged: gdmManager.isLocalNodeBridged(),
            canShutdown: false,
            hasRemoteHardware: false,
            deviceStateVersion: 0,
            positionFlags: 0
          }
        });
      } else {
        return res.status(404).json({ error: 'Local node information not available' });
      }
    } else {
      // For remote node, request device metadata
      const metadata = await gdmManager.requestRemoteDeviceMetadata(destinationNodeNum);
      if (metadata) {
        // Successfully retrieved metadata - update hasRemoteAdmin flag and save metadata
        try {
          await databaseService.updateNodeRemoteAdminStatusAsync(
            destinationNodeNum,
            true,
            JSON.stringify(metadata),
            gdmManager.sourceId
          );
          logger.debug(`✅ Updated hasRemoteAdmin=true and saved metadata for node ${destinationNodeNum}`);
        } catch (dbError) {
          logger.error(`Failed to save remote admin status for node ${destinationNodeNum}:`, dbError);
          // Continue with response even if database update fails
        }

        return res.json({
          deviceMetadata: {
            firmwareVersion: metadata.firmwareVersion || 'Unknown',
            deviceStateVersion: metadata.deviceStateVersion || 0,
            canShutdown: metadata.canShutdown || false,
            hasWifi: metadata.hasWifi || false,
            hasBluetooth: metadata.hasBluetooth || false,
            hasEthernet: metadata.hasEthernet || false,
            role: metadata.role || 0,
            positionFlags: metadata.positionFlags || 0,
            hwModel: metadata.hwModel || 0,
            hasRemoteHardware: metadata.hasRemoteHardware || false,
            // Read-only build capability added in firmware 2.8 (DeviceMetadata
            // field 14): whether XEdDSA packet signature verification is
            // compiled in. Distinguishes "this node cannot sign" from "this
            // node did not sign this packet" (#3923).
            hasXeddsa: metadata.hasXeddsa || false
          }
        });
      } else {
        return res.status(404).json({ error: `Device metadata not received from remote node ${destinationNodeNum}` });
      }
    }
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error getting device metadata:', error);
    res.status(500).json({ error: error.message || 'Failed to get device metadata' });
  }
});

router.post('/reboot', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, seconds = 10, sourceId: arSourceId } = req.body;

    const arManager = resolveSourceManager(arSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (arManager.getLocalNodeInfo()?.nodeNum || 0);

    await arManager.sendRebootCommand(destinationNodeNum, Number(seconds));

    logger.debug(`✅ Sent reboot command to node ${destinationNodeNum} (in ${seconds} seconds)`);
    res.json({ success: true, message: `Reboot command sent (node will reboot in ${seconds} seconds)` });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending reboot command:', error);
    res.status(500).json({ error: error.message || 'Failed to send reboot command' });
  }
});

router.get('/suppressed-ghosts', requireAdmin(), async (_req, res) => {
  try {
    const suppressed = await databaseService.getSuppressedGhostNodesAsync();
    res.json({ success: true, suppressedNodes: suppressed });
  } catch (error: any) {
    logger.error('Error getting suppressed ghosts:', error);
    res.status(500).json({ error: error.message || 'Failed to get suppressed ghosts' });
  }
});

router.delete('/suppressed-ghosts/:nodeNum', requireAdmin(), async (req, res) => {
  try {
    const nodeNum = Number(req.params.nodeNum);
    if (isNaN(nodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    await databaseService.unsuppressGhostNodeAsync(nodeNum);
    res.json({ success: true, message: `Unsuppressed node !${nodeNum.toString(16).padStart(8, '0')}` });
  } catch (error: any) {
    logger.error('Error unsuppressing ghost:', error);
    res.status(500).json({ error: error.message || 'Failed to unsuppress ghost' });
  }
});

router.post('/set-time', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, sourceId: astSourceId } = req.body;

    const astManager = resolveSourceManager(astSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (astManager.getLocalNodeInfo()?.nodeNum || 0);

    await astManager.sendSetTimeCommand(destinationNodeNum);

    logger.debug(`✅ Sent set-time command to node ${destinationNodeNum}`);
    res.json({ success: true, message: 'Time sync command sent successfully' });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error sending set-time command:', error);
    res.status(500).json({ error: error.message || 'Failed to send set-time command' });
  }
});

router.post('/export-config', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, channelIds, includeLoraConfig, sourceId: aecSourceId } = req.body;

    if (!Array.isArray(channelIds)) {
      return res.status(400).json({ error: 'channelIds must be an array' });
    }

    const aecManager = resolveSourceManager(aecSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (aecManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = aecManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    const channelUrlService = (await import('../services/channelUrlService.js')).default;

    // Get channels from local or remote node
    const aecScopedSourceId = typeof aecSourceId === 'string' && aecSourceId.length > 0 ? aecSourceId : undefined;
    const channels = [];
    for (const channelId of channelIds) {
      if (isLocalNode) {
        // Scoped to source (#3712) so the local-node export path reads this
        // source's channel row, not the first matching source.
        const channel = await databaseService.channels.getChannelById(channelId, aecScopedSourceId);
        if (channel) {
          channels.push({
            psk: channel.psk ? channel.psk : 'none',
            name: channel.name,
            uplinkEnabled: channel.uplinkEnabled,
            downlinkEnabled: channel.downlinkEnabled,
            positionPrecision: channel.positionPrecision,
          });
        }
      } else {
        // For remote node, fetch channel
        const channel = await aecManager.requestRemoteChannel(destinationNodeNum, channelId);
        if (channel) {
          const settings = channel.settings || {};
          const name = settings.name || '';
          const psk = settings.psk;
          let pskString = '';
          if (psk) {
            if (Buffer.isBuffer(psk)) {
              pskString = psk.toString('base64');
            } else if (psk instanceof Uint8Array) {
              pskString = Buffer.from(psk).toString('base64');
            } else if (typeof psk === 'string') {
              pskString = psk;
            } else {
              try {
                pskString = Buffer.from(psk as any).toString('base64');
              } catch (e) {
                logger.warn(`Failed to convert PSK for channel ${channelId}:`, e);
              }
            }
          }
          const moduleSettings = settings.moduleSettings || settings.module_settings || {};
          channels.push({
            psk: pskString && pskString !== 'AQ==' ? pskString : 'none',
            name: name,
            uplinkEnabled: settings.uplinkEnabled !== undefined ? settings.uplinkEnabled : 
                          (settings.uplink_enabled !== undefined ? settings.uplink_enabled : true),
            downlinkEnabled: settings.downlinkEnabled !== undefined ? settings.downlinkEnabled : 
                            (settings.downlink_enabled !== undefined ? settings.downlink_enabled : true),
            positionPrecision: moduleSettings.positionPrecision !== undefined ? moduleSettings.positionPrecision :
                              (moduleSettings.position_precision !== undefined ? moduleSettings.position_precision : 32),
          });
        }
      }
    }

    if (channels.length === 0) {
      return res.status(400).json({ error: 'No valid channels selected' });
    }

    // Get LoRa config if requested
    let loraConfig = undefined;
    if (includeLoraConfig) {
      if (isLocalNode) {
        const deviceConfig = await aecManager.getDeviceConfig();
        if (deviceConfig?.lora) {
          loraConfig = {
            usePreset: deviceConfig.lora.usePreset,
            modemPreset: deviceConfig.lora.modemPreset,
            bandwidth: deviceConfig.lora.bandwidth,
            spreadFactor: deviceConfig.lora.spreadFactor,
            codingRate: deviceConfig.lora.codingRate,
            frequencyOffset: deviceConfig.lora.frequencyOffset,
            region: deviceConfig.lora.region,
            hopLimit: deviceConfig.lora.hopLimit,
            txEnabled: deviceConfig.lora.txEnabled,
            txPower: deviceConfig.lora.txPower,
            channelNum: deviceConfig.lora.channelNum,
            sx126xRxBoostedGain: deviceConfig.lora.sx126xRxBoostedGain,
            configOkToMqtt: deviceConfig.lora.configOkToMqtt,
          };
        }
      } else {
        // For remote node, fetch LoRa config
        const loraConfigData = await aecManager.requestRemoteConfig(destinationNodeNum, 5, false); // LORA_CONFIG = 5
        if (loraConfigData) {
          loraConfig = {
            usePreset: loraConfigData.usePreset,
            modemPreset: loraConfigData.modemPreset,
            bandwidth: loraConfigData.bandwidth,
            spreadFactor: loraConfigData.spreadFactor,
            codingRate: loraConfigData.codingRate,
            frequencyOffset: loraConfigData.frequencyOffset,
            region: loraConfigData.region,
            hopLimit: loraConfigData.hopLimit,
            txEnabled: loraConfigData.txEnabled,
            txPower: loraConfigData.txPower,
            channelNum: loraConfigData.channelNum,
            sx126xRxBoostedGain: loraConfigData.sx126xRxBoostedGain,
            configOkToMqtt: loraConfigData.configOkToMqtt,
          };
        }
      }
    }

    const url = channelUrlService.encodeUrl(channels, loraConfig);

    if (!url) {
      return res.status(500).json({ error: 'Failed to encode URL' });
    }

    res.json({ url });
  } catch (error) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error exporting configuration:', error);
    res.status(500).json({ error: 'Failed to export configuration' });
  }
});

router.post('/import-config', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, url: configUrl, sourceId: aicSourceId } = req.body;

    if (!configUrl || typeof configUrl !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const aicManager = resolveSourceManager(aicSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (aicManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = aicManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    logger.debug(`📥 Importing configuration from URL to node ${destinationNodeNum}: ${configUrl}`);

    const channelUrlService = (await import('../services/channelUrlService.js')).default;

    // Decode the URL to get channels and lora config
    const decoded = channelUrlService.decodeUrl(configUrl);

    if (!decoded || (!decoded.channels && !decoded.loraConfig)) {
      return res.status(400).json({ error: 'Invalid or empty configuration URL' });
    }

    logger.debug(`📥 Decoded ${decoded.channels?.length || 0} channels, LoRa config: ${!!decoded.loraConfig}`);

    // Explicitly typed: inference no longer reaches the pushes now that they
    // happen inside the runImport thunk below.
    const importedChannels: Array<{ index: number; name: string }> = [];
    const failedChannels: Array<{ index: number; name: string }> = [];
    let loraImported = false;
    let requiresReboot = false;

    // The import body below is wrapped in a thunk rather than being awaited
    // inline: importing to a REMOTE node blocks on the session passkey (up to
    // 45s) and then a burst of admin sends, which is exactly the HTTP hold that
    // produced upstream 502s (#4482). Local imports still await it directly.
    //
    // Its contents are deliberately left at their original indentation so the
    // diff stays reviewable — only the wrapper lines are new. That makes the
    // `return { ... }` at the end read like a handler-level return; it is the
    // thunk's.
    //
    // The thunk mutates `importedChannels`/`loraImported`/`requiresReboot` from
    // the enclosing scope. Safe because it runs exactly once per request — the
    // local path awaits it, the remote path hands it to a single detached
    // closure — but it is NOT reusable or independently testable as written.
    // Anything that would call it twice must hoist that state inside first.
    const runImport = async () => {
    if (isLocalNode) {
      // Use existing local import logic
      try {
        await aicManager.beginEditSettings();
        // Pacing: device firmware silently drops admin packets that arrive too soon
        // after BeginEditSettings on TCP PhoneAPI. See /channels/import-config for details.
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error(`❌ Failed to begin edit settings transaction:`, error);
        throw new Error('Failed to start configuration transaction');
      }

      // Import channels
      if (decoded.channels && decoded.channels.length > 0) {
        for (let i = 0; i < decoded.channels.length; i++) {
          const channel = decoded.channels[i];
          try {
            let role = channel.role;
            if (role === undefined) {
              role = i === 0 ? 1 : 2;
            }
            await aicManager.setChannelConfig(i, {
              name: channel.name || '',
              psk: channel.psk === 'none' ? undefined : channel.psk,
              role: role,
              uplinkEnabled: channel.uplinkEnabled,
              downlinkEnabled: channel.downlinkEnabled,
              positionPrecision: channel.positionPrecision,
            });
            // Pacing between admin packets — same firmware drop pattern.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            importedChannels.push({ index: i, name: channel.name || '(unnamed)' });
          } catch (error) {
            logger.error(`❌ Failed to import channel ${i}:`, error);
          }
        }
      }

      // Import LoRa config
      if (decoded.loraConfig) {
        try {
          // Preserve the device's current txEnabled rather than importing the
          // URL's value (issue #4294) — local-node import via setLoRaConfig,
          // which sends the device the ENTIRE LoRaConfig struct (whole-message
          // replace, not a patch). proto3 decodes an omitted bool as false, so
          // stripping the key would silently reach the radio as
          // txEnabled=false and kill TX (the #1328 mechanism that motivated
          // the original, overly-broad force-true). Backfill explicitly with
          // the device's actual current value instead.
          const loraConfigToImport = {
            ...decoded.loraConfig,
            txEnabled: aicManager.isTxEnabled(),
          };
          await aicManager.setLoRaConfig(loraConfigToImport);
          // Pacing: LoRa config triggers heavier device processing; allow extra time
          // before commit so the device has finished applying it.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          loraImported = true;
          requiresReboot = true;
        } catch (error) {
          logger.error(`❌ Failed to import LoRa config:`, error);
        }
      }

      await aicManager.commitEditSettings();
    } else {
      // For remote node, use admin commands via aicManager
      // Ensure session passkey
      //
      // TODO(#4482): this passkey is acquired once and reused for every send
      // below. Session passkeys carry a TTL (see getSessionPasskeyStatus), so a
      // long import over a slow link can outlive it and the later sends then go
      // out with a stale key. Pre-existing, but running detached makes it more
      // reachable — a re-check (and re-acquire) between sends is the fix.
      let sessionPasskey = aicManager.getSessionPasskey(destinationNodeNum);
      if (!sessionPasskey) {
        sessionPasskey = await aicManager.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Import channels using admin commands
      if (decoded.channels && decoded.channels.length > 0) {
        for (let i = 0; i < decoded.channels.length; i++) {
          const channel = decoded.channels[i];
          try {
            let role = channel.role;
            if (role === undefined) {
              role = i === 0 ? 1 : 2;
            }
            const adminMessage = protobufService.createSetChannelMessage(i, {
              name: channel.name || '',
              psk: channel.psk === 'none' ? undefined : channel.psk,
              role: role,
              uplinkEnabled: channel.uplinkEnabled,
              downlinkEnabled: channel.downlinkEnabled,
              positionPrecision: channel.positionPrecision,
            }, sessionPasskey);
            await aicManager.sendAdminCommand(adminMessage, destinationNodeNum);
            importedChannels.push({ index: i, name: channel.name || '(unnamed)' });
            // Pacing between admin commands — remote node travels via radio so
            // gaps are mostly airtime-bound, but the device-side admin handler
            // exhibits the same drop pattern as local TCP under burst.
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (error) {
            // Individual channel failures don't abort the import (pre-existing
            // behavior), but they must not vanish either — running detached
            // means the caller has no log to correlate against, so record them
            // and report the count in the result.
            logger.error(`❌ Failed to import channel ${i}:`, error);
            failedChannels.push({ index: i, name: channel.name || '(unnamed)' });
          }
        }
      }

      // Import LoRa config using admin command
      if (decoded.loraConfig) {
        try {
          // Preserve the remote device's current txEnabled rather than
          // importing the URL's value (issue #4294) — same whole-struct-
          // replace / proto3-missing-bool-defaults-to-false hazard as the
          // local branch above (setLoRaConfig / createSetLoRaConfigMessage
          // sends the ENTIRE LoRaConfig; an omitted key reaches the radio as
          // txEnabled=false), so we must supply an explicit value, never
          // strip the key.
          //
          // Fully-accurate remote preserve (issue #4315): fetch the remote
          // node's LIVE LoRa config first and reuse its actual txEnabled. This
          // import flow is already a slow multi-round-trip path (per-channel
          // pacing above), so one more requestRemoteConfig round-trip (session
          // passkey + mesh RTT) is acceptable. Interpret the result with the
          // same semantics as the local branch's isTxEnabled() — txEnabled is
          // disabled only when it is explicitly `false`; a present-but-not-false
          // (incl. proto3-omitted) value means enabled/fail-open.
          //
          // Fallbacks, if the live fetch fails/times out: the manager's cached
          // remote-config snapshot (populated by an earlier /load-config or
          // /export-config), then the decoded URL's own txEnabled (real since
          // #4294's export fix; older exported URLs may still carry the old
          // forced `true`), and finally true (fail-open).
          let remoteTxEnabled: boolean | undefined;
          try {
            const liveRemoteLora = await aicManager.requestRemoteConfig(destinationNodeNum, 5, false); // LORA_CONFIG = 5
            if (liveRemoteLora) {
              remoteTxEnabled = liveRemoteLora.txEnabled !== false;
            }
          } catch (error) {
            logger.warn(`⚠️ Could not fetch live remote LoRa config for txEnabled preserve on node ${destinationNodeNum}; falling back to cached/URL value:`, error);
          }
          if (remoteTxEnabled === undefined) {
            const cachedRemoteLora = aicManager.getRemoteNodeConfig(destinationNodeNum)?.deviceConfig?.lora;
            // Cached snapshot comes from the same requestRemoteConfig source as
            // the live fetch above, so interpret it with the same
            // isTxEnabled()-style semantics (disabled only when explicitly
            // false). Only when there is no cached LoRa snapshot at all do we
            // consult the decoded URL's own txEnabled, then fail-open true.
            remoteTxEnabled = cachedRemoteLora
              ? cachedRemoteLora.txEnabled !== false
              : (decoded.loraConfig.txEnabled ?? true);
          }
          const loraConfigToImport = {
            ...decoded.loraConfig,
            txEnabled: remoteTxEnabled,
          };
          const adminMessage = protobufService.createSetLoRaConfigMessage(loraConfigToImport, sessionPasskey);
          await aicManager.sendAdminCommand(adminMessage, destinationNodeNum);
          loraImported = true;
          requiresReboot = true;
        } catch (error) {
          logger.error(`❌ Failed to import LoRa config:`, error);
        }
      }
    }

    return {
      imported: {
        channels: importedChannels.length,
        channelDetails: importedChannels,
        loraConfig: loraImported,
        // Additive: a partial import previously reported only its successes,
        // so a caller could not tell "3 channels" from "3 of 5 channels".
        failedChannels: failedChannels.length,
        failedChannelDetails: failedChannels,
      },
      requiresReboot,
    };
    };

    if (isLocalNode) {
      const result = await runImport();
      return res.json({ success: true, ...result });
    }

    // Remote import: accept now, finish on the mesh's schedule (#4482).
    const operation = adminOperationService.create({
      command: 'importConfig',
      sourceId: aicManager.sourceId,
      destinationNodeNum,
      userId: req.session?.userId ?? null,
    });

    void (async () => {
      try {
        adminOperationService.setStatus(operation.id, 'awaiting_passkey');
        const result = await runImport();
        adminOperationService.succeed(operation.id, {
          message: `Configuration imported to node ${destinationNodeNum}`,
          ...result,
        });
      } catch (error) {
        if (isTxDisabledError(error)) {
          adminOperationService.fail(operation.id, { code: 'TX_DISABLED', message: 'Transmit is disabled on this source' });
          return;
        }
        logger.error(`Error importing configuration (operation ${operation.id}):`, error);
        const coded = error as { code?: string; message?: string } | null;
        adminOperationService.fail(operation.id, {
          code: coded?.code || 'IMPORT_CONFIG_FAILED',
          message: coded?.message || 'Failed to import configuration',
        });
      }
    })();

    return res.status(202).json({
      success: true,
      operationId: operation.id,
      status: operation.status,
      message: `Configuration import accepted for node ${destinationNodeNum}`,
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error importing configuration:', error);
    return fail(res, 500, 'IMPORT_CONFIG_FAILED', error.message || 'Failed to import configuration');
  }
});

/**
 * Commands whose REMOTE form waits for the destination's routing ACK, so the
 * caller learns whether the node actually applied the change.
 *
 * Favorites already did this. Ignore/unignore did not (#4482 part B) — they
 * fired and forgot, so a remote ignore "succeeded" instantly and could never be
 * confirmed. Now that the wait no longer occupies an HTTP socket, there is no
 * reason for the asymmetry.
 */
const ACK_AWAITED_COMMANDS = new Set([
  'setFavoriteNode',
  'removeFavoriteNode',
  'setIgnoredNode',
  'removeIgnoredNode',
]);

/** Error carrying a SCREAMING_SNAKE machine code for the operation record. */
function adminError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Loose bag of per-command parameters off the request body. */
type AdminCommandParams = Record<string, unknown>;

/**
 * The slice of the source manager the admin executor drives. Narrower than
 * ISourceManager, which does not declare the remote-admin surface.
 */
interface AdminCapableManager {
  sourceId: string;
  getSessionPasskey(nodeNum: number): Uint8Array | null;
  requestRemoteSessionPasskey(nodeNum: number): Promise<Uint8Array | null>;
  sendAdminCommand(message: Uint8Array, nodeNum: number): Promise<void>;
  sendAdminCommandAwaitAck(
    message: Uint8Array,
    nodeNum: number,
  ): Promise<{ acked: boolean; errorReason: number | null; timedOut: boolean }>;
  updateCachedDeviceConfig(section: string, config: Record<string, unknown>): void;
}

/** Security-config fields mirrored into the cached device config after a send. */
interface SecurityConfigParams {
  isManaged?: boolean;
  serialEnabled?: boolean;
  debugLogApiEnabled?: boolean;
  adminChannelEnabled?: boolean;
}

/**
 * The mesh-blocking half of an admin command: acquire the session passkey,
 * build and send the packet, optionally wait for the routing ACK, then apply
 * post-send side effects.
 *
 * Split out of the route handler so the local path can await it directly while
 * the remote path runs it in the background behind an operation id (#4482).
 * Parameter validation deliberately stays in the handler — a bad request must
 * still fail fast with a 400 rather than becoming a failed async operation.
 */
async function executeAdminCommand(ctx: {
  command: string;
  params: AdminCommandParams;
  acManager: AdminCapableManager;
  destinationNodeNum: number;
  localNodeNum: number;
  isLocalNode: boolean;
  buildAdminMessage: (sessionPasskey?: Uint8Array) => Uint8Array;
  preSend: ((sessionPasskey?: Uint8Array) => Promise<void>) | null;
  onStatus?: (status: AdminOperationStatus) => void;
}): Promise<AdminOperationResult> {
  const {
    command, params, acManager, destinationNodeNum, localNodeNum,
    isLocalNode, buildAdminMessage, preSend, onStatus,
  } = ctx;

  // 1. Session passkey (remote only) — the 45s leg.
  let sessionPasskey: Uint8Array | undefined;
  if (!isLocalNode) {
    const cached = acManager.getSessionPasskey(destinationNodeNum);
    if (cached) {
      logger.debug(`🔑 Using cached session passkey for admin command to remote node ${destinationNodeNum}`);
      sessionPasskey = cached;
    } else {
      logger.debug(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one for admin command...`);
      onStatus?.('awaiting_passkey');
      const fetched = await acManager.requestRemoteSessionPasskey(destinationNodeNum);
      if (!fetched) {
        logger.error(`❌ Failed to obtain session passkey for remote node ${destinationNodeNum} after 45s`);
        throw adminError(
          'PASSKEY_TIMEOUT',
          `Failed to obtain session passkey for remote node ${destinationNodeNum}. The node may be unreachable or not responding.`,
        );
      }
      sessionPasskey = fetched;
    }
  }

  // 2. Build and send.
  onStatus?.('sending');
  if (preSend) {
    await preSend(sessionPasskey);
  }
  const adminMessage = buildAdminMessage(sessionPasskey);

  let ack: { acked: boolean; errorReason: number | null; timedOut: boolean } | null = null;
  if (ACK_AWAITED_COMMANDS.has(command) && !isLocalNode) {
    onStatus?.('awaiting_ack');
    ack = await acManager.sendAdminCommandAwaitAck(adminMessage, destinationNodeNum);
  } else {
    await acManager.sendAdminCommand(adminMessage, destinationNodeNum);
  }

  // 3. Post-send side effects.

  // For setSecurityConfig on the local node, update the cached config immediately
  // so the frontend reads back the correct values before the next config sync
  if (command === 'setSecurityConfig' && isLocalNode && params.config) {
    const securityConfig = params.config as SecurityConfigParams;
    acManager.updateCachedDeviceConfig('security', {
      isManaged: securityConfig.isManaged,
      serialEnabled: securityConfig.serialEnabled,
      debugLogApiEnabled: securityConfig.debugLogApiEnabled,
      adminChannelEnabled: securityConfig.adminChannelEnabled
    });
  }

  // For setFixedPosition on the local node, immediately update the database
  // so it's correct before any stale position broadcast arrives from the device firmware.
  if (command === 'setFixedPosition' && isLocalNode && localNodeNum) {
    const localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
    await databaseService.nodes.upsertNode({
      nodeNum: localNodeNum,
      nodeId: localNodeId,
      latitude: params.latitude as number,
      longitude: params.longitude as number,
      altitude: (params.altitude as number) || 0,
      positionTimestamp: Date.now(),
    });
    logger.debug(`⚙️ Updated local node ${localNodeId} position in database: lat=${params.latitude}, lon=${params.longitude}`);
  }

  // If command succeeded on a remote node, update hasRemoteAdmin flag
  if (!isLocalNode) {
    try {
      await databaseService.updateNodeRemoteAdminStatusAsync(
        destinationNodeNum,
        true,
        null,  // Don't overwrite existing metadata, just set the flag
        acManager.sourceId
      );
      logger.debug(`✅ Updated hasRemoteAdmin=true for node ${destinationNodeNum} after successful '${command}' command`);
    } catch (dbError) {
      logger.error(`Failed to update hasRemoteAdmin for node ${destinationNodeNum}:`, dbError);
      // Continue with response even if database update fails
    }
  }

  return {
    message: `Admin command '${command}' sent to node ${destinationNodeNum}`,
    ...(ack ? {
      ack: {
        acked: ack.acked,
        timedOut: ack.timedOut,
        errorReason: ack.errorReason,
        status: ack.timedOut
          ? 'timeout'
          : (ack.acked ? 'confirmed' : getRoutingErrorName(ack.errorReason ?? -1)),
      }
    } : {})
  };
}

/**
 * Effective attempt count for a remote admin command (#4487).
 *
 * Priority mirrors resolveCliTimeoutMs (#4027):
 *  1. An explicit, in-range `retryAttempts` on the request — a per-send
 *     override, for the one stubborn node rather than a global change.
 *  2. The `adminRetryAttempts` setting, clamped to the same range.
 *  3. 1 — a single attempt, i.e. exactly the pre-#4487 behaviour. The default
 *     is deliberately NOT >1: silently multiplying every operator's radio
 *     traffic is not a default worth choosing for them.
 */
export const ADMIN_RETRY_MIN_ATTEMPTS = 1;
export const ADMIN_RETRY_MAX_ATTEMPTS = 10;

export async function resolveAdminRetryAttempts(retryAttempts?: unknown): Promise<number> {
  const inRange = (n: number) =>
    Number.isInteger(n) && n >= ADMIN_RETRY_MIN_ATTEMPTS && n <= ADMIN_RETRY_MAX_ATTEMPTS;

  const override = typeof retryAttempts === 'number' ? retryAttempts : NaN;
  if (inRange(override)) return override;

  // Defensive: this is awaited in the request path before the 202 is sent, so a
  // settings-read failure must not take the whole command down. Retry policy is
  // not worth failing a send over — fall back to the single-attempt default.
  try {
    const raw = await databaseService.settings.getSetting('adminRetryAttempts');
    const configured = raw == null ? NaN : parseInt(raw, 10);
    if (inRange(configured)) return configured;
  } catch (error) {
    logger.debug(`Could not read adminRetryAttempts, defaulting to 1: ${(error as Error)?.message}`);
  }

  return 1;
}

/**
 * Backoff before attempt N+1 (#4487). Linear rather than exponential: the ACK
 * window is already 30s, so an exponential curve would push a third attempt
 * minutes out, long past the point the operator is still watching.
 */
export function adminRetryDelayMs(attempt: number): number {
  return Math.min(attempt, 3) * 5_000;
}

router.post('/commands', requireAdmin(), async (req, res) => {
  try {
    const { command, nodeNum, sourceId: acSourceId, ...params } = req.body;

    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }

    const acManager = resolveSourceManager(acSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (acManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = acManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    // Session-passkey acquisition used to run HERE, blocking the request for up
    // to 45s before the command was even sent (#4482). It now happens inside
    // `executeAdminCommand`, which the remote path runs in the background.
    //
    // The switch below therefore captures a BUILDER rather than a finished
    // packet: parameter validation stays synchronous in this handler (so bad
    // input still gets an immediate 400), while the passkey — the only input
    // that requires a mesh round-trip — is supplied later by the executor.
    let buildAdminMessage: (sessionPasskey?: Uint8Array) => Uint8Array;

    // Extra packets some commands must send before the main one, run by the
    // executor once the passkey is known.
    let preSend: ((sessionPasskey?: Uint8Array) => Promise<void>) | null = null;

    // Create the appropriate admin message based on command type
    switch (command) {
      case 'reboot':
        buildAdminMessage = (passkey) => protobufService.createRebootMessage(params.seconds || 10, passkey);
        break;
      case 'setOwner':
        if (!params.longName || !params.shortName) {
          return res.status(400).json({ error: 'longName and shortName are required for setOwner' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetOwnerMessage(
          params.longName,
          params.shortName,
          params.isUnmessagable,
          passkey,
          params.isLicensed
        );
        break;
      case 'setChannel':
        if (params.channelIndex === undefined || !params.config) {
          return res.status(400).json({ error: 'channelIndex and config are required for setChannel' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetChannelMessage(
          params.channelIndex,
          params.config,
          passkey
        );
        break;
      case 'setDeviceConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setDeviceConfig' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetDeviceConfigMessage(params.config, passkey);
        break;
      case 'setLoRaConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setLoRaConfig' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetLoRaConfigMessage(params.config, passkey);
        break;
      case 'setPositionConfig': {
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setPositionConfig' });
        }
        // Extract position coordinates from config - these must be sent via a separate
        // setFixedPosition admin message, as Config.PositionConfig has no lat/lon/alt fields.
        // Per protobuf docs, set_fixed_position automatically sets fixedPosition=true on the device.
        // No delay needed: the local node queues both packets and the mesh protocol guarantees
        // FIFO delivery from the same source, with natural spacing from radio transmission time.
        const { latitude, longitude, altitude, ...positionConfig } = params.config;
        if (latitude !== undefined && longitude !== undefined && positionConfig.fixedPosition) {
          preSend = async (passkey) => {
            const setPositionMsg = protobufService.createSetFixedPositionMessage(
              latitude,
              longitude,
              altitude || 0,
              passkey
            );
            await acManager.sendAdminCommand(setPositionMsg, destinationNodeNum);

            // Immediately update the local node's position in the database so it's correct
            // before any stale position broadcast arrives from the device firmware.
            if (isLocalNode && localNodeNum) {
              const localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
              await databaseService.nodes.upsertNode({
                nodeNum: localNodeNum,
                nodeId: localNodeId,
                latitude,
                longitude,
                altitude: altitude || 0,
                positionTimestamp: Date.now(),
              });
              logger.debug(`⚙️ Updated local node ${localNodeId} position in database: lat=${latitude}, lon=${longitude}`);
            }
          };
        }
        buildAdminMessage = (passkey) => protobufService.createSetPositionConfigMessage(positionConfig, passkey);
        break;
      }
      case 'setMQTTConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setMQTTConfig' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetMQTTConfigMessage(params.config, passkey);
        break;
      case 'setBluetoothConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setBluetoothConfig' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetDeviceConfigMessageGeneric('bluetooth', params.config, passkey);
        break;
      case 'setNetworkConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setNetworkConfig' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetNetworkConfigMessage(params.config, passkey);
        break;
      case 'setNeighborInfoConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setNeighborInfoConfig' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetNeighborInfoConfigMessage(params.config, passkey);
        break;
      case 'setTelemetryConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setTelemetryConfig' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetModuleConfigMessageGeneric('telemetry', params.config, passkey);
        break;
      case 'setStatusMessageConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setStatusMessageConfig' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetModuleConfigMessageGeneric('statusmessage', params.config, passkey);
        break;
      case 'setTrafficManagementConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setTrafficManagementConfig' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetModuleConfigMessageGeneric('trafficmanagement', params.config, passkey);
        break;
      case 'setMeshBeaconConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setMeshBeaconConfig' });
        }
        // Firmware enforces a 100-byte cap on the beacon text. Reject over-long
        // input here rather than letting the device silently truncate it or drop
        // the whole set-config message (#3854).
        if (typeof params.config.broadcastMessage === 'string'
          && Buffer.byteLength(params.config.broadcastMessage, 'utf8') > MESH_BEACON_MESSAGE_MAX_BYTES) {
          return res.status(400).json({
            error: `broadcastMessage exceeds ${MESH_BEACON_MESSAGE_MAX_BYTES} bytes (firmware limit)`
          });
        }
        // Firmware enforces a 3600s (1h) minimum on broadcast_interval_secs and
        // silently rejects lower values (#4802). Reject a positive sub-minimum
        // here so the user gets a clear error instead of a setting that never
        // persists. 0 is allowed (device falls back to the firmware default).
        if (typeof params.config.broadcastIntervalSecs === 'number'
          && params.config.broadcastIntervalSecs > 0
          && params.config.broadcastIntervalSecs < 3600) {
          return res.status(400).json({
            error: 'broadcastIntervalSecs must be at least 3600 seconds (firmware minimum)'
          });
        }
        buildAdminMessage = (passkey) => protobufService.createSetModuleConfigMessageGeneric('meshbeacon', params.config, passkey);
        break;
      case 'setSecurityConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setSecurityConfig' });
        }
        // A pasted private key (#4632) is only honored for the local node, and
        // must be a valid 32-byte key — reject bad input as 400 up front rather
        // than letting it surface as a 500 from the builder below.
        if (typeof params.config.privateKey === 'string' && params.config.privateKey.trim().length > 0) {
          if (!isLocalNode) {
            return res.status(400).json({ error: 'A private key can only be set on the local node' });
          }
          if (!isValidMeshtasticKey(params.config.privateKey)) {
            return res.status(400).json({ error: 'Invalid private key: expected base64 of 32 bytes' });
          }
        }
        {
          // Preserve the node's identity keypair and signature policy across the
          // update. The LOCAL node reads them from the manager's own cache. A
          // REMOTE node needs a round-trip to the device, so that read happens in
          // `preSend` below — INSIDE the background executor — not here.
          //
          // #4482 deliberately moved mesh round-trips out of this handler because
          // they blocked the HTTP request for up to 45s; doing the read here
          // would reintroduce exactly that. The cost is that an unreachable node
          // surfaces as a failed operation rather than a synchronous 4xx.
          let remoteSecurity: { publicKey: string; privateKey: string; packetSignaturePolicy?: number } | null = null;
          if (!isLocalNode) {
            preSend = async () => {
              const securityInfo = CONFIG_TYPE_MAP['security'];
              let liveRemote:
                | { publicKey?: Uint8Array; privateKey?: Uint8Array; packetSignaturePolicy?: number }
                | null;
              try {
                liveRemote = await acManager.requestRemoteConfig(destinationNodeNum, securityInfo.type, securityInfo.isModule);
              } catch (error) {
                logger.warn(`Failed to read security config from remote node ${destinationNodeNum} before update:`, error);
                liveRemote = null;
              }
              const livePublic = liveRemote?.publicKey ? bytesToBase64(liveRemote.publicKey) : null;
              const livePrivate = liveRemote?.privateKey ? bytesToBase64(liveRemote.privateKey) : null;

              // Fail CLOSED. Sending without the node's real keypair is the
              // destructive case this whole change exists to prevent, so an
              // unreachable node must abort the save rather than proceed and
              // regenerate the node's identity.
              if (!livePublic || !livePrivate) {
                throw adminError(
                  'SECURITY_CONFIG_READBACK_FAILED',
                  `Could not read the current security config from node ${destinationNodeNum}. ` +
                  'Saving without it would replace the node\'s identity keypair, so nothing was sent. ' +
                  'Check the node is reachable and try again.',
                );
              }
              remoteSecurity = {
                publicKey: livePublic,
                privateKey: livePrivate,
                packetSignaturePolicy: liveRemote?.packetSignaturePolicy,
              };
            };
          }

          // A function, not a value: the builder runs after this handler
          // returns, and for a remote node the keypair only exists once
          // preSend has completed.
          const resolveConfigToSend = () => {
            if (isLocalNode) {
              const existingKeys = acManager.getSecurityKeys();
              // A caller-supplied private key that differs from the stored one
              // is a deliberate identity change (#4632). The firmware stores the
              // pair verbatim rather than re-deriving, so we must send the
              // PUBLIC key that matches the NEW private key — preserving the old
              // public key here would leave the node advertising a key that no
              // longer matches its secret and break PKI DMs to it. For every
              // other security setting the private key is absent and both keys
              // are preserved unchanged, exactly as before.
              const providedPrivate = typeof params.config.privateKey === 'string'
                ? params.config.privateKey.trim()
                : '';
              // Compare normalized (strip any base64: prefix) so re-submitting
              // the SAME key the firmware reported — possibly with a prefix — is
              // correctly seen as unchanged and preserves the identity.
              const isNewPrivateKey = providedPrivate.length > 0
                && normalizeMeshtasticKey(providedPrivate)
                   !== normalizeMeshtasticKey(existingKeys.privateKey ?? '');
              if (isNewPrivateKey) {
                // Validity is already enforced above (400); this is the trusted
                // path that derives the matching public key.
                logger.info('Setting a new private key for the local node; deriving the matching public key');
                return {
                  ...params.config,
                  privateKey: providedPrivate,
                  publicKey: derivePublicKey(providedPrivate),
                };
              }
              logger.debug('Preserving existing public/private keys for local node security config update');
              return {
                ...params.config,
                // Include existing keys if not explicitly provided. Normalize a
                // provided key (strip any base64: prefix) before it reaches the
                // protobuf encoder — re-submitting the current key with a prefix
                // must not send `base64:…`, which is not valid base64 and would
                // corrupt the identity.
                publicKey: params.config.publicKey
                  ? normalizeMeshtasticKey(params.config.publicKey)
                  : existingKeys.publicKey,
                privateKey: params.config.privateKey
                  ? normalizeMeshtasticKey(params.config.privateKey)
                  : existingKeys.privateKey
              };
            }
            // Remote node (#4736).
            //
            // This branch used to strip publicKey/privateKey with a comment
            // claiming firmware would "preserve them". It does not, and that
            // belief is why this button was hard-disabled back in #1602.
            // Firmware's handleSetConfig does:
            //
            //     config.security = c.payload_variant.security;   // wholesale
            //     if (config.security.private_key.size != 32)
            //         crypto->generateKeyPair(...);               // NEW identity
            //
            // so stripping the keys did not preserve them — it made the node
            // mint a brand-new keypair, changing its identity mesh-wide.
            //
            // The merge happens HERE, from `remoteSecurity`, a read this
            // handler just performed against the node itself. Deliberately not
            // from anything the client sent: the #4632 guard above still
            // rejects a client-supplied private key for a remote node, because
            // the server cannot tell an honest echo from an identity hijack.
            // Merging server-side keeps that guard intact AND keeps the remote
            // node's private key out of the browser entirely.
            // Non-null by construction, and the construction is an ORDERING
            // invariant worth stating: `executeAdminCommand` always awaits
            // `preSend` before calling `buildAdminMessage` (see its "2. Build
            // and send" step). preSend is what populates `remoteSecurity`, and
            // it throws rather than returning when the node cannot be read.
            //
            // So if this ever trips, the cause is that call order changing —
            // not a missing key. Failing loudly here is deliberate: silently
            // sending a config without the keypair is the destructive outcome
            // this whole change exists to prevent.
            if (!remoteSecurity) {
              throw new Error(
                'internal: remote security keys unresolved — preSend must run before buildAdminMessage',
              );
            }
            return {
              ...params.config,
              publicKey: remoteSecurity.publicKey,
              privateKey: remoteSecurity.privateKey,
              // Omitted, this silently resets the node from STRICT/BALANCED to
              // COMPATIBLE (0). The firmware's own bug report called that worse
              // than losing the admin keys, since nothing surfaces it.
              packetSignaturePolicy: remoteSecurity.packetSignaturePolicy,
            };
          };
          // Evaluated lazily: for a remote node `configToSend` depends on
          // `remoteSecurity`, which preSend fills in moments earlier.
          buildAdminMessage = (passkey) => protobufService.createSetSecurityConfigMessage(resolveConfigToSend(), passkey);
        }
        break;
      case 'setFixedPosition':
        if (params.latitude === undefined || params.longitude === undefined) {
          return res.status(400).json({ error: 'latitude and longitude are required for setFixedPosition' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetFixedPositionMessage(
          params.latitude,
          params.longitude,
          params.altitude || 0,
          passkey
        );
        break;
      case 'purgeNodeDb':
        buildAdminMessage = (passkey) => protobufService.createPurgeNodeDbMessage(params.seconds || 0, passkey);
        break;
      case 'beginEditSettings':
        buildAdminMessage = (passkey) => protobufService.createBeginEditSettingsMessage(passkey);
        break;
      case 'commitEditSettings':
        buildAdminMessage = (passkey) => protobufService.createCommitEditSettingsMessage(passkey);
        break;
      case 'removeNode':
        if (params.nodeNum === undefined) {
          return res.status(400).json({ error: 'nodeNum is required for removeNode' });
        }
        buildAdminMessage = (passkey) => protobufService.createRemoveNodeMessage(params.nodeNum, passkey);
        break;
      case 'setFavoriteNode':
        // Use favoriteNodeNum to avoid collision with destination nodeNum
        if (params.favoriteNodeNum === undefined) {
          return res.status(400).json({ error: 'favoriteNodeNum is required for setFavoriteNode' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetFavoriteNodeMessage(params.favoriteNodeNum, passkey);
        break;
      case 'removeFavoriteNode':
        // Use favoriteNodeNum to avoid collision with destination nodeNum
        if (params.favoriteNodeNum === undefined) {
          return res.status(400).json({ error: 'favoriteNodeNum is required for removeFavoriteNode' });
        }
        buildAdminMessage = (passkey) => protobufService.createRemoveFavoriteNodeMessage(params.favoriteNodeNum, passkey);
        break;
      case 'setIgnoredNode':
        // Use targetNodeNum to avoid collision with destination nodeNum
        if (params.targetNodeNum === undefined) {
          return res.status(400).json({ error: 'targetNodeNum is required for setIgnoredNode' });
        }
        buildAdminMessage = (passkey) => protobufService.createSetIgnoredNodeMessage(params.targetNodeNum, passkey);
        break;
      case 'removeIgnoredNode':
        // Use targetNodeNum to avoid collision with destination nodeNum
        if (params.targetNodeNum === undefined) {
          return res.status(400).json({ error: 'targetNodeNum is required for removeIgnoredNode' });
        }
        buildAdminMessage = (passkey) => protobufService.createRemoveIgnoredNodeMessage(params.targetNodeNum, passkey);
        break;
      default:
        return res.status(400).json({ error: `Unknown command: ${command}` });
    }

    // Everything above is synchronous validation. Everything below can block on
    // the mesh (passkey acquisition, routing ACK), so it runs inline only for
    // the local node — where there is no passkey step and no ACK wait.
    const execute = (onStatus?: (status: AdminOperationStatus) => void) => executeAdminCommand({
      command,
      params,
      acManager,
      destinationNodeNum,
      localNodeNum,
      isLocalNode,
      buildAdminMessage,
      preSend,
      onStatus,
    });

    if (isLocalNode) {
      const result = await execute();
      return res.json({ success: true, ...result });
    }

    // Remote node: accept now, finish on the mesh's schedule (#4482). Holding
    // the socket open for up to 75s is what produced upstream 502s.
    const operation = adminOperationService.create({
      command,
      sourceId: acManager.sourceId,
      destinationNodeNum,
      userId: req.session?.userId ?? null,
    });

    const maxAttempts = await resolveAdminRetryAttempts(params.retryAttempts);

    void (async () => {
      try {
        for (let attempt = 1; ; attempt++) {
          const result = await execute((status) => adminOperationService.setStatus(operation.id, status));
          const ack = (result as { ack?: { acked: boolean; timedOut: boolean } }).ack;
          const settled = { ...result, attempts: attempt, maxAttempts };

          // No ACK was awaited for this command (see ACK_AWAITED_COMMANDS), so
          // there is no outcome to distinguish — sending it was the whole job.
          if (!ack) {
            adminOperationService.succeed(operation.id, settled);
            return;
          }
          if (ack.acked) {
            adminOperationService.succeed(operation.id, settled);
            return;
          }
          // Answered with a routing error: the node received it and refused.
          // Retrying just re-asks a question already answered (#4492).
          if (!ack.timedOut) {
            adminOperationService.reject(operation.id, settled);
            return;
          }
          if (attempt >= maxAttempts) {
            adminOperationService.timeOut(operation.id, settled);
            return;
          }
          logger.debug(
            `📋 Admin operation ${operation.id} attempt ${attempt}/${maxAttempts} timed out; retrying`,
          );
          await new Promise((resolve) => setTimeout(resolve, adminRetryDelayMs(attempt)));
        }
      } catch (error) {
        if (isTxDisabledError(error)) {
          adminOperationService.fail(operation.id, {
            code: 'TX_DISABLED',
            message: 'Transmit is disabled on this source',
          });
          return;
        }
        logger.error(`Error executing admin command '${command}' (operation ${operation.id}):`, error);
        const coded = error as { code?: string; message?: string } | null;
        adminOperationService.fail(operation.id, {
          code: coded?.code || 'ADMIN_COMMAND_FAILED',
          message: coded?.message || 'Failed to execute admin command',
        });
      }
    })();

    return res.status(202).json({
      success: true,
      operationId: operation.id,
      status: operation.status,
      message: `Admin command '${command}' accepted for node ${destinationNodeNum}`,
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error executing admin command:', error);
    res.status(500).json({ error: error.message || 'Failed to execute admin command' });
  }
});

/**
 * Poll the outcome of an async remote-admin operation (#4482).
 *
 * A missing id and someone else's id are deliberately indistinguishable — both
 * 404 — so this cannot be used to probe which operation ids exist.
 */
router.get('/operations/:id', requireAdmin(), async (req, res) => {
  const operation = adminOperationService.get(req.params.id);
  const requesterId = req.session?.userId ?? null;

  // An owned operation is visible only to its owner — a session-less requester
  // does not qualify. (The earlier form also required `requesterId !== null`,
  // which let two null principals share visibility.)
  if (!operation || (operation.userId !== null && operation.userId !== requesterId)) {
    return fail(res, 404, 'OPERATION_NOT_FOUND', 'Unknown or expired admin operation');
  }

  return ok(res, {
    id: operation.id,
    command: operation.command,
    destinationNodeNum: operation.destinationNodeNum,
    status: operation.status,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
    result: operation.result,
    error: operation.error,
  });
});


export default router;
