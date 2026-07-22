/**
 * Local device-config setters + edit-session flow (#3962 Phase 4.2a PR5 §4e).
 *
 * Extracted from MeshtasticManager: the `set*Config`/`setNodeOwner` admin
 * senders (device/LoRa/network/channel/position/MQTT/NeighborInfo/power/
 * display/telemetry/generic-module), the begin/commit edit-settings
 * transaction pair, and `buildDeviceConfigFromActual` (the pure config
 * marshalling that turns the manager's cached actual-config state into the
 * shape the Configuration tab/API consume).
 *
 * Split decision (spec §4e "optional split", exercised here): local setters
 * live in THIS file; the remote-fetch flows (`requestRemoteConfig` and
 * friends) were extracted separately into `remoteAdminService.ts`. Combined
 * they would exceed the spec's ~800-line guideline, and — more importantly —
 * the remote-fetch flows have a materially different hazard shape: they
 * read/write `remoteNodeConfigs`/`remoteNodeChannels`/`remoteNodeOwners`/
 * `remoteNodeDeviceMetadata`/`pendingModuleConfigRequests`, all of which are
 * ALSO written by `processAdminMessage` (protobuf dispatch, out of scope per
 * spec §10) on packet receipt — the same "written on one side of the file,
 * read from the other" split PR4's `adminTransactionService.ts` documents for
 * `pendingAdminAcks`. The local setters here have no such split-brain state;
 * they only touch `actualDeviceConfig`/`actualModuleConfig` (via the
 * existing `updateCachedDeviceConfig` accessor and the new
 * `updateCachedModuleConfig` sibling below), so they were kept in a separate,
 * simpler file.
 *
 * `buildDeviceConfigFromActual` (spec §4e, "if cleanly separable — check its
 * dependencies first") turned out to be cleanly separable: every private
 * manager field/method it touches already had (or now has) a narrow public
 * accessor — `getLocalNodeInfo()`, `getActualDeviceConfig()`,
 * `getActualModuleConfig()`, `isDeviceConnected()` (all pre-existing from
 * earlier PRs), plus the new `getConnectionAddress()` below for the two
 * fields it read off the private `getConfig()` method. Its private
 * `calculateLoRaFrequency` wrapper was a trivial one-line delegate to the
 * already-exported `calculateLoRaFrequency` util with no other caller in the
 * file (verified: the only call site was inside this method) — deleted from
 * the manager as dead code rather than duplicated; this service imports the
 * util directly.
 *
 * Import-cycle discipline (task42a_spec.md §3): constructor-injected
 * `import type` reference to MeshtasticManager, never a static value import.
 */
import type { MeshtasticManager } from '../meshtasticManager.js';
import databaseService from '../../services/database.js';
import protobufService from '../protobufService.js';
import { calculateLoRaFrequency } from '../../utils/loraFrequency.js';
import { logger } from '../../utils/logger.js';

export class DeviceAdminService {
  constructor(private readonly mgr: MeshtasticManager) {}

