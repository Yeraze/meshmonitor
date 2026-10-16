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
 *
 * AEAD channels (firmware 2.8.1+, `ChannelSettings.use_aead`, #5248):
 * - AES-CCM (RFC 3610), 12-byte tag, L=2. Payload = ciphertext ‖ tag.
 * - Nonce: the CTR nonce cut to 13 bytes (extraNonce is always 0).
 * - AAD: fromNode (4 bytes LE) ‖ toNode (4 bytes LE).
 * - Channel hash: xorHash(name) ^ xorHash(psk) ^ 0xAE.
 * - No CTR fallback: an AEAD row is only ever tried with CCM, as in firmware.
 * See docs/internal/dev-notes/AEAD_CHANNELS_PLAN.md.
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
  /**
   * Tapback metadata from the decoded `Data` protobuf. `emoji=1` flags
   * the packet as a reaction; `replyId` points at the parent packet id.
   * Callers (mqttIngestion) propagate these so the unified view can group
   * reactions under their parent message — without them, server-decrypted
   * reactions render as full inline messages.
   */
  emoji?: number;
  replyId?: number;
  /**
   * Raw `Data.bitfield` (protobuf field 9). Bit 0 carries the originator's
   * `ok_to_mqtt` preference — see Router.h:177 in the firmware. Undefined
   * when the proto field wasn't set, which firmware treats as "do not
   * uplink". MqttBridgeManager reads this to gate uplink republishing.
   */
  bitfield?: number;
  /**
   * `Data.request_id`: set on a reply, to the id of the packet it answers.
   * mqttIngestion needs it to tell a traceroute reply from a request still in
   * flight, which carries a partial route and must not be stored as a run.
   */
  requestId?: number;
  error?: string;
}

interface CachedChannel {
  id: number;
  name: string;
  psk: Buffer;
  enforceNameValidation: boolean;
  expectedChannelHash?: number;
  /** AES-CCM channel: tried only with CCM, never CTR. */
  useAead: boolean;
  sortOrder: number;
}

