/**
 * Device Backup Service
 * Exports device configuration in YAML format compatible with Meshtastic CLI --export-config
 */

import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

/**
 * Simple YAML generator for device backup
 * Generates YAML without external dependencies
 */
class YAMLGenerator {
  private indent = '  ';

  /**
   * Convert a JavaScript object to YAML format
   */
  toYAML(obj: any, indentLevel: number = 0): string {
    const lines: string[] = [];
    const currentIndent = this.indent.repeat(indentLevel);

    // Sort keys alphabetically for nested objects (indentLevel > 0)
    // Top level (indentLevel === 0) preserves insertion order for intentional field ordering
    // Use case-sensitive sort (capitals before lowercase) to match official format
    const entries = indentLevel > 0
      ? Object.entries(obj).sort(([a], [b]) => {
          // Case-sensitive comparison: capitals come before lowercase
          if (a < b) return -1;
          if (a > b) return 1;
          return 0;
        })
      : Object.entries(obj);

    for (const [key, value] of entries) {
      if (value === null || value === undefined) {
        continue; // Skip null/undefined values
      }

      // Keep original key name - official format uses camelCase, not snake_case
      const yamlKey = key;

      if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
        // Nested object
        lines.push(`${currentIndent}${yamlKey}:`);
        lines.push(this.toYAML(value, indentLevel + 1));
      } else if (Array.isArray(value)) {
        // Array
        lines.push(`${currentIndent}${yamlKey}:`);
        for (const item of value) {
          if (typeof item === 'object') {
            lines.push(`${currentIndent}- `);
            lines.push(this.toYAML(item, indentLevel + 1).replace(new RegExp(`^${currentIndent}`, 'gm'), `${currentIndent}  `));
          } else {
            lines.push(`${currentIndent}- ${this.formatValue(item)}`);
          }
        }
      } else {
        // Simple value
        lines.push(`${currentIndent}${yamlKey}: ${this.formatValue(value)}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format a value for YAML output
   */
  private formatValue(value: any): string {
    if (value instanceof Uint8Array) {
      // Encode binary data as base64 with prefix - NO QUOTES (matches official format)
      return `base64:${Buffer.from(value).toString('base64')}`;
    }

    if (typeof value === 'string') {
      // Special handling for base64: prefixed strings - NO QUOTES (matches official format)
      if (value.startsWith('base64:')) {
        return value;
      }

      // Special handling for URLs - don't quote
      if (value.startsWith('http://') || value.startsWith('https://')) {
        return value;
      }

      // Special handling for timezone definitions - don't quote even though they contain colons
      // Pattern: EST5EDT,M3.2.0/2:00:00,M11.1.0/2:00:00
      if (value.match(/^[A-Z]{3,4}\d[A-Z]{3,4},M\d+\.\d+\.\d+\/\d+:\d+:\d+,M\d+\.\d+\.\d+\/\d+:\d+:\d+$/)) {
        return value;
      }

      // Escape strings that need quoting (contains special YAML chars)
      // Note: base64: values and tzdef are excluded above, so : in those won't trigger quoting
      if (value.includes(':') || value.includes('#') || value.includes('\n') || value.startsWith(' ') || value.endsWith(' ')) {
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return value;
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    if (typeof value === 'number') {
      return String(value);
    }

    return String(value);
  }
}

/**
 * Enum Mappings from Meshtastic Protobufs
 * These convert numeric enum values to their string names for YAML export
 */
const EnumMappings: Record<string, Record<number, string>> = {
  Role: {
    0: 'CLIENT',
    1: 'CLIENT_MUTE',
    2: 'ROUTER',
    3: 'ROUTER_CLIENT',
    4: 'REPEATER',
    5: 'TRACKER',
    6: 'SENSOR',
    7: 'TAK',
    8: 'CLIENT_HIDDEN',
    9: 'LOST_AND_FOUND',
    10: 'TAK_TRACKER',
    11: 'ROUTER_LATE',
    12: 'CLIENT_BASE'
  },
  ModemPreset: {
    0: 'LONG_FAST',
    1: 'LONG_SLOW',
    2: 'VERY_LONG_SLOW',
    3: 'MEDIUM_SLOW',
    4: 'MEDIUM_FAST',
    5: 'SHORT_SLOW',
    6: 'SHORT_FAST',
    7: 'LONG_MODERATE',
    8: 'SHORT_TURBO'
  },
  RegionCode: {
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
    15: 'UA_868',
    16: 'MY_433',
    17: 'MY_919',
    18: 'SG_923',
    19: 'PH_433',
    20: 'PH_868',
    21: 'PH_915',
    22: 'ANZ_433',
    23: 'KZ_433',
    24: 'KZ_863',
    25: 'NP_865',
    26: 'BR_902'
  },
  DetectionTriggerType: {
    0: 'NONE',
    1: 'LOGIC_HIGH',
    2: 'LOGIC_LOW'
  }
};

/**
 * Device Backup Service
 * Generates Meshtastic CLI-compatible YAML backups
 */
class DeviceBackupService {
  private yamlGenerator = new YAMLGenerator();

  /**
   * Generate a complete device backup in YAML format
   * Compatible with `meshtastic --export-config` format
   */
  async generateBackup(meshtasticManager: any): Promise<string> {
    logger.info('📦 Generating device backup...');

    try {
      // Get all necessary data
      const localNodeInfo = meshtasticManager.getLocalNodeInfo();
      const deviceConfig = meshtasticManager.getActualDeviceConfig();
      const moduleConfig = meshtasticManager.getActualModuleConfig();
      const channels = databaseService.getAllChannels();

      // Build backup object in the same structure as Meshtastic CLI
      // Field order matters for official format compatibility
      const backup: any = {};

      // 1. Canned messages (if configured)
      // Try multiple sources for canned messages
      let cannedMessages = null;

      // First check moduleConfig.cannedMessage.messages
      if (moduleConfig?.cannedMessage?.messages) {
        const messages = moduleConfig.cannedMessage.messages;
        cannedMessages = Array.isArray(messages) ? messages.join('|') : messages;
        logger.debug('Found canned messages in moduleConfig:', cannedMessages);
      }

      // Also check if it's stored as a database setting
      if (!cannedMessages) {
        const settingValue = databaseService.getSetting('canned_messages');
        if (settingValue) {
          cannedMessages = settingValue;
          logger.debug('Found canned messages in database settings:', cannedMessages);
        }
      }

      if (cannedMessages) {
        backup.canned_messages = cannedMessages;
        logger.debug('Added canned_messages to backup:', backup.canned_messages);
      } else {
        logger.debug('No canned messages found in moduleConfig or database settings');
      }

      // 2. Channel URL (if we can generate it)
      try {
        if (channels.length > 0) {
          const channelUrlService = (await import('./channelUrlService.js')).default;

          // Convert database channels to DecodedChannelSettings format
          const channelSettings = channels.map((ch: any) => ({
            psk: ch.psk ? ch.psk : 'none',
            name: ch.name,
            id: ch.id,
            role: ch.role,
            uplinkEnabled: ch.uplinkEnabled,
            downlinkEnabled: ch.downlinkEnabled,
            positionPrecision: ch.positionPrecision,
            mute: ch.mute
          }));

          // Get LoRa config from device configuration
          let loraConfig = undefined;
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
              configOkToMqtt: deviceConfig.lora.configOkToMqtt
            };
          }

          const channelUrl = channelUrlService.encodeUrl(channelSettings, loraConfig);
          if (channelUrl) {
            backup.channel_url = channelUrl;
          }
        }
      } catch (error) {
        logger.debug('Could not generate channel URL for backup:', error);
      }

      // 3. Device configurations
      if (deviceConfig && Object.keys(deviceConfig).length > 0) {
        backup.config = this.cleanConfig(deviceConfig);

        // Ensure bluetooth section exists with enabled field (defaults to false in official format)
        if (!backup.config.bluetooth) {
          backup.config.bluetooth = {};
        }
        if (backup.config.bluetooth.enabled === undefined) {
          backup.config.bluetooth.enabled = false;
        }

        // Ensure mqtt section exists in config (separate from module_config.mqtt)
        // with encryptionEnabled field (defaults to false in official format)
        if (!backup.config.mqtt) {
          backup.config.mqtt = {};
        }
        if (backup.config.mqtt.encryptionEnabled === undefined) {
          backup.config.mqtt.encryptionEnabled = false;
        }
      }

      // 4. Location (if available from database or position)
      // First try to get position from database (most reliable source)
      let locationData = null;
      logger.debug('Checking for location data:', {
        hasLocalNodeInfo: !!localNodeInfo,
        nodeNum: localNodeInfo?.nodeNum
      });

      if (localNodeInfo?.nodeNum) {
        const localNode = databaseService.getNode(localNodeInfo.nodeNum);
        logger.debug('Database lookup result:', {
          foundNode: !!localNode,
          hasLatitude: !!localNode?.latitude,
          hasLongitude: !!localNode?.longitude,
          latitude: localNode?.latitude,
          longitude: localNode?.longitude,
          altitude: localNode?.altitude
        });

        if (localNode && (localNode.latitude || localNode.longitude)) {
          locationData = {
            lat: localNode.latitude || 0,
            lon: localNode.longitude || 0,
            alt: localNode.altitude || 0
          };
          logger.debug('Found location in database:', locationData);
        }
      }

      // Fallback to localNodeInfo.position if database doesn't have it
      if (!locationData) {
        const position = localNodeInfo?.position;
        if (position && (position.latitude || position.longitude)) {
          locationData = {
            lat: position.latitude || 0,
            lon: position.longitude || 0,
            alt: position.altitude || 0
          };
          logger.debug('Found location in localNodeInfo.position:', locationData);
        }
      }

      if (locationData) {
        backup.location = locationData;
        logger.debug('Added location to backup:', backup.location);
      } else {
        logger.debug('No location data found in database or localNodeInfo');
      }

      // 5. Module configurations
      if (moduleConfig && Object.keys(moduleConfig).length > 0) {
        backup.module_config = this.cleanConfig(moduleConfig);
      }

      // 6. Owner information (at the end like official format)
      if (localNodeInfo) {
        backup.owner = localNodeInfo.longName || localNodeInfo.user?.longName || '';
        backup.owner_short = localNodeInfo.shortName || localNodeInfo.user?.shortName || '';
      }

      // NOTE: Channels array is NOT included in official --export-config format
      // The channel_url field contains all channel configuration data

      // Generate YAML with header comment
      const yaml = '# start of Meshtastic configure yaml\n' + this.yamlGenerator.toYAML(backup, 0);

      logger.info('✅ Device backup generated successfully');
      return yaml;

    } catch (error) {
      logger.error('❌ Error generating device backup:', error);
      throw new Error(`Failed to generate backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Convert enum numeric values to their string names
   */
  private convertEnumValue(key: string, value: any): any {
    // Device role
    if (key === 'role' && typeof value === 'number' && EnumMappings.Role[value]) {
      return EnumMappings.Role[value];
    }

    // LoRa modem preset
    if (key === 'modemPreset' && typeof value === 'number' && EnumMappings.ModemPreset[value]) {
      return EnumMappings.ModemPreset[value];
    }

    // LoRa region code
    if (key === 'region' && typeof value === 'number' && EnumMappings.RegionCode[value]) {
      return EnumMappings.RegionCode[value];
    }

    // Detection sensor trigger type
    if (key === 'detectionTriggerType' && typeof value === 'number' && EnumMappings.DetectionTriggerType[value]) {
      return EnumMappings.DetectionTriggerType[value];
    }

    return value;
  }

  /**
   * Clean configuration object by removing empty/null values
   * and organizing nested structures
   */
  private cleanConfig(config: any): any {
    const cleaned: any = {};

    for (const [key, value] of Object.entries(config)) {
      // Skip null, undefined, or empty objects
      if (value === null || value === undefined) {
        continue;
      }

      if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
        const cleanedNested = this.cleanConfig(value);
        if (Object.keys(cleanedNested).length > 0) {
          cleaned[key] = cleanedNested;
        }
      } else if (Array.isArray(value) && value.length > 0) {
        cleaned[key] = value;
      } else if (!(typeof value === 'object')) {
        // Include primitives (strings, numbers, booleans)
        // Convert enum values to string names
        cleaned[key] = this.convertEnumValue(key, value);
      } else if (value instanceof Uint8Array && value.length > 0) {
        // Include non-empty binary data
        cleaned[key] = value;
      }
    }

    return cleaned;
  }
}

export const deviceBackupService = new DeviceBackupService();
