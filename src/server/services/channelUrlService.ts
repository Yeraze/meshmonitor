/**
 * Meshtastic Channel URL Service
 *
 * Handles encoding/decoding of Meshtastic channel configuration URLs
 * Format: https://meshtastic.org/e/#<base64-encoded-ChannelSet-protobuf>
 */
import { getProtobufRoot } from '../protobufLoader.js';
import { logger } from '../../utils/logger.js';

export interface DecodedChannelSettings {
  psk?: string;  // Base64 encoded PSK, or special value like "default" for shorthand 1
  name?: string;
  id?: number;
  uplinkEnabled?: boolean;
  downlinkEnabled?: boolean;
  positionPrecision?: number;
  mute?: boolean;
}

export interface DecodedLoRaConfig {
  usePreset?: boolean;
  modemPreset?: number;
  bandwidth?: number;
  spreadFactor?: number;
  codingRate?: number;
  frequencyOffset?: number;
  region?: number;
  hopLimit?: number;
  txEnabled?: boolean;
  txPower?: number;
  channelNum?: number;
  sx126xRxBoostedGain?: boolean;
  configOkToMqtt?: boolean;
}

export interface DecodedChannelSet {
  channels: DecodedChannelSettings[];
  loraConfig?: DecodedLoRaConfig;
}

class ChannelUrlService {
  /**
   * Decode a Meshtastic channel URL
   * @param url Full URL like https://meshtastic.org/e/#<base64> or just the base64 part
   */
  decodeUrl(url: string): DecodedChannelSet | null {
    try {
      // Extract base64 part from URL
      let base64Data = url;
      if (url.includes('#')) {
        base64Data = url.split('#')[1];
      }

      // Add padding if needed
      const missingPadding = base64Data.length % 4;
      if (missingPadding) {
        base64Data += '='.repeat(4 - missingPadding);
      }

      // Decode from base64
      const binaryData = Buffer.from(base64Data, 'base64');

      // Decode using protobuf
      const root = getProtobufRoot();
      if (!root) {
        logger.error('Protobuf definitions not loaded');
        return null;
      }

      const ChannelSet = root.lookupType('meshtastic.ChannelSet');
      const channelSet = ChannelSet.decode(binaryData);
      const channelSetObj = ChannelSet.toObject(channelSet, {
        longs: Number,
        enums: Number,
        bytes: String,
        defaults: true,
        arrays: true,
        objects: true,
        oneofs: true
      });

      logger.info('Decoded ChannelSet:', JSON.stringify(channelSetObj, null, 2));

      // Convert to our format
      const result: DecodedChannelSet = {
        channels: [],
        loraConfig: undefined
      };

      // Process channels
      if (channelSetObj.settings && Array.isArray(channelSetObj.settings)) {
        result.channels = channelSetObj.settings.map((ch: any) => {
          const channel: DecodedChannelSettings = {};

          // Handle PSK
          if (ch.psk) {
            if (typeof ch.psk === 'string') {
              // If it's a single byte, it's a shorthand
              const decoded = Buffer.from(ch.psk, 'base64');
              if (decoded.length === 1) {
                const value = decoded[0];
                if (value === 0) {
                  channel.psk = 'none';
                } else if (value === 1) {
                  channel.psk = 'default';
                } else if (value >= 2 && value <= 10) {
                  channel.psk = `simple${value - 1}`;
                } else {
                  channel.psk = ch.psk;
                }
              } else {
                channel.psk = ch.psk;
              }
            }
          }

          if (ch.name) channel.name = ch.name;
          if (ch.id !== undefined) channel.id = ch.id;
          if (ch.uplinkEnabled !== undefined) channel.uplinkEnabled = ch.uplinkEnabled;
          if (ch.downlinkEnabled !== undefined) channel.downlinkEnabled = ch.downlinkEnabled;
          if (ch.mute !== undefined) channel.mute = ch.mute;

          // Extract position precision from module settings
          if (ch.moduleSettings && ch.moduleSettings.positionPrecision !== undefined) {
            channel.positionPrecision = ch.moduleSettings.positionPrecision;
          }

          return channel;
        });
      }

      // Process LoRa config
      if (channelSetObj.loraConfig) {
        const lc = channelSetObj.loraConfig;
        result.loraConfig = {
          usePreset: lc.usePreset,
          modemPreset: lc.modemPreset,
          bandwidth: lc.bandwidth,
          spreadFactor: lc.spreadFactor,
          codingRate: lc.codingRate,
          frequencyOffset: lc.frequencyOffset,
          region: lc.region,
          hopLimit: lc.hopLimit,
          txEnabled: lc.txEnabled,
          txPower: lc.txPower,
          channelNum: lc.channelNum,
          sx126xRxBoostedGain: lc.sx126xRxBoostedGain,
          configOkToMqtt: lc.configOkToMqtt
        };
      }

      return result;
    } catch (error) {
      logger.error('Failed to decode channel URL:', error);
      return null;
    }
  }

