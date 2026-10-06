/**
 * Config Routes
 *
 * GET /config           — public configuration (optionalAuth)
 * GET /config/current   — current device config (configuration:read on the target source)
 * POST /config/*        — 13 device configuration setters (configuration:write on the target source)
 *
 * Extracted verbatim from server.ts (was `apiRouter.get('/config', ...)` L3262
 * and `apiRouter.get('/config/current', ...)` + 13 POSTs, L4283–4488) as part
 * of #3502. Mounted at '/config' in server.ts.
 */
import express from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { requireDeviceSourcePermission, getDeviceSourceTarget } from '../utils/deviceSourcePermission.js';
import { resolveSourceConnectionConfig } from '../utils/resolveSourceConnectionConfig.js';
import { isValidModuleConfigType } from '../constants/moduleConfig.js';
import { validateMeshBeaconConfigPayload } from '../constants/meshtastic.js';
import { normalizeTakConfig, validateTakConfigPayload } from '../../utils/takConfig.js';
import { validateStatusMessageConfigPayload } from '../../utils/statusMessage.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { mayViewSourceEndpoint } from '../utils/sourceConfigRedaction.js';
import { fail } from '../utils/apiResponse.js';
import { isTxDisabledError } from '../errors/txDisabledError.js';
import { safeJson } from '../utils/redactSecrets.js';

const env = getEnvironmentConfig();
const BASE_URL = env.baseUrl;

const router = express.Router();

// Configuration endpoint for frontend
router.get('/', optionalAuth(), async (req, res) => {
  try {
    // Get the local node number from settings to include rebootCount.
    // Accepts ?sourceId= so multi-source deployments resolve the local node
    // (and reboot count / display names) for the specific source the caller
    // is rendering, rather than whichever source happened to write the
    // global localNodeNum setting last.
    const configSourceId = req.query.sourceId as string | undefined;
    const localNodeNumStr = await databaseService.settings.getLocalNodeNumForSource(
      configSourceId ?? null,
    );

    let deviceMetadata = undefined;
    let localNodeInfo = undefined;
    if (localNodeNumStr) {
      const localNodeNum = parseInt(localNodeNumStr, 10);
      const currentNode = await databaseService.nodes.getNode(localNodeNum, configSourceId);

      if (currentNode) {
        deviceMetadata = {
          firmwareVersion: currentNode.firmwareVersion,
          rebootCount: currentNode.rebootCount,
        };

        // Include local node identity information for anonymous users
        localNodeInfo = {
          nodeId: currentNode.nodeId,
          longName: currentNode.longName,
          shortName: currentNode.shortName,
        };
      }
    }

    // Source-scoped connection config (issue #2981).
    const conn = await resolveSourceConnectionConfig(configSourceId);

    res.json({
      // A connection endpoint: signed in with `sources:read` (or admin) only.
      ...((await mayViewSourceEndpoint(req)) ? { meshtasticNodeIp: conn.host ?? '' } : {}),
      meshtasticTcpPort: conn.port ?? env.meshtasticTcpPort,
      meshtasticUseTls: false, // We're using TCP, not TLS
      meshtasticSourceType: conn.sourceType,
      baseUrl: BASE_URL,
      deviceMetadata: deviceMetadata,
      localNodeInfo: localNodeInfo,
    });
  } catch (error) {
    logger.error('Error in /api/config:', error);
    res.json({
      ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
      meshtasticTcpPort: env.meshtasticTcpPort,
      meshtasticUseTls: false,
      baseUrl: BASE_URL,
    });
  }
});

// Configuration endpoints
//
// Every route below reads or writes ONE source's device. Each is gated by
// requireDeviceSourcePermission(), which resolves that source once (the
// request's sourceId, or the primary Meshtastic source when it is omitted),
// checks `configuration` on exactly that source, and hands the handler the
// same manager through getDeviceSourceTarget(). A plain
// requirePermission('configuration', ...) is not enough here: with no source
// it passes on a grant for ANY source. configRoutes.scope.test.ts fails on a
// route added without the scoped gate.
//
// GET current configuration
router.get('/current', requireDeviceSourcePermission('configuration', 'read', 'query'), (req, res) => {
  try {
    const { manager: ccManager } = getDeviceSourceTarget(req);
    const config = ccManager.getCurrentConfig();
    // Surface bridged-node status alongside the config so the configuration UI
    // can advise that a bridged node (no native IP) needs MQTT Client Proxy.
    res.json({ ...config, isBridged: ccManager.isLocalNodeBridged() });
  } catch (error) {
    logger.error('Error getting current config:', error);
    fail(res, 500, 'CONFIG_READ_FAILED', 'Failed to get current configuration');
  }
});

router.post('/device', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgDevManager } = getDeviceSourceTarget(req);
    await cfgDevManager.setDeviceConfig(config);
    res.json({ success: true, message: 'Device configuration sent' });
  } catch (error) {
    logger.error('Error setting device config:', error);
    fail(res, 500, 'DEVICE_CONFIG_FAILED', 'Failed to set device configuration');
  }
});

