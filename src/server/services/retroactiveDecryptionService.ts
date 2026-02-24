/**
 * Retroactive Decryption Service
 *
 * Processes historical encrypted packets when a new channel is added to the database.
 * This allows decryption of past messages that were stored but couldn't be decrypted
 * at the time they were received.
 */
import databaseService from '../../services/database.js';
import { channelDecryptionService } from './channelDecryptionService.js';
import { logger } from '../../utils/logger.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import { DEFAULT_RETROACTIVE_BATCH_SIZE } from '../constants/meshtastic.js';
import { getEnvironmentConfig } from '../config/environment.js';

// Get batch size from environment or use default
const getBatchSize = (): number => {
  const env = getEnvironmentConfig();
  const envBatchSize = (env as any).retroactiveDecryptionBatchSize;
  if (envBatchSize && !isNaN(Number(envBatchSize))) {
    return Number(envBatchSize);
  }
  return DEFAULT_RETROACTIVE_BATCH_SIZE;
};

export interface ProcessingProgress {
  channelDatabaseId: number;
  channelName: string;
  total: number;
  processed: number;
  decrypted: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

class RetroactiveDecryptionService {
  private currentProgress: ProcessingProgress | null = null;
  private isProcessing: boolean = false;

  /**
   * Get current processing progress
   */
  getProgress(): ProcessingProgress | null {
    return this.currentProgress;
  }

  /**
   * Check if currently processing
   */
  isRunning(): boolean {
    return this.isProcessing;
  }

