/**
 * Channels Repository
 *
 * Handles all channel-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, and, gt, isNull, or, lt, count } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbChannel } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Channel data for insert/update operations
 */
export interface ChannelInput {
  id: number;
  name: string;
  psk?: string | null;
  role?: number | null;
  uplinkEnabled?: boolean | null;
  downlinkEnabled?: boolean | null;
  positionPrecision?: number | null;
}

/**
 * Repository for channel operations
 */
export class ChannelsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Get a channel by ID
   */
  async getChannelById(id: number): Promise<DbChannel | null> {
    const { channels } = this.tables;
    const result = await this.db
      .select()
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (result.length === 0) return null;

    const channel = result[0];
    if (id === 0) {
      logger.info(`getChannelById(0) - RAW from DB: ${channel ? `name="${channel.name}" (length: ${channel.name?.length || 0})` : 'null'}`);
    }
    return this.normalizeBigInts(channel) as DbChannel;
  }

  /**
   * Get all channels ordered by ID
   */
  async getAllChannels(sourceId?: string): Promise<DbChannel[]> {
    const { channels } = this.tables;
    const result = await this.db
      .select()
      .from(channels)
      .where(this.withSourceScope(channels, sourceId))
      .orderBy(channels.id);

    return this.normalizeBigInts(result) as DbChannel[];
  }

  /**
   * Get the total number of channels
   */
  async getChannelCount(): Promise<number> {
    const { channels } = this.tables;
    const result = await this.db.select({ count: count() }).from(channels);
    return Number(result[0].count);
  }

  /**
   * Insert or update a channel
   * Enforces channel role rules:
   * - Channel 0 must always be PRIMARY (role=1)
   * - Other channels cannot be PRIMARY (will be forced to SECONDARY)
   */
  async upsertChannel(channelData: ChannelInput, sourceId?: string): Promise<void> {
    const now = this.now();
    let data = { ...channelData };
    const { channels } = this.tables;

    // Enforce role rules
    if (data.id === 0 && data.role === 0) {
      logger.warn(`Blocking attempt to set Channel 0 role to DISABLED (0), forcing to PRIMARY (1)`);
      data.role = 1;
    }

    if (data.id > 0 && data.role === 1) {
      logger.warn(`Blocking attempt to set Channel ${data.id} role to PRIMARY (1), forcing to SECONDARY (2)`);
      logger.warn(`Only Channel 0 can be PRIMARY - all other channels must be SECONDARY or DISABLED`);
      data.role = 2;
    }

    logger.info(`upsertChannel called with ID: ${data.id}, name: "${data.name}" (length: ${data.name.length})`);

    // Check if channel exists
    const existingChannel = await this.getChannelById(data.id);
    logger.info(`getChannelById(${data.id}) returned: ${existingChannel ? `"${existingChannel.name}"` : 'null'}`);

    if (existingChannel) {
      // Update existing channel
      // Preserve existing non-empty name if incoming name is empty (fixes #1567)
      // This prevents device reconnections from wiping channel names
      const effectiveName = data.name || existingChannel.name;
      logger.info(`Updating channel ${existingChannel.id}: name "${existingChannel.name}" -> "${effectiveName}" (incoming: "${data.name}")`);

      await this.db
        .update(channels)
        .set({
          name: effectiveName,
          psk: (data.psk !== undefined && data.psk !== '') ? data.psk : existingChannel.psk,
          role: data.role ?? existingChannel.role,
          uplinkEnabled: data.uplinkEnabled ?? existingChannel.uplinkEnabled,
          downlinkEnabled: data.downlinkEnabled ?? existingChannel.downlinkEnabled,
          positionPrecision: data.positionPrecision ?? existingChannel.positionPrecision,
          updatedAt: now,
        })
        .where(eq(channels.id, existingChannel.id));

      logger.info(`Updated channel ${existingChannel.id}`);
    } else {
      // Create new channel
      logger.debug(`Creating new channel with ID: ${data.id}`);

      const newChannel: any = {
        id: data.id,
        name: data.name,
        psk: data.psk ?? null,
        role: data.role ?? null,
        uplinkEnabled: data.uplinkEnabled ?? true,
        downlinkEnabled: data.downlinkEnabled ?? true,
        positionPrecision: data.positionPrecision ?? null,
        createdAt: now,
        updatedAt: now,
      };
      if (sourceId) {
        newChannel.sourceId = sourceId;
      }
      await this.db.insert(channels).values(newChannel);

      logger.debug(`Created channel: ${data.name} (ID: ${data.id})`);
    }
  }

  /**
   * Delete a channel by ID
   */
  async deleteChannel(id: number): Promise<void> {
    const { channels } = this.tables;
    await this.db.delete(channels).where(eq(channels.id, id));
  }

  /**
   * Clean up invalid channels that shouldn't have been created
   * Meshtastic supports channels 0-7 (8 total channels)
   */
  async cleanupInvalidChannels(): Promise<number> {
    const { channels } = this.tables;
    const whereClause = or(lt(channels.id, 0), gt(channels.id, 7));
    const result = await this.db.select({ count: count() }).from(channels).where(whereClause);
    const deleteCount = Number(result[0].count);
    if (deleteCount > 0) {
      await this.db.delete(channels).where(whereClause);
    }
    logger.debug(`Cleaned up ${deleteCount} invalid channels (outside 0-7 range)`);
    return deleteCount;
  }

  /**
   * Clean up channels that appear to be empty/unused
   * Keep channels 0-1 (Primary and typically one active secondary)
   * Remove higher ID channels that have no PSK (not configured)
   */
  async cleanupEmptyChannels(): Promise<number> {
    const { channels } = this.tables;
    const whereClause = and(
      gt(channels.id, 1),
      isNull(channels.psk),
      isNull(channels.role)
    );
    const result = await this.db.select({ count: count() }).from(channels).where(whereClause);
    const deleteCount = Number(result[0].count);
    if (deleteCount > 0) {
      await this.db.delete(channels).where(whereClause);
    }
    logger.debug(`Cleaned up ${deleteCount} empty channels (ID > 1, no PSK/role)`);
    return deleteCount;
  }
}