router.post('/network', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgNetManager } = getDeviceSourceTarget(req);
    await cfgNetManager.setNetworkConfig(config);
    res.json({ success: true, message: 'Network configuration sent' });
  } catch (error) {
    logger.error('Error setting network config:', error);
    fail(res, 500, 'NETWORK_CONFIG_FAILED', 'Failed to set network configuration');
  }
});

router.post('/lora', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgLoraManager } = getDeviceSourceTarget(req);

    // Pass through the submitted txEnabled as-is (issue #4294) — this is the
    // one legitimate place a user sets TX on/off. Do NOT force it to true here;
    // that used to silently revert receive-only radios back to TX-enabled on
    // every unrelated LoRa config save.
    //
    // BUT: setLoRaConfig sends the device the ENTIRE LoRaConfig struct (it's a
    // whole-message replace, not a patch), and proto3 decodes a missing/omitted
    // bool field as false (createSetLoRaConfigMessage only includes txEnabled
    // when it's !== undefined). So when the caller's payload doesn't include
    // txEnabled at all (e.g. saving hopLimit from a form that doesn't carry a
    // TX toggle), we MUST backfill it explicitly from the device's current
    // state — leaving it undefined would silently transmit txEnabled=false and
    // kill the radio. This is the exact #1328 mechanism that motivated the
    // original (overly broad) force-true.
    const loraConfigToSet = {
      ...config,
      txEnabled: config.txEnabled !== undefined ? config.txEnabled : cfgLoraManager.isTxEnabled(),
    };
    // Same hazard for modemPreset (#5547): an omitted enum encodes as 0, which
    // is LONG_FAST. The Config tab omits it on purpose when the radio reports a
    // preset MeshMonitor cannot name, so keep the radio's current value.
    if (loraConfigToSet.modemPreset === undefined) {
      const currentPreset = cfgLoraManager.getConfiguredModemPreset();
      if (currentPreset !== undefined) {
        loraConfigToSet.modemPreset = currentPreset;
      } else {
        logger.warn('⚙️ LoRa config save omitted modemPreset and the device preset is unknown; firmware will read it as LONG_FAST');
      }
    }

    logger.debug(`⚙️ Setting LoRa config: txEnabled=${loraConfigToSet.txEnabled}`);
    await cfgLoraManager.setLoRaConfig(loraConfigToSet);
    res.json({ success: true, message: 'LoRa configuration sent' });
  } catch (error) {
    logger.error('Error setting LoRa config:', error);
    fail(res, 500, 'LORA_CONFIG_FAILED', 'Failed to set LoRa configuration');
  }
});

router.post('/position', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgPosManager } = getDeviceSourceTarget(req);
    await cfgPosManager.setPositionConfig(config);
    res.json({ success: true, message: 'Position configuration sent' });
  } catch (error) {
    logger.error('Error setting position config:', error);
    fail(res, 500, 'POSITION_CONFIG_FAILED', 'Failed to set position configuration');
  }
});

router.post('/mqtt', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgMqttManager } = getDeviceSourceTarget(req);
    await cfgMqttManager.setMQTTConfig(config);
    res.json({ success: true, message: 'MQTT configuration sent' });
  } catch (error) {
    logger.error('Error setting MQTT config:', error);
    fail(res, 500, 'MQTT_CONFIG_FAILED', 'Failed to set MQTT configuration');
  }
});

router.post('/neighborinfo', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  logger.debug('🔍 DEBUG: /config/neighborinfo endpoint called with body:', safeJson(req.body));
  try {
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgNiManager } = getDeviceSourceTarget(req);
    await cfgNiManager.setNeighborInfoConfig(config);
    res.json({ success: true, message: 'NeighborInfo configuration sent' });
  } catch (error) {
    logger.error('Error setting NeighborInfo config:', error);
    fail(res, 500, 'NEIGHBORINFO_CONFIG_FAILED', 'Failed to set NeighborInfo configuration');
  }
});

router.post('/power', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgPwrManager } = getDeviceSourceTarget(req);
    await cfgPwrManager.setPowerConfig(config);
    res.json({ success: true, message: 'Power configuration sent' });
  } catch (error) {
    logger.error('Error setting power config:', error);
    fail(res, 500, 'POWER_CONFIG_FAILED', 'Failed to set power configuration');
  }
});

router.post('/display', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgDispManager } = getDeviceSourceTarget(req);
    await cfgDispManager.setDisplayConfig(config);
    res.json({ success: true, message: 'Display configuration sent' });
  } catch (error) {
    logger.error('Error setting display config:', error);
    fail(res, 500, 'DISPLAY_CONFIG_FAILED', 'Failed to set display configuration');
  }
});

router.post('/module/telemetry', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgTelManager } = getDeviceSourceTarget(req);
    await cfgTelManager.setTelemetryConfig(config);
    res.json({ success: true, message: 'Telemetry configuration sent' });
  } catch (error) {
    logger.error('Error setting telemetry config:', error);
    fail(res, 500, 'TELEMETRY_CONFIG_FAILED', 'Failed to set telemetry configuration');
  }
});