  /**
   * Process encrypted packets for a newly added channel
   *
   * @param channelDatabaseId The ID of the channel database entry
   * @returns ProcessingProgress with final stats
   */
  async processForChannel(channelDatabaseId: number): Promise<ProcessingProgress> {
    if (this.isProcessing) {
      throw new Error('Already processing a channel. Wait for completion before starting another.');
    }

    // Get channel info
    const channelInfo = await channelDecryptionService.getChannelInfo(channelDatabaseId);
    if (!channelInfo) {
      throw new Error(`Channel ${channelDatabaseId} not found or not enabled`);
    }

    this.isProcessing = true;
    this.currentProgress = {
      channelDatabaseId,
      channelName: channelInfo.name,
      total: 0,
      processed: 0,
      decrypted: 0,
      status: 'pending',
      startedAt: Date.now(),
    };

    try {
      // Get all encrypted packets that haven't been decrypted yet
      // These packets have encrypted_payload in their metadata
      const encryptedPackets = await this.getEncryptedPackets();

      this.currentProgress.total = encryptedPackets.length;
      this.currentProgress.status = 'running';

      logger.info(
        `Starting retroactive decryption for channel "${channelInfo.name}": ${encryptedPackets.length} encrypted packets to process`
      );

      // Emit progress event
      this.emitProgress();

      // Process in batches to avoid blocking
      const BATCH_SIZE = 100;
      for (let i = 0; i < encryptedPackets.length; i += BATCH_SIZE) {
        const batch = encryptedPackets.slice(i, i + BATCH_SIZE);

        for (const packet of batch) {
          await this.processPacket(packet, channelDatabaseId);
          this.currentProgress.processed++;

          // Emit progress every 10 packets
          if (this.currentProgress.processed % 10 === 0) {
            this.emitProgress();
          }
        }

        // Yield to event loop between batches
        await new Promise(resolve => setImmediate(resolve));
      }

      this.currentProgress.status = 'completed';
      this.currentProgress.completedAt = Date.now();

      logger.info(
        `Retroactive decryption completed for channel "${channelInfo.name}": ` +
          `${this.currentProgress.decrypted}/${this.currentProgress.total} packets decrypted`
      );

      this.emitProgress();
      return this.currentProgress;
    } catch (err) {
      this.currentProgress.status = 'failed';
      this.currentProgress.error = err instanceof Error ? err.message : String(err);
      this.currentProgress.completedAt = Date.now();

      logger.error(`Retroactive decryption failed for channel "${channelInfo.name}":`, err);
      this.emitProgress();
      return this.currentProgress;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get encrypted packets that haven't been decrypted yet
   */
  private async getEncryptedPackets(): Promise<EncryptedPacketInfo[]> {
    // Get encrypted packets from the packet log
    const batchSize = getBatchSize();
    const packets = await databaseService.getPacketLogsAsync({
      encrypted: true,
      limit: batchSize,
    });

    // Filter to only those that have encrypted_payload in metadata and no decrypted_by
    const result: EncryptedPacketInfo[] = [];

    for (const packet of packets) {
      // Skip already decrypted packets
      if (packet.decrypted_by) {
        continue;
      }

      // Parse metadata to get encrypted_payload
      if (!packet.metadata) {
        continue;
      }

      try {
        const metadata = JSON.parse(packet.metadata);
        if (!metadata.encrypted_payload) {
          continue;
        }

        // Convert hex string back to Uint8Array
        const encryptedPayload = Buffer.from(metadata.encrypted_payload, 'hex');

        result.push({
          id: packet.id ?? 0,
          packetId: metadata.id ?? packet.packet_id ?? 0,
          fromNode: packet.from_node,
          encryptedPayload: new Uint8Array(encryptedPayload),
          metadata,
        });
      } catch (_err) {
        // Skip packets with invalid metadata
        continue;
      }
    }

    return result;
  }

  /**
   * Process a single encrypted packet
   */
  private async processPacket(
    packet: EncryptedPacketInfo,
    channelDatabaseId: number
  ): Promise<boolean> {
    try {
      const result = await channelDecryptionService.tryDecryptWithChannel(
        packet.encryptedPayload,
        packet.packetId,
        packet.fromNode,
        channelDatabaseId
      );

      if (!result.success) {
        logger.debug(
          `Retroactive decrypt failed for packet ${packet.id}: packetId=${packet.packetId}, fromNode=${packet.fromNode}, error=${result.error}`
        );
        return false;
      }

      // Update the packet log with decryption info
      await this.updatePacketLog(packet.id, result, packet.metadata);

      this.currentProgress!.decrypted++;
      return true;
    } catch (err) {
      logger.debug(`Failed to process packet ${packet.id} for retroactive decryption:`, err);
      return false;
    }
  }

  /**
   * Update the packet log entry with decryption results
   */
  private async updatePacketLog(
    packetLogId: number,
    decryptionResult: {
      channelDatabaseId?: number;
      portnum?: number;
      payload?: Uint8Array;
    },
    originalMetadata: Record<string, unknown>
  ): Promise<void> {
    // Update metadata with decoded info
    const updatedMetadata: Record<string, unknown> = {
      ...originalMetadata,
      retroactively_decrypted: true,
      decrypted_portnum: decryptionResult.portnum,
    };

    // Remove the encrypted_payload from metadata since we've decrypted it
    delete updatedMetadata.encrypted_payload;

    // Update the packet log entry
    await databaseService.updatePacketLogDecryptionAsync(
      packetLogId,
      'server',
      decryptionResult.channelDatabaseId ?? null,
      decryptionResult.portnum ?? 0,
      JSON.stringify(updatedMetadata)
    );
  }

  /**
   * Emit progress event via WebSocket
   */
  private emitProgress(): void {
    if (this.currentProgress) {
      dataEventEmitter.emit('retroactiveDecryptionProgress', this.currentProgress);
    }
  }

  /**
   * Process for all enabled channels (useful when adding multiple new packets)
   */
  async processForAllChannels(): Promise<ProcessingProgress[]> {
    const channelIds = await channelDecryptionService.getEnabledChannelIds();
    const results: ProcessingProgress[] = [];

    for (const channelId of channelIds) {
      try {
        const result = await this.processForChannel(channelId);
        results.push(result);
      } catch (err) {
        logger.warn(`Failed to process retroactive decryption for channel ${channelId}:`, err);
      }
    }

    return results;
  }
}

interface EncryptedPacketInfo {
  id: number;
  packetId: number;
  fromNode: number;
  encryptedPayload: Uint8Array;
  metadata: Record<string, unknown>;
}

// Export singleton instance
export const retroactiveDecryptionService = new RetroactiveDecryptionService();
export default retroactiveDecryptionService;
