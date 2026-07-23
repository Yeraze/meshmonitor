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
import { getRoutingErrorName } from '../constants/meshtastic.js';
import { CONFIG_TYPE_MAP, MODULE_FIELD_BY_ID, DEVICE_FIELD_BY_ID } from '../constants/configTypes.js';
import { autoFavoriteManagementScheduler } from '../services/autoFavoriteManagementService.js';
import protobufService from '../protobufService.js';
import { fail } from '../utils/apiResponse.js';
import { isTxDisabledError } from '../errors/txDisabledError.js';

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

    // Check if we already have a valid session passkey
    let sessionPasskey = espManager.getSessionPasskey(destinationNodeNum);
    if (!sessionPasskey) {
      logger.debug(`Requesting session passkey for remote node ${destinationNodeNum}`);
      sessionPasskey = await espManager.requestRemoteSessionPasskey(destinationNodeNum);
      if (!sessionPasskey) {
        return res.status(500).json({ error: `Failed to obtain session passkey for remote node ${destinationNodeNum}` });
      }
    }

    // Return status with expiry info
    const status = espManager.getSessionPasskeyStatus(destinationNodeNum);
    return res.json({
      success: true,
      message: 'Session passkey available',
      ...status
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error ensuring session passkey:', error);
    res.status(500).json({ error: error.message || 'Failed to ensure session passkey' });
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
            hasRemoteHardware: metadata.hasRemoteHardware || false
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

    const importedChannels = [];
    let loraImported = false;
    let requiresReboot = false;

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
            logger.error(`❌ Failed to import channel ${i}:`, error);
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
          // Best-effort remote preserve: use the manager's cached remote-config
          // snapshot (populated only if requestRemoteConfig(LORA_CONFIG) was
          // called for this node earlier — e.g. via /load-config or
          // /export-config with includeLoraConfig). This import flow does not
          // itself fetch the remote node's current LoRa config first — that
          // would need an extra requestRemoteConfig round-trip (session
          // passkey + mesh RTT) not currently part of this flow. Falls back to
          // the decoded URL's own txEnabled (real since #4294's export fix;
          // older exported URLs may still carry the old forced `true`), and
          // finally to true (fail-open) if that's absent too.
          // TODO(#4294 follow-up): a fully-accurate remote preserve would
          // fetch the remote node's live LoRa config via requestRemoteConfig
          // before importing.
          const cachedRemoteLora = aicManager.getRemoteNodeConfig(destinationNodeNum)?.deviceConfig?.lora;
          const remoteTxEnabled = cachedRemoteLora?.txEnabled !== undefined
            ? cachedRemoteLora.txEnabled
            : (decoded.loraConfig.txEnabled ?? true);
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

    res.json({
      success: true,
      imported: {
        channels: importedChannels.length,
        channelDetails: importedChannels,
        loraConfig: loraImported,
      },
      requiresReboot,
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error importing configuration:', error);
    res.status(500).json({ error: error.message || 'Failed to import configuration' });
  }
});

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

    // Get or request session passkey for remote nodes
    let sessionPasskey: Uint8Array | null = null;
    if (!isLocalNode) {
      sessionPasskey = acManager.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.debug(`🔑 Using cached session passkey for admin command to remote node ${destinationNodeNum}`);
      } else {
        logger.debug(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one for admin command...`);
        sessionPasskey = await acManager.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          logger.error(`❌ Failed to obtain session passkey for remote node ${destinationNodeNum} after 45s`);
          return res.status(500).json({ error: `Failed to obtain session passkey for remote node ${destinationNodeNum}. The node may be unreachable or not responding.` });
        }
      }
    }

    let adminMessage: Uint8Array;

    // Create the appropriate admin message based on command type
    switch (command) {
      case 'reboot':
        adminMessage = protobufService.createRebootMessage(params.seconds || 10, sessionPasskey || undefined);
        break;
      case 'setOwner':
        if (!params.longName || !params.shortName) {
          return res.status(400).json({ error: 'longName and shortName are required for setOwner' });
        }
        adminMessage = protobufService.createSetOwnerMessage(
          params.longName,
          params.shortName,
          params.isUnmessagable,
          sessionPasskey || undefined,
          params.isLicensed
        );
        break;
      case 'setChannel':
        if (params.channelIndex === undefined || !params.config) {
          return res.status(400).json({ error: 'channelIndex and config are required for setChannel' });
        }
        adminMessage = protobufService.createSetChannelMessage(
          params.channelIndex,
          params.config,
          sessionPasskey || undefined
        );
        break;
      case 'setDeviceConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setDeviceConfig' });
        }
        adminMessage = protobufService.createSetDeviceConfigMessage(params.config, sessionPasskey || undefined);
        break;
      case 'setLoRaConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setLoRaConfig' });
        }
        adminMessage = protobufService.createSetLoRaConfigMessage(params.config, sessionPasskey || undefined);
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
          const setPositionMsg = protobufService.createSetFixedPositionMessage(
            latitude,
            longitude,
            altitude || 0,
            sessionPasskey || undefined
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
        }
        adminMessage = protobufService.createSetPositionConfigMessage(positionConfig, sessionPasskey || undefined);
        break;
      }
      case 'setMQTTConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setMQTTConfig' });
        }
        adminMessage = protobufService.createSetMQTTConfigMessage(params.config, sessionPasskey || undefined);
        break;
      case 'setBluetoothConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setBluetoothConfig' });
        }
        adminMessage = protobufService.createSetDeviceConfigMessageGeneric('bluetooth', params.config, sessionPasskey || undefined);
        break;
      case 'setNetworkConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setNetworkConfig' });
        }
        adminMessage = protobufService.createSetNetworkConfigMessage(params.config, sessionPasskey || undefined);
        break;
      case 'setNeighborInfoConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setNeighborInfoConfig' });
        }
        adminMessage = protobufService.createSetNeighborInfoConfigMessage(params.config, sessionPasskey || undefined);
        break;
      case 'setTelemetryConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setTelemetryConfig' });
        }
        adminMessage = protobufService.createSetModuleConfigMessageGeneric('telemetry', params.config, sessionPasskey || undefined);
        break;
      case 'setStatusMessageConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setStatusMessageConfig' });
        }
        adminMessage = protobufService.createSetModuleConfigMessageGeneric('statusmessage', params.config, sessionPasskey || undefined);
        break;
      case 'setTrafficManagementConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setTrafficManagementConfig' });
        }
        adminMessage = protobufService.createSetModuleConfigMessageGeneric('trafficmanagement', params.config, sessionPasskey || undefined);
        break;
      case 'setSecurityConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setSecurityConfig' });
        }
        // IMPORTANT: Preserve existing public/private keys when updating security config
        // If we don't include them, the firmware may reset them to empty/random values
        // Only do this for LOCAL node - for remote nodes we don't have their private key
        {
          let configToSend = params.config;
          if (isLocalNode) {
            const existingKeys = acManager.getSecurityKeys();
            configToSend = {
              ...params.config,
              // Include existing keys if not explicitly provided
              publicKey: params.config.publicKey || existingKeys.publicKey,
              privateKey: params.config.privateKey || existingKeys.privateKey
            };
            logger.debug('Preserving existing public/private keys for local node security config update');
          } else {
            // For remote nodes, explicitly exclude publicKey/privateKey to let firmware preserve them
            // We don't have the remote node's private key, so we can't include it
            const { publicKey, privateKey, ...remoteConfig } = params.config;
            configToSend = remoteConfig;
            logger.debug('Excluding publicKey/privateKey from remote node security config update');
          }
          adminMessage = protobufService.createSetSecurityConfigMessage(configToSend, sessionPasskey || undefined);
        }
        break;
      case 'setFixedPosition':
        if (params.latitude === undefined || params.longitude === undefined) {
          return res.status(400).json({ error: 'latitude and longitude are required for setFixedPosition' });
        }
        adminMessage = protobufService.createSetFixedPositionMessage(
          params.latitude,
          params.longitude,
          params.altitude || 0,
          sessionPasskey || undefined
        );
        break;
      case 'purgeNodeDb':
        adminMessage = protobufService.createPurgeNodeDbMessage(params.seconds || 0, sessionPasskey || undefined);
        break;
      case 'beginEditSettings':
        adminMessage = protobufService.createBeginEditSettingsMessage(sessionPasskey || undefined);
        break;
      case 'commitEditSettings':
        adminMessage = protobufService.createCommitEditSettingsMessage(sessionPasskey || undefined);
        break;
      case 'removeNode':
        if (params.nodeNum === undefined) {
          return res.status(400).json({ error: 'nodeNum is required for removeNode' });
        }
        adminMessage = protobufService.createRemoveNodeMessage(params.nodeNum, sessionPasskey || undefined);
        break;
      case 'setFavoriteNode':
        // Use favoriteNodeNum to avoid collision with destination nodeNum
        if (params.favoriteNodeNum === undefined) {
          return res.status(400).json({ error: 'favoriteNodeNum is required for setFavoriteNode' });
        }
        adminMessage = protobufService.createSetFavoriteNodeMessage(params.favoriteNodeNum, sessionPasskey || undefined);
        break;
      case 'removeFavoriteNode':
        // Use favoriteNodeNum to avoid collision with destination nodeNum
        if (params.favoriteNodeNum === undefined) {
          return res.status(400).json({ error: 'favoriteNodeNum is required for removeFavoriteNode' });
        }
        adminMessage = protobufService.createRemoveFavoriteNodeMessage(params.favoriteNodeNum, sessionPasskey || undefined);
        break;
      case 'setIgnoredNode':
        // Use targetNodeNum to avoid collision with destination nodeNum
        if (params.targetNodeNum === undefined) {
          return res.status(400).json({ error: 'targetNodeNum is required for setIgnoredNode' });
        }
        adminMessage = protobufService.createSetIgnoredNodeMessage(params.targetNodeNum, sessionPasskey || undefined);
        break;
      case 'removeIgnoredNode':
        // Use targetNodeNum to avoid collision with destination nodeNum
        if (params.targetNodeNum === undefined) {
          return res.status(400).json({ error: 'targetNodeNum is required for removeIgnoredNode' });
        }
        adminMessage = protobufService.createRemoveIgnoredNodeMessage(params.targetNodeNum, sessionPasskey || undefined);
        break;
      default:
        return res.status(400).json({ error: `Unknown command: ${command}` });
    }

    // Send the admin command. For favorite changes to a REMOTE node we wait for
    // the destination's routing ACK (admin packets set want_response) so the UI
    // can confirm the remote node actually processed it. Everything else (and
    // local-node favorites) fires as before.
    const isFavoriteCommand = command === 'setFavoriteNode' || command === 'removeFavoriteNode';
    let favoriteAck: { acked: boolean; errorReason: number | null; timedOut: boolean } | null = null;
    if (isFavoriteCommand && !isLocalNode) {
      favoriteAck = await acManager.sendAdminCommandAwaitAck(adminMessage, destinationNodeNum);
    } else {
      await acManager.sendAdminCommand(adminMessage, destinationNodeNum);
    }

    // For setSecurityConfig on the local node, update the cached config immediately
    // so the frontend reads back the correct values before the next config sync
    if (command === 'setSecurityConfig' && isLocalNode && params.config) {
      acManager.updateCachedDeviceConfig('security', {
        isManaged: params.config.isManaged,
        serialEnabled: params.config.serialEnabled,
        debugLogApiEnabled: params.config.debugLogApiEnabled,
        adminChannelEnabled: params.config.adminChannelEnabled
      });
    }

    // For setFixedPosition on the local node, immediately update the database
    // so it's correct before any stale position broadcast arrives from the device firmware.
    if (command === 'setFixedPosition' && isLocalNode && localNodeNum) {
      const localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
      await databaseService.nodes.upsertNode({
        nodeNum: localNodeNum,
        nodeId: localNodeId,
        latitude: params.latitude,
        longitude: params.longitude,
        altitude: params.altitude || 0,
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

    res.json({
      success: true,
      message: `Admin command '${command}' sent to node ${destinationNodeNum}`,
      ...(favoriteAck ? {
        ack: {
          acked: favoriteAck.acked,
          timedOut: favoriteAck.timedOut,
          errorReason: favoriteAck.errorReason,
          status: favoriteAck.timedOut
            ? 'timeout'
            : (favoriteAck.acked ? 'confirmed' : getRoutingErrorName(favoriteAck.errorReason ?? -1)),
        }
      } : {})
    });
  } catch (error: any) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error executing admin command:', error);
    res.status(500).json({ error: error.message || 'Failed to execute admin command' });
  }
});


export default router;
