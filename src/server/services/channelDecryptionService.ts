/**
 * Channel Decryption Service
 *
 * Provides server-side decryption of Meshtastic packets using channel keys
 * stored in the channel database. This enables MeshMonitor to decrypt packets
 * for channels not configured on the connected device.
 *
 * Meshtastic Encryption Spec:
 * - AES-128-CTR (16-byte key) or AES-256-CTR (32-byte key)
 * - Nonce: packetId (8 bytes, little-endian) + fromNode (4 bytes, little-endian) + extraNonce (4 bytes, usually 0)
 */
import { createDecipheriv } from 'crypto';
import { getProtobufRoot } from '../protobufLoader.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { CHANNEL_CACHE_TTL_MS } from '../constants/meshtastic.js';

export interface DecryptionResult {
  success: boolean;
  channelDatabaseId?: number;
  channelName?: string;
  portnum?: number;
  payload?: Uint8Array;
  error?: string;
}

interface CachedChannel {
  id: number;
  name: string;
  psk: Buffer;
  pskLength: number;
  enforceNameValidation: boolean;
  expectedChannelHash?: number;
}

/**
 * Compute XOR hash of bytes (Meshtastic channel hash algorithm)
 * @param bytes The buffer to hash
 * @returns 8-bit XOR hash
 */
function xorHash(bytes: Buffer): number {
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
  }
  return hash & 0xff;
}

/**
 * Compute the expected channel hash from name and PSK
 * Meshtastic formula: hash = xorHash(name_bytes) ^ xorHash(psk_bytes)
 *
 * @param name Channel name (will be UTF-8 encoded)
 * @param psk Pre-shared key buffer
 * @returns 8-bit channel hash (0-255)
 */
function computeChannelHash(name: string, psk: Buffer): number {
  const nameBytes = Buffer.from(name, 'utf8');
  return xorHash(nameBytes) ^ xorHash(psk);
}

class ChannelDecryptionService {
  private channelCache: Map<number, CachedChannel> = new Map();
  private enabled: boolean = true;
  private maxDecryptionAttempts: number = 20;
  private lastCacheRefresh: number = 0;
  private readonly CACHE_TTL_MS = CHANNEL_CACHE_TTL_MS;

  constructor() {
    // Cache will be loaded lazily on first use
  }

  /**
   * Check if server-side decryption is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable or disable server-side decryption
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    logger.info(`Channel decryption service ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set maximum decryption attempts per packet
   */
  setMaxDecryptionAttempts(max: number): void {
    this.maxDecryptionAttempts = max;
  }

  /**
   * Get current cache size
   */
  getCacheSize(): number {
    return this.channelCache.size;
  }

  /**
   * Refresh channel cache from database
   */
  async refreshChannelCache(): Promise<void> {
    try {
      const channels = await databaseService.getEnabledChannelDatabaseEntriesAsync();
      this.channelCache.clear();

      for (const channel of channels) {
        try {
          // Skip channels without an id (shouldn't happen in practice)
          if (channel.id === undefined) {
            logger.warn(`Channel "${channel.name}": No id, skipping.`);
            continue;
          }

          const pskBuffer = Buffer.from(channel.psk, 'base64');

          // Validate PSK length matches declared length
          if (pskBuffer.length !== channel.pskLength) {
            logger.warn(
              `Channel "${channel.name}" (id=${channel.id}): PSK length mismatch. ` +
                `Expected ${channel.pskLength}, got ${pskBuffer.length}. Skipping.`
            );
            continue;
          }

          // Validate PSK length is valid for AES
          if (channel.pskLength !== 16 && channel.pskLength !== 32) {
            logger.warn(
              `Channel "${channel.name}" (id=${channel.id}): Invalid PSK length ${channel.pskLength}. ` +
                `Must be 16 (AES-128) or 32 (AES-256). Skipping.`
            );
            continue;
          }

          // Compute expected channel hash if name validation is enabled
          const enforceNameValidation = channel.enforceNameValidation ?? false;
          const expectedChannelHash = enforceNameValidation
            ? computeChannelHash(channel.name, pskBuffer)
            : undefined;

          this.channelCache.set(channel.id, {
            id: channel.id,
            name: channel.name,
            psk: pskBuffer,
            pskLength: channel.pskLength,
            enforceNameValidation,
            expectedChannelHash,
          });
        } catch (err) {
          logger.warn(`Failed to process channel "${channel.name}" (id=${channel.id}):`, err);
        }
      }

      this.lastCacheRefresh = Date.now();
      logger.debug(`Channel decryption cache refreshed: ${this.channelCache.size} channels loaded`);
    } catch (err) {
      logger.error('Failed to refresh channel decryption cache:', err);
    }
  }

