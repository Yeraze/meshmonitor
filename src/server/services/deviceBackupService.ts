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
      const backup: any = {};

      // Owner information
      if (localNodeInfo) {
        backup.owner = localNodeInfo.longName || localNodeInfo.user?.longName || '';
        backup.owner_short = localNodeInfo.shortName || localNodeInfo.user?.shortName || '';
      }

      // Channel URL (if we can generate it)
      try {
        // Try to get the channel URL from the API
        const channelIds = channels.map((ch: any) => ch.id).sort((a: number, b: number) => a - b);
        if (channelIds.length > 0) {
          // Note: We'd need to import channelUrlService here, but for now skip it
          // backup.channelUrl = await channelUrlService.encodeChannelUrl(channelIds, true);
        }
      } catch (error) {
        logger.debug('Could not generate channel URL for backup');
      }

      // Location (if available from position)
      const position = localNodeInfo?.position;
      if (position && (position.latitude || position.longitude)) {
        backup.location = {
          lat: position.latitude || 0,
          lon: position.longitude || 0,
          alt: position.altitude || 0
        };
      }

      // Device configurations
      if (deviceConfig && Object.keys(deviceConfig).length > 0) {
        backup.config = this.cleanConfig(deviceConfig);
      }

      // Module configurations
      if (moduleConfig && Object.keys(moduleConfig).length > 0) {
        backup.module_config = this.cleanConfig(moduleConfig);
      }

      // Channel configurations
      if (channels && channels.length > 0) {
        backup.channels = channels.map((ch: any) => {
          const channelConfig: any = {
            index: ch.id,
            role: ch.role || 0
          };

          // Only include name if it's not empty
          if (ch.name && ch.name.trim()) {
            channelConfig.name = ch.name;
          }

          // Include PSK if present (as base64)
          if (ch.psk) {
            channelConfig.psk = ch.psk;
          }

          // Include uplink/downlink settings if they differ from defaults
          if (ch.uplinkEnabled !== undefined) {
            channelConfig.uplink_enabled = ch.uplinkEnabled;
          }
          if (ch.downlinkEnabled !== undefined) {
            channelConfig.downlink_enabled = ch.downlinkEnabled;
          }

          // Include position precision if set
          if (ch.positionPrecision !== undefined && ch.positionPrecision !== null) {
            channelConfig.position_precision = ch.positionPrecision;
          }

          return channelConfig;
        });
      }

      // Generate YAML
      const yaml = this.yamlGenerator.toYAML(backup, 0);

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