// IMPORTANT: '/module/request' must be registered before the '/module/:moduleType'
// wildcard below — Express matches routes in registration order, and ':moduleType'
// would otherwise swallow the literal path "request" (moduleType='request'), making
// this handler permanently unreachable (found while adding TX-disabled 409 mapping,
// issue #4294 — the frontend's `/api/config/module/request` call was 400ing with
// "Invalid module type: request" instead of ever reaching this handler).
router.post('/module/request', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { configType } = req.body;
    if (configType === undefined) {
      fail(res, 400, 'MISSING_CONFIG_TYPE', 'configType is required');
      return;
    }
    const { manager: cfgModReqManager } = getDeviceSourceTarget(req);
    await cfgModReqManager.requestModuleConfig(configType);
    res.json({ success: true, message: 'Module config request sent' });
  } catch (error) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error requesting module config:', error);
    fail(res, 500, 'MODULE_CONFIG_REQUEST_FAILED', 'Failed to request module configuration');
  }
});

// Generic module config endpoint - handles extnotif, storeforward, rangetest, cannedmsg, audio,
// remotehardware, detectionsensor, paxcounter, serial, ambientlighting, statusmessage, trafficmanagement,
// meshbeacon, tak
//
router.post('/module/:moduleType', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { moduleType } = req.params;
    const { sourceId: _sourceId, ...config } = req.body;
    const { manager: cfgModManager } = getDeviceSourceTarget(req);

    // Validate moduleType against the shared allow-list (kept in sync with
    // protobufService.createSetModuleConfigMessageGeneric's configFieldMap). See #3464.
    if (!isValidModuleConfigType(moduleType)) {
      return fail(res, 400, 'INVALID_MODULE_TYPE', `Invalid module type: ${moduleType}`);
    }

    // MeshBeacon's nanopb limits fail silently on the device: an over-long
    // broadcast_message or a fifth broadcast_target makes nanopb discard the
    // whole ModuleConfig with no error and no log line, so the user just sees
    // settings that never saved. Mirror the remote-admin guard here — this
    // local path had none (#5062).
    if (moduleType === 'meshbeacon') {
      const meshBeaconError = validateMeshBeaconConfigPayload(config);
      if (meshBeaconError) {
        return fail(res, 400, 'INVALID_MESHBEACON_CONFIG', meshBeaconError);
      }
    }

    // Same failure shape for the Status Message text (#5616): node_status is a
    // 80-byte nanopb buffer that holds 79 bytes of text. A longer string makes
    // the node drop the whole admin message, so the status never saves and
    // nothing says why. Counted in UTF-8 bytes: emoji take 4 or more each.
    if (moduleType === 'statusmessage') {
      const statusMessageError = validateStatusMessageConfigPayload(config);
      if (statusMessageError) {
        return fail(res, 400, 'INVALID_STATUSMESSAGE_CONFIG', statusMessageError);
      }
    }

    // TAK team + role (#5613): refuse a value outside the two enums, then send
    // exactly the two fields as numbers.
    if (moduleType === 'tak') {
      const takError = validateTakConfigPayload(config);
      if (takError) {
        return fail(res, 400, 'INVALID_TAK_CONFIG', takError);
      }
      await cfgModManager.setGenericModuleConfig(moduleType, normalizeTakConfig(config));
      return res.json({ success: true, message: `${moduleType} configuration sent` });
    }

    await cfgModManager.setGenericModuleConfig(moduleType, config);
    res.json({ success: true, message: `${moduleType} configuration sent` });
  } catch (error) {
    logger.error(`Error setting ${req.params.moduleType} config:`, error);
    return fail(res, 500, 'MODULE_CONFIG_FAILED', `Failed to set ${req.params.moduleType} configuration`);
  }
});

router.post('/owner', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { longName, shortName, isUnmessagable, isLicensed } = req.body;
    if (!longName || !shortName) {
      fail(res, 400, 'MISSING_OWNER_NAME', 'longName and shortName are required');
      return;
    }
    const { manager: ownerManager } = getDeviceSourceTarget(req);
    await ownerManager.setNodeOwner(longName, shortName, isUnmessagable, isLicensed);
    res.json({ success: true, message: 'Node owner updated' });
  } catch (error) {
    logger.error('Error setting node owner:', error);
    fail(res, 500, 'OWNER_UPDATE_FAILED', 'Failed to set node owner');
  }
});

router.post('/request', requireDeviceSourcePermission('configuration', 'write', 'body'), async (req, res) => {
  try {
    const { configType } = req.body;
    if (configType === undefined) {
      fail(res, 400, 'MISSING_CONFIG_TYPE', 'configType is required');
      return;
    }
    const { manager: cfgReqManager } = getDeviceSourceTarget(req);
    await cfgReqManager.requestConfig(configType);
    res.json({ success: true, message: 'Config request sent' });
  } catch (error) {
    logger.error('Error requesting config:', error);
    fail(res, 500, 'CONFIG_REQUEST_FAILED', 'Failed to request configuration');
  }
});

export default router;