  /**
   * Ensure cache is fresh (lazy refresh)
   */
  private async ensureCacheFresh(): Promise<void> {
    if (Date.now() - this.lastCacheRefresh > this.CACHE_TTL_MS) {
      await this.refreshChannelCache();
    }
  }

  /**
   * Invalidate cache (call when channels are added/updated/deleted)
   */
  invalidateCache(): void {
    this.lastCacheRefresh = 0;
    logger.debug('Channel decryption cache invalidated');
  }

  /**
   * Build the AES-CTR nonce per Meshtastic firmware spec
   *
   * Nonce format (16 bytes):
   * - bytes 0-7: packetId as 64-bit little-endian
   * - bytes 8-11: fromNode as 32-bit little-endian
   * - bytes 12-15: extraNonce (0 for normal packets)
   */
  private buildNonce(packetId: number, fromNode: number, extraNonce: number = 0): Buffer {
    const nonce = Buffer.alloc(16);

    // Write packetId as 64-bit little-endian
    // JavaScript numbers are 64-bit floats, but packetId fits in 32 bits typically
    // We write it as two 32-bit values for proper handling
    nonce.writeUInt32LE(packetId >>> 0, 0); // Lower 32 bits
    nonce.writeUInt32LE(0, 4); // Upper 32 bits (typically 0 for 32-bit packet IDs)

    // Write fromNode as 32-bit little-endian
    nonce.writeUInt32LE(fromNode >>> 0, 8);

    // Write extraNonce as 32-bit little-endian
    nonce.writeUInt32LE(extraNonce >>> 0, 12);

    return nonce;
  }