  /**
   * Encode channel settings and LoRa config into a Meshtastic URL
   */
  encodeUrl(channels: DecodedChannelSettings[], loraConfig?: DecodedLoRaConfig): string | null {
    try {
      const root = getProtobufRoot();
      if (!root) {
        logger.error('Protobuf definitions not loaded');
        return null;
      }

      const ChannelSet = root.lookupType('meshtastic.ChannelSet');
      const ChannelSettings = root.lookupType('meshtastic.ChannelSettings');
      const ModuleSettings = root.lookupType('meshtastic.ModuleSettings');
      const LoRaConfig = root.lookupType('meshtastic.Config.LoRaConfig');

      // Build channel settings array
      const settings = channels.map(ch => {
        const channelSettings: any = {};

        // Handle PSK
        if (ch.psk) {
          if (ch.psk === 'none') {
            channelSettings.psk = Buffer.from([0]);
          } else if (ch.psk === 'default') {
            channelSettings.psk = Buffer.from([1]);
          } else if (ch.psk.startsWith('simple')) {
            const num = parseInt(ch.psk.replace('simple', ''));
            channelSettings.psk = Buffer.from([num + 1]);
          } else {
            // Assume it's a base64 encoded key
            channelSettings.psk = Buffer.from(ch.psk, 'base64');
          }
        }

        if (ch.name) channelSettings.name = ch.name;
        if (ch.id !== undefined) channelSettings.id = ch.id;
        if (ch.uplinkEnabled !== undefined) channelSettings.uplinkEnabled = ch.uplinkEnabled;
        if (ch.downlinkEnabled !== undefined) channelSettings.downlinkEnabled = ch.downlinkEnabled;
        if (ch.mute !== undefined) channelSettings.mute = ch.mute;

        // Add module settings if position precision is set
        if (ch.positionPrecision !== undefined) {
          const moduleSettings = ModuleSettings.create({
            positionPrecision: ch.positionPrecision
          });
          channelSettings.moduleSettings = moduleSettings;
        }

        return ChannelSettings.create(channelSettings);
      });

      // Build ChannelSet
      const channelSetData: any = {
        settings
      };

      // Add LoRa config if provided
      if (loraConfig) {
        channelSetData.loraConfig = LoRaConfig.create(loraConfig);
      }

      const channelSet = ChannelSet.create(channelSetData);
      const encoded = ChannelSet.encode(channelSet).finish();

      // Convert to base64
      const base64 = Buffer.from(encoded).toString('base64');

      // Remove padding (Meshtastic URLs don't use padding)
      const base64NoPadding = base64.replace(/=/g, '');

      return `https://meshtastic.org/e/#${base64NoPadding}`;
    } catch (error) {
      logger.error('Failed to encode channel URL:', error);
      return null;
    }
  }
}

export default new ChannelUrlService();
