/**
 * Channels Repository
 *
 * Handles all channel-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, and, gt, isNull, or, lt } from 'drizzle-orm';
import { channelsSqlite, channelsPostgres, channelsMysql } from '../schema/channels.js';
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
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(channelsSqlite)
        .where(eq(channelsSqlite.id, id))
        .limit(1);

      if (result.length === 0) return null;

      const channel = result[0];
      if (id === 0) {
        logger.info(`getChannelById(0) - RAW from DB: ${channel ? `name="${channel.name}" (length: ${channel.name?.length || 0})` : 'null'}`);
      }
      return this.normalizeBigInts(channel) as DbChannel;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(channelsMysql)
        .where(eq(channelsMysql.id, id))
        .limit(1);

      if (result.length === 0) return null;

      const channel = result[0];
      if (id === 0) {
        logger.info(`getChannelById(0) - RAW from DB: ${channel ? `name="${channel.name}" (length: ${channel.name?.length || 0})` : 'null'}`);
      }
      return channel as DbChannel;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(channelsPostgres)
        .where(eq(channelsPostgres.id, id))
        .limit(1);

      if (result.length === 0) return null;

      const channel = result[0];
      if (id === 0) {
        logger.info(`getChannelById(0) - RAW from DB: ${channel ? `name="${channel.name}" (length: ${channel.name?.length || 0})` : 'null'}`);
      }
      return channel as DbChannel;
    }
  }

  /**
   * Get all channels ordered by ID
   */
  async getAllChannels(): Promise<DbChannel[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const channels = await db
        .select()
        .from(channelsSqlite)
        .orderBy(channelsSqlite.id);

      return channels.map(c => this.normalizeBigInts(c) as DbChannel);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const channels = await db
        .select()
        .from(channelsMysql)
        .orderBy(channelsMysql.id);

      return channels as DbChannel[];
    } else {
      const db = this.getPostgresDb();
      const channels = await db
        .select()
        .from(channelsPostgres)
        .orderBy(channelsPostgres.id);

      return channels as DbChannel[];
    }
  }

  /**
   * Get the total number of channels
   */
  async getChannelCount(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(channelsSqlite);
      return result.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(channelsMysql);
      return result.length;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(channelsPostgres);
      return result.length;
    }
  }

  /**
   * Insert or update a channel
   * Enforces channel role rules:
   * - Channel 0 must always be PRIMARY (role=1)
   * - Other channels cannot be PRIMARY (will be forced to SECONDARY)
   */
  async upsertChannel(channelData: ChannelInput): Promise<void> {
    const now = this.now();
    let data = { ...channelData };

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
      logger.info(`Updating channel ${existingChannel.id} from "${existingChannel.name}" to "${data.name}"`);

      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        await db
          .update(channelsSqlite)
          .set({
            name: data.name,
            psk: data.psk ?? existingChannel.psk,
            role: data.role ?? existingChannel.role,
            uplinkEnabled: data.uplinkEnabled ?? existingChannel.uplinkEnabled,
            downlinkEnabled: data.downlinkEnabled ?? existingChannel.downlinkEnabled,
            positionPrecision: data.positionPrecision ?? existingChannel.positionPrecision,
            updatedAt: now,
          })
          .where(eq(channelsSqlite.id, existingChannel.id));
      } else if (this.isMySQL()) {
        const db = this.getMysqlDb();
        await db
          .update(channelsMysql)
          .set({
            name: data.name,
            psk: data.psk ?? existingChannel.psk,
            role: data.role ?? existingChannel.role,
            uplinkEnabled: data.uplinkEnabled ?? existingChannel.uplinkEnabled,
            downlinkEnabled: data.downlinkEnabled ?? existingChannel.downlinkEnabled,
            positionPrecision: data.positionPrecision ?? existingChannel.positionPrecision,
            updatedAt: now,
          })
          .where(eq(channelsMysql.id, existingChannel.id));
      } else {
        const db = this.getPostgresDb();
        await db
          .update(channelsPostgres)
          .set({
            name: data.name,
            psk: data.psk ?? existingChannel.psk,
            role: data.role ?? existingChannel.role,
            uplinkEnabled: data.uplinkEnabled ?? existingChannel.uplinkEnabled,
            downlinkEnabled: data.downlinkEnabled ?? existingChannel.downlinkEnabled,
            positionPrecision: data.positionPrecision ?? existingChannel.positionPrecision,
            updatedAt: now,
          })
          .where(eq(channelsPostgres.id, existingChannel.id));
      }

      logger.info(`Updated channel ${existingChannel.id}`);
    } else {
      // Create new channel
      logger.debug(`Creating new channel with ID: ${data.id}`);

      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        await db.insert(channelsSqlite).values({
          id: data.id,
          name: data.name,
          psk: data.psk ?? null,
          role: data.role ?? null,
          uplinkEnabled: data.uplinkEnabled ?? true,
          downlinkEnabled: data.downlinkEnabled ?? true,
          positionPrecision: data.positionPrecision ?? null,
          createdAt: now,
          updatedAt: now,
        });
      } else if (this.isMySQL()) {
        const db = this.getMysqlDb();
        await db.insert(channelsMysql).values({
          id: data.id,
          name: data.name,
          psk: data.psk ?? null,
          role: data.role ?? null,
          uplinkEnabled: data.uplinkEnabled ?? true,
          downlinkEnabled: data.downlinkEnabled ?? true,
          positionPrecision: data.positionPrecision ?? null,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        const db = this.getPostgresDb();
        await db.insert(channelsPostgres).values({
          id: data.id,
          name: data.name,
          psk: data.psk ?? null,
          role: data.role ?? null,
          uplinkEnabled: data.uplinkEnabled ?? true,
          downlinkEnabled: data.downlinkEnabled ?? true,
          positionPrecision: data.positionPrecision ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }

      logger.debug(`Created channel: ${data.name} (ID: ${data.id})`);
    }
  }

  /**
   * Delete a channel by ID
   */
  async deleteChannel(id: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(channelsSqlite).where(eq(channelsSqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(channelsMysql).where(eq(channelsMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db.delete(channelsPostgres).where(eq(channelsPostgres.id, id));
    }
  }

  /**
   * Clean up invalid channels that shouldn't have been created
   * Meshtastic supports channels 0-7 (8 total channels)
   */
  async cleanupInvalidChannels(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: channelsSqlite.id })
        .from(channelsSqlite)
        .where(or(lt(channelsSqlite.id, 0), gt(channelsSqlite.id, 7)));

      for (const channel of toDelete) {
        await db.delete(channelsSqlite).where(eq(channelsSqlite.id, channel.id));
      }

      logger.debug(`Cleaned up ${toDelete.length} invalid channels (outside 0-7 range)`);
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: channelsMysql.id })
        .from(channelsMysql)
        .where(or(lt(channelsMysql.id, 0), gt(channelsMysql.id, 7)));

      for (const channel of toDelete) {
        await db.delete(channelsMysql).where(eq(channelsMysql.id, channel.id));
      }

      logger.debug(`Cleaned up ${toDelete.length} invalid channels (outside 0-7 range)`);
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: channelsPostgres.id })
        .from(channelsPostgres)
        .where(or(lt(channelsPostgres.id, 0), gt(channelsPostgres.id, 7)));

      for (const channel of toDelete) {
        await db.delete(channelsPostgres).where(eq(channelsPostgres.id, channel.id));
      }

      logger.debug(`Cleaned up ${toDelete.length} invalid channels (outside 0-7 range)`);
      return toDelete.length;
    }
  }

  /**
   * Clean up channels that appear to be empty/unused
   * Keep channels 0-1 (Primary and typically one active secondary)
   * Remove higher ID channels that have no PSK (not configured)
   */
  async cleanupEmptyChannels(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: channelsSqlite.id })
        .from(channelsSqlite)
        .where(
          and(
            gt(channelsSqlite.id, 1),
            isNull(channelsSqlite.psk),
            isNull(channelsSqlite.role)
          )
        );

      for (const channel of toDelete) {
        await db.delete(channelsSqlite).where(eq(channelsSqlite.id, channel.id));
      }

      logger.debug(`Cleaned up ${toDelete.length} empty channels (ID > 1, no PSK/role)`);
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: channelsMysql.id })
        .from(channelsMysql)
        .where(
          and(
            gt(channelsMysql.id, 1),
            isNull(channelsMysql.psk),
            isNull(channelsMysql.role)
          )
        );

      for (const channel of toDelete) {
        await db.delete(channelsMysql).where(eq(channelsMysql.id, channel.id));
      }

      logger.debug(`Cleaned up ${toDelete.length} empty channels (ID > 1, no PSK/role)`);
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: channelsPostgres.id })
        .from(channelsPostgres)
        .where(
          and(
            gt(channelsPostgres.id, 1),
            isNull(channelsPostgres.psk),
            isNull(channelsPostgres.role)
          )
        );

      for (const channel of toDelete) {
        await db.delete(channelsPostgres).where(eq(channelsPostgres.id, channel.id));
      }

      logger.debug(`Cleaned up ${toDelete.length} empty channels (ID > 1, no PSK/role)`);
      return toDelete.length;
    }
  }
}
