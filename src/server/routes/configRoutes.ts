/**
 * Config Routes
 *
 * GET /config           — public configuration (optionalAuth)
 * GET /config/current   — current device config (configuration:read)
 * POST /config/*        — 13 device configuration setters (configuration:write)
 *
 * Extracted verbatim from server.ts (was `apiRouter.get('/config', ...)` L3262
 * and `apiRouter.get('/config/current', ...)` + 13 POSTs, L4283–4488) as part
 * of #3502. Mounted at '/config' in server.ts.
 */
import express from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { resolveSourceConnectionConfig } from '../utils/resolveSourceConnectionConfig.js';
import { isValidModuleConfigType } from '../constants/moduleConfig.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { fail } from '../utils/apiResponse.js';
import { isTxDisabledError } from '../errors/txDisabledError.js';

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
    const localNodeNumStr = await databaseService.settings.getSettingForSource(
      configSourceId ?? null,
      'localNodeNum',
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
      ...(req.session.userId ? { meshtasticNodeIp: conn.host ?? '' } : {}),
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
// GET current configuration
router.get('/current', requirePermission('configuration', 'read'), (req, res) => {
  try {
    const ccSourceId = req.query.sourceId as string | undefined;
    const ccManager = resolveSourceManager(ccSourceId);
    const config = ccManager.getCurrentConfig();
    // Surface bridged-node status alongside the config so the configuration UI
    // can advise that a bridged node (no native IP) needs MQTT Client Proxy.
    res.json({ ...config, isBridged: ccManager.isLocalNodeBridged() });
  } catch (error) {
    logger.error('Error getting current config:', error);
    res.status(500).json({ error: 'Failed to get current configuration' });
  }
});

router.post('/device', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgDevSourceId, ...config } = req.body;
    const cfgDevManager = resolveSourceManager(cfgDevSourceId);
    await cfgDevManager.setDeviceConfig(config);
    res.json({ success: true, message: 'Device configuration sent' });
  } catch (error) {
    logger.error('Error setting device config:', error);
    res.status(500).json({ error: 'Failed to set device configuration' });
  }
});

router.post('/network', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgNetSourceId, ...config } = req.body;
    const cfgNetManager = resolveSourceManager(cfgNetSourceId);
    await cfgNetManager.setNetworkConfig(config);
    res.json({ success: true, message: 'Network configuration sent' });
  } catch (error) {
    logger.error('Error setting network config:', error);
    res.status(500).json({ error: 'Failed to set network configuration' });
  }
});

router.post('/lora', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgLoraSourceId, ...config } = req.body;
    const cfgLoraManager = resolveSourceManager(cfgLoraSourceId);

    // Pass through the submitted txEnabled as-is (issue #4294) — this is the
    // one legitimate place a user sets TX on/off. Do NOT force it to true here;
    // that used to silently revert receive-only radios back to TX-enabled on
    // every unrelated LoRa config save.
    logger.debug(`⚙️ Setting LoRa config: txEnabled=${config.txEnabled}`);
    await cfgLoraManager.setLoRaConfig(config);
    res.json({ success: true, message: 'LoRa configuration sent' });
  } catch (error) {
    logger.error('Error setting LoRa config:', error);
    res.status(500).json({ error: 'Failed to set LoRa configuration' });
  }
});

router.post('/position', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgPosSourceId, ...config } = req.body;
    const cfgPosManager = resolveSourceManager(cfgPosSourceId);
    await cfgPosManager.setPositionConfig(config);
    res.json({ success: true, message: 'Position configuration sent' });
  } catch (error) {
    logger.error('Error setting position config:', error);
    res.status(500).json({ error: 'Failed to set position configuration' });
  }
});

router.post('/mqtt', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgMqttSourceId, ...config } = req.body;
    const cfgMqttManager = resolveSourceManager(cfgMqttSourceId);
    await cfgMqttManager.setMQTTConfig(config);
    res.json({ success: true, message: 'MQTT configuration sent' });
  } catch (error) {
    logger.error('Error setting MQTT config:', error);
    res.status(500).json({ error: 'Failed to set MQTT configuration' });
  }
});