/** AES-CCM auth tag length on AEAD channels (firmware `AEAD_TAG_SIZE`). */
const AEAD_TAG_SIZE = 12;
/** XORed into the finished channel hash of an AEAD channel (firmware `Channels.cpp`). */
const AEAD_HASH_XOR = 0xae;

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
function computeChannelHash(name: string, psk: Buffer, useAead: boolean = false): number {
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = xorHash(nameBytes) ^ xorHash(psk);
  return useAead ? hash ^ AEAD_HASH_XOR : hash;
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

          // Always compute the Meshtastic channel hash (xorHash(name) ^
          // xorHash(psk)) — not only when name validation is enforced.
          // tryDecrypt() uses it to *prefer* the channel whose hash matches the
          // packet's channel byte when several channels share a key (e.g.
          // multiple "AQ=="/default-key channels such as "LongFast" plus a
          // custom channel). Without this preference the first same-key channel
          // in sortOrder claims every packet, misattributing nodes/messages to
          // the wrong channel_database row and its permissions. The
          // enforceNameValidation flag still independently controls whether a
          // hash *mismatch* is a hard skip (channel never attempted).
          const enforceNameValidation = channel.enforceNameValidation ?? false;
          const useAead = channel.useAead ?? false;
          const expectedChannelHash = computeChannelHash(channel.name, pskBuffer, useAead);

          this.channelCache.set(channel.id, {
            id: channel.id,
            name: channel.name,
            psk: pskBuffer,
            enforceNameValidation,
            expectedChannelHash,
            useAead,
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
   * AES-CCM decrypt for an AEAD channel. Returns null when the tag does not
   * verify (wrong key, wrong channel, or a tampered packet): a clean miss.
   */
  private tryDecryptCcm(
    payload: Uint8Array,
    ctrNonce: Buffer,
    fromNode: number,
    toNode: number,
    psk: Buffer
  ): Buffer | null {
    if (payload.length <= AEAD_TAG_SIZE) return null;
    try {
      const algorithm = psk.length === 16 ? 'aes-128-ccm' : 'aes-256-ccm';
      const ciphertext = payload.subarray(0, payload.length - AEAD_TAG_SIZE);
      const tag = payload.subarray(payload.length - AEAD_TAG_SIZE);
      const aad = Buffer.alloc(8);
      aad.writeUInt32LE(fromNode >>> 0, 0);
      aad.writeUInt32LE(toNode >>> 0, 4);
      const decipher = createDecipheriv(algorithm, psk, ctrNonce.subarray(0, 13), {
        authTagLength: AEAD_TAG_SIZE,
      });
      decipher.setAuthTag(tag);
      decipher.setAAD(aad, { plaintextLength: ciphertext.length });
      const plaintext = decipher.update(ciphertext);
      decipher.final(); // throws when the tag does not verify
      return plaintext;
    } catch {
      return null;
    }
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
  private isValidProtobuf(data: Buffer): {
    valid: boolean;
    portnum?: number;
    payload?: Uint8Array;
    emoji?: number;
    replyId?: number;
    bitfield?: number;
    requestId?: number;
  } {
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

      // Tapback metadata — surface so callers (mqttIngestion) can group
      // reactions under their parent in the unified view.
      const rawEmoji = decoded.emoji;
      const emoji = typeof rawEmoji === 'number' && rawEmoji > 0 ? rawEmoji : undefined;
      const rawReplyId = decoded.replyId ?? decoded.reply_id;
      const replyId =
        typeof rawReplyId === 'number' && rawReplyId > 0 ? rawReplyId >>> 0 : undefined;

      // Bit 0 of Data.bitfield carries the originator's `ok_to_mqtt`
      // preference. MqttBridgeManager reads this to gate uplink
      // republishing. Undefined when the proto field wasn't set —
      // firmware treats absent as "do not uplink" on public brokers.
      const rawBitfield = decoded.bitfield;
      const bitfield = typeof rawBitfield === 'number' ? rawBitfield >>> 0 : undefined;

      const rawRequestId = decoded.requestId ?? decoded.request_id;
      const requestId =
        typeof rawRequestId === 'number' && rawRequestId > 0 ? rawRequestId >>> 0 : undefined;

      return {
        valid: true,
        portnum: portnum,
        payload: decoded.payload ? new Uint8Array(decoded.payload) : undefined,
        emoji,
        replyId,
        bitfield,
        requestId,
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
    channel: CachedChannel,
    fromNode: number,
    toNode: number | undefined
  ): DecryptionResult {
    let decrypted: Buffer | null;
    if (channel.useAead) {
      // The AAD binds the destination, so without it there is nothing to verify.
      if (toNode === undefined) return { success: false, error: 'AEAD needs the packet destination' };
      decrypted = this.tryDecryptCcm(encryptedPayload, nonce, fromNode, toNode, channel.psk);
    } else {
      decrypted = this.tryDecryptWithKey(encryptedPayload, nonce, channel.psk);
    }
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
      emoji: validation.emoji,
      replyId: validation.replyId,
      bitfield: validation.bitfield,
      requestId: validation.requestId,
    };
  }

  /**
   * Try decryption with all enabled database channels
   *
   * @param encryptedPayload The encrypted packet payload
   * @param packetId The packet's unique ID
   * @param fromNode The sender's node number
   * @param channelHash Optional 8-bit channel hash from packet (meshPacket.channel)
   * @param toNode The packet's destination (`packet.to`). AEAD channels need it
   *   (it is part of the authenticated data); without it they are skipped.
   * @returns DecryptionResult with success status and decoded data if successful
   */
  async tryDecrypt(
    encryptedPayload: Uint8Array,
    packetId: number,
    fromNode: number,
    channelHash?: number,
    toNode?: number
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
    const ordered = this.orderedCandidates(channelHash);

    let attempts = 0;
    for (const channel of ordered) {
      if (attempts >= this.maxDecryptionAttempts) {
        logger.warn(
          `Decryption attempt limit reached (${this.maxDecryptionAttempts}) for packet ${packetId} — ` +
          `${ordered.length - attempts} channels were not tried. ` +
          `Consider increasing maxDecryptionAttempts or enabling name validation on channels.`
        );
        break;
      }
      attempts++;

      const result = this.attemptDecryptSingleChannel(encryptedPayload, nonce, channel, fromNode, toNode);
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

    this.logAeadHint(channelHash);
    return {
      success: false,
      error: `Failed to decrypt with any of ${attempts} channel(s)`,
    };
  }

  /**
   * Debug hint for a packet no key opened: if its hash is a known non-AEAD
   * channel's hash `^ 0xAE`, that channel is probably AEAD upstream. Debug
   * only: an AEAD packet otherwise looks exactly like a wrong key.
   */
  private logAeadHint(channelHash?: number): void {
    if (channelHash === undefined) return;
    for (const [, channel] of this.sortedChannels) {
      if (
        !channel.useAead &&
        channel.expectedChannelHash !== undefined &&
        (channel.expectedChannelHash ^ AEAD_HASH_XOR) === channelHash
      ) {
        logger.debug(
          `Channel "${channel.name}" looks AEAD-enabled upstream (hash 0x${channelHash.toString(16)}); ` +
            `enable AEAD on it in the Channel Database to decrypt`
        );
        return;
      }
    }
  }

  /**
   * Read the portnum of an encrypted packet with the keys already cached,
   * synchronously (#5791). For hot paths that cannot await, such as the MQTT
   * broker's per-subscriber forward hook, which needs the portnum to decide a
   * hop-limit raise.
   *
   * Never refreshes the cache, never counts a decryption against a channel,
   * never logs: the ingest path calls {@link tryDecrypt} for the same packet,
   * which does all three. An empty or stale cache returns null, which callers
   * treat as "portnum unknown", the behaviour before this method existed.
   */
  peekPortnum(
    encryptedPayload: Uint8Array,
    packetId: number,
    fromNode: number,
    channelHash?: number,
    toNode?: number
  ): number | null {
    if (!this.enabled || !encryptedPayload || encryptedPayload.length === 0) return null;
    const nonce = this.buildNonce(packetId, fromNode);
    const ordered = this.orderedCandidates(channelHash).slice(0, this.maxDecryptionAttempts);
    for (const channel of ordered) {
      const result = this.attemptDecryptSingleChannel(encryptedPayload, nonce, channel, fromNode, toNode);
      if (result.success && typeof result.portnum === 'number') return result.portnum;
    }
    return null;
  }

  /**
   * The cached channels to try for a packet, in order. Channels are pre-sorted
   * by sortOrder during cache refresh.
   */
  private orderedCandidates(channelHash?: number): CachedChannel[] {
    // Build the ordered list of channels to try.
    //
    // 1. Hard skip (name validation): when a channel enforces name validation
    //    and the packet carries a channel hash that doesn't match, the channel
    //    is never attempted (and never attributed). Unchanged from before.
    // 2. Hash-aware preference: when the packet carries a channel hash, try the
    //    channels whose computed hash matches it FIRST (preserving sortOrder
    //    within each group), then the rest. This disambiguates channels that
    //    share a key — the correct same-key channel claims the packet instead
    //    of whichever happens to sort first. It is only a *preference*: if no
    //    hash-matching channel decrypts (e.g. a 1-byte hash collision across
    //    different keys, or the real channel isn't in the database), we still
    //    fall back to the others, so decryption is never lost — only
    //    attribution improves. With no channel hash, order is unchanged.
    const candidates: CachedChannel[] = [];
    for (const [, channel] of this.sortedChannels) {
      if (
        channel.enforceNameValidation &&
        channel.expectedChannelHash !== undefined &&
        channelHash !== undefined &&
        channel.expectedChannelHash !== channelHash
      ) {
        continue;
      }
      candidates.push(channel);
    }

    return channelHash === undefined
      ? candidates
      : [
          ...candidates.filter((c) => c.expectedChannelHash === channelHash),
          ...candidates.filter((c) => c.expectedChannelHash !== channelHash),
        ];
  }

  /**
   * Try to decrypt a packet using a specific channel ID
   * (useful for retroactive processing)
   */
  async tryDecryptWithChannel(
    encryptedPayload: Uint8Array,
    packetId: number,
    fromNode: number,
    channelDatabaseId: number,
    toNode?: number
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
    return this.attemptDecryptSingleChannel(encryptedPayload, nonce, channel, fromNode, toNode);
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
export { xorHash, computeChannelHash, AEAD_TAG_SIZE };