  /**
   * Set device configuration (role, broadcast intervals, etc.)
   */
  async setDeviceConfig(config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending device config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetDeviceConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug('⚙️ Sent set_device_config admin message');
    } catch (error) {
      logger.error('❌ Error sending device config:', error);
      throw error;
    }
  }

  /**
   * Set LoRa configuration (preset, region, etc.)
   */
  async setLoRaConfig(config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending LoRa config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetLoRaConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      this.mgr.updateCachedDeviceConfig('lora', config);
      logger.debug('⚙️ Sent set_lora_config admin message');
    } catch (error) {
      logger.error('❌ Error sending LoRa config:', error);
      throw error;
    }
  }

  /**
   * Set network configuration (NTP server, etc.)
   */
  async setNetworkConfig(config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending network config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetNetworkConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      this.mgr.updateCachedDeviceConfig('network', config);
      logger.debug('⚙️ Sent set_network_config admin message');
    } catch (error) {
      logger.error('❌ Error sending network config:', error);
      throw error;
    }
  }

  /**
   * Set channel configuration
   * @param channelIndex The channel index (0-7)
   * @param config Channel configuration
   */
  async setChannelConfig(channelIndex: number, config: {
    name?: string;
    psk?: string;
    role?: number;
    uplinkEnabled?: boolean;
    downlinkEnabled?: boolean;
    positionPrecision?: number;
  }): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    if (channelIndex < 0 || channelIndex > 7) {
      throw new Error('Channel index must be between 0 and 7');
    }

    try {
      logger.debug(`⚙️ Sending channel ${channelIndex} config:`, JSON.stringify(config));
      const setChannelMsg = protobufService.createSetChannelMessage(channelIndex, config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setChannelMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`⚙️ Sent set_channel admin message for channel ${channelIndex}`);
    } catch (error) {
      logger.error(`❌ Error sending channel ${channelIndex} config:`, error);
      throw error;
    }
  }

  /**
   * Set position configuration (broadcast intervals, etc.)
   */
  async setPositionConfig(config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      // Extract position data if provided
      const { latitude, longitude, altitude, ...positionConfig } = config;

      // Per Meshtastic docs: Set fixed position coordinates FIRST, THEN set fixedPosition flag.
      // set_fixed_position automatically sets fixedPosition=true on the device.
      // No delay needed: firmware processes incoming messages sequentially from its receive buffer.
      if (latitude !== undefined && longitude !== undefined) {
        logger.debug(`⚙️ Setting fixed position coordinates: lat=${latitude}, lon=${longitude}, alt=${altitude || 0}`);
        const setPositionMsg = protobufService.createSetFixedPositionMessage(
          latitude,
          longitude,
          altitude || 0,
          new Uint8Array()
        );
        const positionPacket = protobufService.createAdminPacket(setPositionMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

        await this.mgr.sendLocalAdminPacket(positionPacket);
        logger.debug('⚙️ Sent set_fixed_position admin message');

        // Immediately update the local node's position in the database so it's correct
        // before any stale position broadcast arrives from the device firmware.
        const localNodeInfo = this.mgr.getLocalNodeInfo();
        if (localNodeInfo) {
          const localNodeNum = localNodeInfo.nodeNum;
          const localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
          await databaseService.upsertNodeAsync({
            nodeNum: localNodeNum,
            nodeId: localNodeId,
            latitude,
            longitude,
            altitude: altitude || 0,
            positionTimestamp: Date.now(),
          }, this.mgr.sourceId);
          logger.info(`⚙️ Updated local node ${localNodeId} position in database: lat=${latitude}, lon=${longitude}`);
        }
      }

      // Then send position configuration (fixedPosition flag, broadcast intervals, etc.)
      logger.debug('⚙️ Sending position config:', JSON.stringify(positionConfig));
      const setConfigMsg = protobufService.createSetPositionConfigMessage(positionConfig, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      this.mgr.updateCachedDeviceConfig('position', positionConfig);
      logger.debug('⚙️ Sent set_position_config admin message');
    } catch (error) {
      logger.error('❌ Error sending position config:', error);
      throw error;
    }
  }

  /**
   * Set MQTT module configuration
   */
  async setMQTTConfig(config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending MQTT config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetMQTTConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      this.mgr.updateCachedDeviceConfig('mqtt', config);
      logger.debug('⚙️ Sent set_mqtt_config admin message (direct, no transaction)');
    } catch (error) {
      logger.error('❌ Error sending MQTT config:', error);
      throw error;
    }
  }

  /**
   * Set NeighborInfo module configuration
   */
  async setNeighborInfoConfig(config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending NeighborInfo config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetNeighborInfoConfigMessage(config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      this.mgr.updateCachedDeviceConfig('neighborinfo', config);
      logger.debug('⚙️ Sent set_neighborinfo_config admin message (direct, no transaction)');
    } catch (error) {
      logger.error('❌ Error sending NeighborInfo config:', error);
      throw error;
    }
  }

  /**
   * Set power configuration
   */
  async setPowerConfig(config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending power config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetDeviceConfigMessageGeneric('power', config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug('⚙️ Sent set_power_config admin message');
    } catch (error) {
      logger.error('❌ Error sending power config:', error);
      throw error;
    }
  }

  /**
   * Set display configuration
   */
  async setDisplayConfig(config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending display config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetDeviceConfigMessageGeneric('display', config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug('⚙️ Sent set_display_config admin message');
    } catch (error) {
      logger.error('❌ Error sending display config:', error);
      throw error;
    }
  }

  /**
   * Set telemetry module configuration
   */
  async setTelemetryConfig(config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Sending telemetry config:', JSON.stringify(config));
      const setConfigMsg = protobufService.createSetModuleConfigMessageGeneric('telemetry', config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug('⚙️ Sent set_telemetry_config admin message');

      // Update local cache with the config that was sent
      this.mgr.updateCachedModuleConfig('telemetry', config);
      logger.debug('⚙️ Updated actualModuleConfig.telemetry cache');
    } catch (error) {
      logger.error('❌ Error sending telemetry config:', error);
      throw error;
    }
  }

  /**
   * Set generic module configuration
   * Handles: extnotif, storeforward, rangetest, cannedmsg, audio,
   * remotehardware, detectionsensor, paxcounter, serial, ambientlighting
   */
  async setGenericModuleConfig(moduleType: string, config: any): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Sending ${moduleType} config:`, JSON.stringify(config));
      const setConfigMsg = protobufService.createSetModuleConfigMessageGeneric(moduleType, config, new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(setConfigMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug(`⚙️ Sent set_${moduleType}_config admin message`);
    } catch (error) {
      logger.error(`❌ Error sending ${moduleType} config:`, error);
      throw error;
    }
  }

  /**
   * Set node owner (long name and short name)
   */
  async setNodeOwner(longName: string, shortName: string, isUnmessagable?: boolean, isLicensed?: boolean): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug(`⚙️ Setting node owner: "${longName}" (${shortName}), isUnmessagable: ${isUnmessagable}, isLicensed: ${isLicensed}`);
      const setOwnerMsg = protobufService.createSetOwnerMessage(longName, shortName, isUnmessagable, new Uint8Array(), isLicensed);
      const adminPacket = protobufService.createAdminPacket(setOwnerMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug('⚙️ Sent set_owner admin message (direct, no transaction)');
    } catch (error) {
      logger.error('❌ Error setting node owner:', error);
      throw error;
    }
  }

  /**
   * Begin edit settings transaction to batch configuration changes
   */
  async beginEditSettings(): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Beginning edit settings transaction');
      const beginMsg = protobufService.createBeginEditSettingsMessage(new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(beginMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug('⚙️ Sent begin_edit_settings admin message');
    } catch (error) {
      logger.error('❌ Error beginning edit settings:', error);
      throw error;
    }
  }

  /**
   * Commit edit settings to persist configuration changes
   */
  async commitEditSettings(): Promise<void> {
    if (!this.mgr.isTransportReady()) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      logger.debug('⚙️ Committing edit settings to persist configuration');
      const commitMsg = protobufService.createCommitEditSettingsMessage(new Uint8Array());
      const adminPacket = protobufService.createAdminPacket(commitMsg, this.mgr.getLocalNodeInfo()?.nodeNum || 0, this.mgr.getLocalNodeInfo()?.nodeNum);

      await this.mgr.sendLocalAdminPacket(adminPacket);
      logger.debug('⚙️ Sent commit_edit_settings admin message');

      // Wait a moment for device to save to flash
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      logger.error('❌ Error committing edit settings:', error);
      throw error;
    }
  }

  /**
   * Build the Configuration-tab/API device-config shape from the manager's
   * cached actual device/module config. Moved verbatim from
   * MeshtasticManager#buildDeviceConfigFromActual (private) — see this file's
   * header comment for why it was cleanly separable.
   */
  async buildDeviceConfigFromActual(): Promise<any> {
    const dbChannels = await databaseService.channels.getAllChannels(this.mgr.sourceId);
    const channels = dbChannels.map(ch => ({
      index: ch.id,
      name: ch.name,
      psk: ch.psk ? 'Set' : 'None',
      role: ch.role,
      uplinkEnabled: ch.uplinkEnabled,
      downlinkEnabled: ch.downlinkEnabled,
      positionPrecision: ch.positionPrecision
    }));

    const localNode = this.mgr.getLocalNodeInfo() as any;

    // Extract actual values from stored config or use sensible defaults
    const loraConfig = this.mgr.getActualDeviceConfig()?.lora || {};
    const mqttConfig = this.mgr.getActualModuleConfig()?.mqtt || {};

    // IMPORTANT: Proto3 may omit boolean false and numeric 0 values from JSON serialization
    // but they're still accessible as properties. We need to explicitly include them.
    const loraConfigWithDefaults = {
      ...loraConfig,
      // Ensure usePreset is explicitly set (Proto3 default is false)
      usePreset: loraConfig.usePreset !== undefined ? loraConfig.usePreset : false,
      // Ensure frequencyOffset is explicitly set (Proto3 default is 0)
      frequencyOffset: loraConfig.frequencyOffset !== undefined ? loraConfig.frequencyOffset : 0,
      // Ensure overrideFrequency is explicitly set (Proto3 default is 0)
      overrideFrequency: loraConfig.overrideFrequency !== undefined ? loraConfig.overrideFrequency : 0,
      // Ensure modemPreset is explicitly set (Proto3 default is 0 = LONG_FAST)
      modemPreset: loraConfig.modemPreset !== undefined ? loraConfig.modemPreset : 0,
      // Ensure channelNum is explicitly set (Proto3 default is 0)
      channelNum: loraConfig.channelNum !== undefined ? loraConfig.channelNum : 0
    };

    // Apply same Proto3 handling to MQTT config
    const mqttConfigWithDefaults = {
      ...mqttConfig,
      // Ensure boolean fields are explicitly set (Proto3 default is false)
      enabled: mqttConfig.enabled !== undefined ? mqttConfig.enabled : false,
      encryptionEnabled: mqttConfig.encryptionEnabled !== undefined ? mqttConfig.encryptionEnabled : false,
      jsonEnabled: mqttConfig.jsonEnabled !== undefined ? mqttConfig.jsonEnabled : false,
      tlsEnabled: mqttConfig.tlsEnabled !== undefined ? mqttConfig.tlsEnabled : false,
      proxyToClientEnabled: mqttConfig.proxyToClientEnabled !== undefined ? mqttConfig.proxyToClientEnabled : false,
      mapReportingEnabled: mqttConfig.mapReportingEnabled !== undefined ? mqttConfig.mapReportingEnabled : false
    };

    logger.debug('🔍 loraConfig being used:', JSON.stringify(loraConfigWithDefaults, null, 2));
    logger.debug('🔍 mqttConfig being used:', JSON.stringify(mqttConfigWithDefaults, null, 2));

    // Map region enum values to strings
    const regionMap: { [key: number]: string } = {
      0: 'UNSET',
      1: 'US',
      2: 'EU_433',
      3: 'EU_868',
      4: 'CN',
      5: 'JP',
      6: 'ANZ',
      7: 'KR',
      8: 'TW',
      9: 'RU',
      10: 'IN',
      11: 'NZ_865',
      12: 'TH',
      13: 'LORA_24',
      14: 'UA_433',
      15: 'UA_868'
    };

    // Map modem preset enum values to strings
    const modemPresetMap: { [key: number]: string } = {
      0: 'Long Fast',
      1: 'Long Slow',
      2: 'Very Long Slow',
      3: 'Medium Slow',
      4: 'Medium Fast',
      5: 'Short Slow',
      6: 'Short Fast',
      7: 'Long Moderate',
      8: 'Short Turbo'
    };

    // Convert enum values to human-readable strings
    const regionValue = typeof loraConfigWithDefaults.region === 'number' ? regionMap[loraConfigWithDefaults.region] || `Unknown (${loraConfigWithDefaults.region})` : loraConfigWithDefaults.region || 'Unknown';
    const modemPresetValue = typeof loraConfigWithDefaults.modemPreset === 'number' ? modemPresetMap[loraConfigWithDefaults.modemPreset] || `Unknown (${loraConfigWithDefaults.modemPreset})` : loraConfigWithDefaults.modemPreset || 'Unknown';

    const connectionAddress = await this.mgr.getConnectionAddress();

    return {
      basic: {
        nodeAddress: connectionAddress.nodeIp,
        tcpPort: connectionAddress.tcpPort,
        connected: this.mgr.isDeviceConnected(),
        nodeId: localNode?.nodeId || null,
        nodeName: localNode?.longName || null,
        firmwareVersion: localNode?.firmwareVersion || null
      },
      radio: {
        region: regionValue,
        modemPreset: modemPresetValue,
        hopLimit: loraConfigWithDefaults.hopLimit !== undefined ? loraConfigWithDefaults.hopLimit : 'Unknown',
        txPower: loraConfigWithDefaults.txPower !== undefined ? loraConfigWithDefaults.txPower : 'Unknown',
        bandwidth: loraConfigWithDefaults.bandwidth || 'Unknown',
        spreadFactor: loraConfigWithDefaults.spreadFactor || 'Unknown',
        codingRate: loraConfigWithDefaults.codingRate || 'Unknown',
        channelNum: loraConfigWithDefaults.channelNum !== undefined ? loraConfigWithDefaults.channelNum : 'Unknown',
        frequency: calculateLoRaFrequency(
          typeof loraConfigWithDefaults.region === 'number' ? loraConfigWithDefaults.region : 0,
          loraConfigWithDefaults.channelNum !== undefined ? loraConfigWithDefaults.channelNum : 0,
          loraConfigWithDefaults.overrideFrequency !== undefined ? loraConfigWithDefaults.overrideFrequency : 0,
          loraConfigWithDefaults.frequencyOffset !== undefined ? loraConfigWithDefaults.frequencyOffset : 0,
          typeof loraConfigWithDefaults.bandwidth === 'number' && loraConfigWithDefaults.bandwidth > 0 ? loraConfigWithDefaults.bandwidth : 250,
          dbChannels.find(ch => ch.id === 0)?.name || undefined,
          typeof loraConfigWithDefaults.modemPreset === 'number' ? loraConfigWithDefaults.modemPreset : undefined
        ),
        txEnabled: loraConfigWithDefaults.txEnabled !== undefined ? loraConfigWithDefaults.txEnabled : 'Unknown',
        sx126xRxBoostedGain: loraConfigWithDefaults.sx126xRxBoostedGain !== undefined ? loraConfigWithDefaults.sx126xRxBoostedGain : 'Unknown',
        configOkToMqtt: loraConfigWithDefaults.configOkToMqtt !== undefined ? loraConfigWithDefaults.configOkToMqtt : 'Unknown',
        femLnaMode: loraConfigWithDefaults.femLnaMode !== undefined ? loraConfigWithDefaults.femLnaMode : 'Unknown'
      },
      mqtt: {
        enabled: mqttConfigWithDefaults.enabled,
        server: mqttConfigWithDefaults.address || 'Not configured',
        username: mqttConfigWithDefaults.username || 'Not set',
        encryption: mqttConfigWithDefaults.encryptionEnabled,
        json: mqttConfigWithDefaults.jsonEnabled,
        tls: mqttConfigWithDefaults.tlsEnabled,
        rootTopic: mqttConfigWithDefaults.root || 'msh'
      },
      channels: channels.length > 0 ? channels : [
        { index: 0, name: 'Primary', psk: 'None', uplinkEnabled: true, downlinkEnabled: true }
      ],
      // Raw LoRa config for export/import functionality - now includes Proto3 defaults
      lora: Object.keys(loraConfigWithDefaults).length > 0 ? loraConfigWithDefaults : undefined
    };
  }
}