router.post('/neighborinfo', requirePermission('configuration', 'write'), async (req, res) => {
  logger.debug('🔍 DEBUG: /config/neighborinfo endpoint called with body:', JSON.stringify(req.body));
  try {
    const { sourceId: cfgNiSourceId, ...config } = req.body;
    const cfgNiManager = resolveSourceManager(cfgNiSourceId);
    await cfgNiManager.setNeighborInfoConfig(config);
    res.json({ success: true, message: 'NeighborInfo configuration sent' });
  } catch (error) {
    logger.error('Error setting NeighborInfo config:', error);
    res.status(500).json({ error: 'Failed to set NeighborInfo configuration' });
  }
});

router.post('/power', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgPwrSourceId, ...config } = req.body;
    const cfgPwrManager = resolveSourceManager(cfgPwrSourceId);
    await cfgPwrManager.setPowerConfig(config);
    res.json({ success: true, message: 'Power configuration sent' });
  } catch (error) {
    logger.error('Error setting power config:', error);
    res.status(500).json({ error: 'Failed to set power configuration' });
  }
});

router.post('/display', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgDispSourceId, ...config } = req.body;
    const cfgDispManager = resolveSourceManager(cfgDispSourceId);
    await cfgDispManager.setDisplayConfig(config);
    res.json({ success: true, message: 'Display configuration sent' });
  } catch (error) {
    logger.error('Error setting display config:', error);
    res.status(500).json({ error: 'Failed to set display configuration' });
  }
});

router.post('/module/telemetry', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgTelSourceId, ...config } = req.body;
    const cfgTelManager = resolveSourceManager(cfgTelSourceId);
    await cfgTelManager.setTelemetryConfig(config);
    res.json({ success: true, message: 'Telemetry configuration sent' });
  } catch (error) {
    logger.error('Error setting telemetry config:', error);
    res.status(500).json({ error: 'Failed to set telemetry configuration' });
  }
});

// Generic module config endpoint - handles extnotif, storeforward, rangetest, cannedmsg, audio,
// remotehardware, detectionsensor, paxcounter, serial, ambientlighting, statusmessage, trafficmanagement
router.post('/module/:moduleType', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { moduleType } = req.params;
    const { sourceId: cfgModSourceId, ...config } = req.body;
    const cfgModManager = resolveSourceManager(cfgModSourceId);

    // Validate moduleType against the shared allow-list (kept in sync with
    // protobufService.createSetModuleConfigMessageGeneric's configFieldMap). See #3464.
    if (!isValidModuleConfigType(moduleType)) {
      res.status(400).json({ error: `Invalid module type: ${moduleType}` });
      return;
    }

    await cfgModManager.setGenericModuleConfig(moduleType, config);
    res.json({ success: true, message: `${moduleType} configuration sent` });
  } catch (error) {
    logger.error(`Error setting ${req.params.moduleType} config:`, error);
    res.status(500).json({ error: `Failed to set ${req.params.moduleType} configuration` });
  }
});

router.post('/owner', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { longName, shortName, isUnmessagable, isLicensed, sourceId: ownerSourceId } = req.body;
    if (!longName || !shortName) {
      res.status(400).json({ error: 'longName and shortName are required' });
      return;
    }
    const ownerManager = resolveSourceManager(ownerSourceId);
    await ownerManager.setNodeOwner(longName, shortName, isUnmessagable, isLicensed);
    res.json({ success: true, message: 'Node owner updated' });
  } catch (error) {
    logger.error('Error setting node owner:', error);
    res.status(500).json({ error: 'Failed to set node owner' });
  }
});

router.post('/request', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { configType, sourceId: cfgReqSourceId } = req.body;
    if (configType === undefined) {
      res.status(400).json({ error: 'configType is required' });
      return;
    }
    const cfgReqManager = resolveSourceManager(cfgReqSourceId);
    await cfgReqManager.requestConfig(configType);
    res.json({ success: true, message: 'Config request sent' });
  } catch (error) {
    logger.error('Error requesting config:', error);
    res.status(500).json({ error: 'Failed to request configuration' });
  }
});

router.post('/module/request', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { configType, sourceId: cfgModReqSourceId } = req.body;
    if (configType === undefined) {
      res.status(400).json({ error: 'configType is required' });
      return;
    }
    const cfgModReqManager = resolveSourceManager(cfgModReqSourceId);
    await cfgModReqManager.requestModuleConfig(configType);
    res.json({ success: true, message: 'Module config request sent' });
  } catch (error) {
    if (isTxDisabledError(error)) {
      return fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source');
    }
    logger.error('Error requesting module config:', error);
    res.status(500).json({ error: 'Failed to request module configuration' });
  }
});

export default router;
