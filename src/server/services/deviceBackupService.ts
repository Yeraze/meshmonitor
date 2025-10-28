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

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        continue; // Skip null/undefined values
      }

      const yamlKey = this.toSnakeCase(key);

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
      // Encode binary data as base64 with prefix
      return `"base64:${Buffer.from(value).toString('base64')}"`;
    }

    if (typeof value === 'string') {
      // Escape strings that need quoting
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

  /**
   * Convert camelCase to snake_case
   */
  private toSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }
}

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

      // 1. Canned messages (if configured in cannedMessage module)
      if (moduleConfig?.cannedMessage?.messages) {
        backup.canned_messages = moduleConfig.cannedMessage.messages;
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
      }

      // 4. Location (if available from position)
      const position = localNodeInfo?.position;
      if (position && (position.latitude || position.longitude)) {
        backup.location = {
          lat: position.latitude || 0,
          lon: position.longitude || 0,
          alt: position.altitude || 0
        };
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
        cleaned[key] = value;
      } else if (value instanceof Uint8Array && value.length > 0) {
        // Include non-empty binary data
        cleaned[key] = value;
      }
    }

    return cleaned;
  }
}

export const deviceBackupService = new DeviceBackupService();