  /**
   * Try to decrypt with a single key
   */
  private tryDecryptWithKey(
    encryptedPayload: Uint8Array,
    nonce: Buffer,
    psk: Buffer,
    pskLength: number
  ): Buffer | null {
    try {
      const algorithm = pskLength === 16 ? 'aes-128-ctr' : 'aes-256-ctr';
      const decipher = createDecipheriv(algorithm, psk, nonce);
      const decrypted = Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);
      return decrypted;
    } catch (_err) {
      // Decryption failure is expected for wrong keys
      return null;
    }
  }

  /**
   * Check if decrypted data looks like valid protobuf
   *
   * A valid Meshtastic Data protobuf should:
   * 1. Have a reasonable portnum (field 1, varint)
   * 2. Not have obviously wrong values
   */
  private isValidProtobuf(data: Buffer): { valid: boolean; portnum?: number; payload?: Uint8Array } {
    try {
      // Get the Data type from loaded protobuf definitions
      const root = getProtobufRoot();
      if (!root) {
        logger.warn('Protobuf root not loaded yet - cannot validate decryption');
        return { valid: false };
      }

      const DataType = root.lookupType('meshtastic.Data');
      const decoded = DataType.decode(data) as any;

      // Check if portnum is in valid range (0-256 for Meshtastic)
      const portnum = decoded.portnum ?? 0;
      if (portnum < 0 || portnum > 256) {
        return { valid: false };
      }

      // Additional sanity checks:
      // - Portnum 0 is UNKNOWN_APP and valid
      // - Most common portnums are < 100
      // - Payload should exist for most message types

      return {
        valid: true,
        portnum: portnum,
        payload: decoded.payload ? new Uint8Array(decoded.payload) : undefined,
      };
    } catch {
      // Parse failure means invalid protobuf
      return { valid: false };
    }
  }

  /**
   * Try decryption with all enabled database channels
   *
   * @param encryptedPayload The encrypted packet payload
   * @param packetId The packet's unique ID
   * @param fromNode The sender's node number
   * @param channelHash Optional 8-bit channel hash from packet (meshPacket.channel)
   * @returns DecryptionResult with success status and decoded data if successful
   */
  async tryDecrypt(
    encryptedPayload: Uint8Array,
    packetId: number,
    fromNode: number,
    channelHash?: number
  ): Promise<DecryptionResult> {
    if (!this.enabled) {
      return { success: false, error: 'Server-side decryption is disabled' };
    }

    if (!encryptedPayload || encryptedPayload.length === 0) {
      return { success: false, error: 'Empty encrypted payload' };
    }

    // Ensure cache is fresh
    await this.ensureCacheFresh();

    if (this.channelCache.size === 0) {
      return { success: false, error: 'No channels configured for decryption' };
    }

    // Build the nonce once (same for all attempts)
    const nonce = this.buildNonce(packetId, fromNode);

    // Try each channel, up to maxDecryptionAttempts
    let attempts = 0;
    for (const [id, channel] of this.channelCache) {
      // If channel has name validation enabled and packet has a channel hash,
      // skip this channel if the hash doesn't match (don't count as an attempt)
      if (
        channel.enforceNameValidation &&
        channel.expectedChannelHash !== undefined &&
        channelHash !== undefined &&
        channel.expectedChannelHash !== channelHash
      ) {
        continue;
      }

      if (attempts >= this.maxDecryptionAttempts) {
        logger.debug(
          `Decryption attempt limit reached (${this.maxDecryptionAttempts}) for packet ${packetId}`
        );
        break;
      }
      attempts++;

      const decrypted = this.tryDecryptWithKey(encryptedPayload, nonce, channel.psk, channel.pskLength);
      if (!decrypted) {
        continue;
      }

      // Validate the decrypted data looks like valid protobuf
      const validation = this.isValidProtobuf(decrypted);
      if (!validation.valid) {
        continue;
      }

      // Success! Update the channel's decrypted count
      try {
        await databaseService.incrementChannelDatabaseDecryptedCountAsync(id);
      } catch (err) {
        logger.warn(`Failed to update decrypted count for channel ${id}:`, err);
      }

      logger.debug(
        `Server-side decryption successful: packet ${packetId} decrypted with channel "${channel.name}" (portnum=${validation.portnum})`
      );

      return {
        success: true,
        channelDatabaseId: id,
        channelName: channel.name,
        portnum: validation.portnum,
        payload: validation.payload,
      };
    }

    return {
      success: false,
      error: `Failed to decrypt with any of ${attempts} channel(s)`,
    };
  }

  /**
   * Try to decrypt a packet using a specific channel ID
   * (useful for retroactive processing)
   */
  async tryDecryptWithChannel(
    encryptedPayload: Uint8Array,
    packetId: number,
    fromNode: number,
    channelDatabaseId: number
  ): Promise<DecryptionResult> {
    // Ensure cache is fresh
    await this.ensureCacheFresh();

    const channel = this.channelCache.get(channelDatabaseId);
    if (!channel) {
      return { success: false, error: `Channel ${channelDatabaseId} not found or not enabled` };
    }

    const nonce = this.buildNonce(packetId, fromNode);
    const decrypted = this.tryDecryptWithKey(encryptedPayload, nonce, channel.psk, channel.pskLength);

    if (!decrypted) {
      return { success: false, error: 'Decryption failed' };
    }

    const validation = this.isValidProtobuf(decrypted);
    if (!validation.valid) {
      return { success: false, error: 'Decrypted data is not valid protobuf' };
    }

    return {
      success: true,
      channelDatabaseId,
      channelName: channel.name,
      portnum: validation.portnum,
      payload: validation.payload,
    };
  }

  /**
   * Get list of all cached channel IDs (for retroactive processing)
   */
  async getEnabledChannelIds(): Promise<number[]> {
    await this.ensureCacheFresh();
    return Array.from(this.channelCache.keys());
  }

  /**
   * Get channel info by ID
   */
  async getChannelInfo(id: number): Promise<{ name: string; pskLength: number } | null> {
    await this.ensureCacheFresh();
    const channel = this.channelCache.get(id);
    if (!channel) return null;
    return { name: channel.name, pskLength: channel.pskLength };
  }
}

// Export singleton instance
export const channelDecryptionService = new ChannelDecryptionService();
export default channelDecryptionService;

// Export hash functions for testing
export { xorHash, computeChannelHash };
