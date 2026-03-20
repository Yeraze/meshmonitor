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
import { CHANNEL_CACHE_TTL_MS, expandShorthandPsk, PortNum } from '../constants/meshtastic.js';

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
  enforceNameValidation: boolean;
  expectedChannelHash?: number;
  sortOrder: number;
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
  private sortedChannels: Array<[number, CachedChannel]> = [];
  private enabled: boolean = true;
  private maxDecryptionAttempts: number = 20;
  private lastCacheRefresh: number = 0;
  private refreshPromise: Promise<void> | null = null;
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
      const channels = await databaseService.channelDatabase.getEnabledAsync();
      this.channelCache.clear();

      for (const channel of channels) {
        try {
          // Skip channels without an id (shouldn't happen in practice)
          if (channel.id === undefined) {
            logger.warn(`Channel "${channel.name}": No id, skipping.`);
            continue;
          }

          const rawPskBuffer = Buffer.from(channel.psk, 'base64');

          // Expand shorthand PSK (1-byte keys like AQ==) to full 16-byte key
          const pskBuffer = expandShorthandPsk(rawPskBuffer);
          if (!pskBuffer) {
            logger.warn(
              `Channel "${channel.name}" (id=${channel.id}): PSK indicates no encryption. Skipping.`
            );
            continue;
          }

          // Validate PSK length is valid for AES
          if (pskBuffer.length !== 16 && pskBuffer.length !== 32) {
            logger.warn(
              `Channel "${channel.name}" (id=${channel.id}): Invalid PSK length ${pskBuffer.length}. ` +
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
            enforceNameValidation,
            expectedChannelHash,
            sortOrder: channel.sortOrder ?? 0,
          });
        } catch (err) {
          logger.warn(`Failed to process channel "${channel.name}" (id=${channel.id}):`, err);
        }
      }

      // Pre-sort channels by sortOrder so tryDecrypt() doesn't sort on every packet
      this.sortedChannels = Array.from(this.channelCache.entries())
        .sort(([, a], [, b]) => a.sortOrder - b.sortOrder);

      this.lastCacheRefresh = Date.now();
      logger.debug(`Channel decryption cache refreshed: ${this.channelCache.size} channels loaded`);
    } catch (err) {
      logger.error('Failed to refresh channel decryption cache:', err);
    }
  }

  /**
   * Ensure cache is fresh (lazy refresh).
   * Deduplicates concurrent refresh calls — if a refresh is already in-flight,
   * subsequent callers await the same promise instead of triggering another DB load.
   */
  private async ensureCacheFresh(): Promise<void> {
    if (Date.now() - this.lastCacheRefresh > this.CACHE_TTL_MS) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.refreshChannelCache().finally(() => {
          this.refreshPromise = null;
        });
      }
      await this.refreshPromise;
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
    psk: Buffer
  ): Buffer | null {
    try {
      const algorithm = psk.length === 16 ? 'aes-128-ctr' : 'aes-256-ctr';
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
   * 1. Have a reasonable portnum (field 1, varint) within the Meshtastic range (0-511)
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

      // Check if portnum is in valid Meshtastic range (0-511, where MAX=511)
      const portnum = decoded.portnum ?? 0;
      if (portnum < 0 || portnum > PortNum.MAX) {
        return { valid: false };
      }

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
   * Attempt decryption with a single channel and validate the result.
   * Shared helper used by both tryDecrypt() and tryDecryptWithChannel().
   */
  private attemptDecryptSingleChannel(
    encryptedPayload: Uint8Array,
    nonce: Buffer,
    channel: CachedChannel
  ): DecryptionResult {
    const decrypted = this.tryDecryptWithKey(encryptedPayload, nonce, channel.psk);
    if (!decrypted) {
      return { success: false, error: 'Decryption failed' };
    }

    const validation = this.isValidProtobuf(decrypted);
    if (!validation.valid) {
      return { success: false, error: 'Decrypted data is not valid protobuf' };
    }

    return {
      success: true,
      channelDatabaseId: channel.id,
      channelName: channel.name,
      portnum: validation.portnum,
      payload: validation.payload,
    };
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

    // Use pre-sorted channels (sorted during cache refresh, not per-packet)
    let attempts = 0;
    for (const [, channel] of this.sortedChannels) {
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
        logger.warn(
          `Decryption attempt limit reached (${this.maxDecryptionAttempts}) for packet ${packetId} — ` +
          `${this.channelCache.size - attempts} channels were not tried. ` +
          `Consider increasing maxDecryptionAttempts or enabling name validation on channels.`
        );
        break;
      }
      attempts++;

      const result = this.attemptDecryptSingleChannel(encryptedPayload, nonce, channel);
      if (!result.success) {
        continue;
      }

      // Success! Update the channel's decrypted count
      try {
        await databaseService.channelDatabase.incrementDecryptedCountAsync(channel.id);
      } catch (err) {
        logger.warn(`Failed to update decrypted count for channel ${channel.id}:`, err);
      }

      logger.debug(
        `Server-side decryption successful: packet ${packetId} decrypted with channel "${channel.name}" (portnum=${result.portnum})`
      );

      return result;
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
    if (!this.enabled) {
      return { success: false, error: 'Server-side decryption is disabled' };
    }

    // Ensure cache is fresh
    await this.ensureCacheFresh();

    const channel = this.channelCache.get(channelDatabaseId);
    if (!channel) {
      return { success: false, error: `Channel ${channelDatabaseId} not found or not enabled` };
    }

    const nonce = this.buildNonce(packetId, fromNode);
    return this.attemptDecryptSingleChannel(encryptedPayload, nonce, channel);
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
    return { name: channel.name, pskLength: channel.psk.length };
  }
}

// Export singleton instance
export const channelDecryptionService = new ChannelDecryptionService();
export default channelDecryptionService;

// Export hash functions for testing
export { xorHash, computeChannelHash };
