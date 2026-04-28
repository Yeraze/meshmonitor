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
   * Get a channel by slot number, optionally scoped to a source.
   * When sourceId is provided, only returns the channel belonging to that source.
   * Without sourceId, returns the first matching row (legacy single-source behaviour).
   */
  async getChannelById(id: number, sourceId?: string): Promise<DbChannel | null> {
    const { channels } = this.tables;

    const whereClause = sourceId
      ? and(eq(channels.id, id), eq(channels.sourceId, sourceId))
      : eq(channels.id, id);

    const result = await this.db
      .select()
      .from(channels)
      .where(whereClause)
      .limit(1);

    if (result.length === 0) return null;

    const channel = result[0];
    return this.normalizeBigInts(channel) as DbChannel;
  }

  /**
   * Get all channels ordered by ID, optionally scoped to a source.
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
   * Get the total number of channels, optionally scoped to a source.
   */
  async getChannelCount(sourceId?: string): Promise<number> {
    const { channels } = this.tables;
    const whereClause = this.withSourceScope(channels, sourceId);
    const result = whereClause
      ? await this.db.select({ count: count() }).from(channels).where(whereClause)
      : await this.db.select({ count: count() }).from(channels);
    return Number(result[0].count);
  }

  /**
   * Insert or update a channel.
   * Enforces channel role rules:
   * - Channel 0 must always be PRIMARY (role=1)
   * - Other channels cannot be PRIMARY (will be forced to SECONDARY)
   *
   * When sourceId is provided the lookup uses (id, sourceId) so each source
   * manages its own independent set of channel slots.
   *
   * `opts.allowBlankName` distinguishes user-driven saves (where blank truly
   * means "clear the name") from device-config ingest (where blank typically
   * means "the device transmitted an empty name slot, don't wipe what we
   * already had" — see #1567). The PUT /api/channels/:id route should pass
   * `true`; the channel-info ingest path should pass `false`/omit.
   */
  async upsertChannel(
    channelData: ChannelInput,
    sourceId?: string,
    opts?: { allowBlankName?: boolean },
  ): Promise<void> {
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

    logger.debug(`upsertChannel called with ID: ${data.id}, name: "${data.name}"`);

    // Look up existing channel using composite key when sourceId is available
    const existingChannel = await this.getChannelById(data.id, sourceId);

    if (existingChannel) {
      // Update existing channel
      // For ingest paths: preserve existing non-empty name when incoming name
      // is blank (fixes #1567 — device reconnects sometimes report empty names
      // for slots whose names we already learned).
      // For user-driven saves (`opts.allowBlankName`): blank means blank.
      const incomingName = data.name ?? '';
      const effectiveName = (opts?.allowBlankName || incomingName !== '')
        ? incomingName
        : existingChannel.name;
      logger.debug(`Updating channel ${existingChannel.id}: name "${existingChannel.name}" -> "${effectiveName}"`);

      const updateSet: any = {
        name: effectiveName,
        psk: (data.psk !== undefined && data.psk !== '') ? data.psk : existingChannel.psk,
        role: data.role ?? existingChannel.role,
        uplinkEnabled: data.uplinkEnabled ?? existingChannel.uplinkEnabled,
        downlinkEnabled: data.downlinkEnabled ?? existingChannel.downlinkEnabled,
        positionPrecision: data.positionPrecision ?? existingChannel.positionPrecision,
        updatedAt: now,
      };
      // Stamp sourceId on existing rows that were created without it (legacy migration)
      if (sourceId && !(existingChannel as any).sourceId) {
        updateSet.sourceId = sourceId;
      }

      // Update by pk (surrogate PK) so we target exactly this source's row
      const existingPk = (existingChannel as any).pk;
      if (existingPk !== undefined) {
        await this.db
          .update(channels)
          .set(updateSet)
          .where(eq((channels as any).pk, existingPk));
      } else {
        // Fallback: update by (id, sourceId) if pk not present (pre-migration safety)
        const updateWhere = sourceId
          ? and(eq(channels.id, existingChannel.id), eq(channels.sourceId, sourceId))
          : eq(channels.id, existingChannel.id);
        await this.db.update(channels).set(updateSet).where(updateWhere);
      }

      logger.debug(`Updated channel ${existingChannel.id}`);
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
   * Delete a channel by slot ID, optionally scoped to a source.
   */
  async deleteChannel(id: number, sourceId?: string): Promise<void> {
    const { channels } = this.tables;
    const whereClause = sourceId
      ? and(eq(channels.id, id), eq(channels.sourceId, sourceId))
      : eq(channels.id, id);
    await this.db.delete(channels).where(whereClause);
  }

  /**
   * Clean up channels scoped to a source that have no name and no psk.
   * Used by `cleanupInvalidChannelsAsync(sourceId)` — narrower semantics than
   * `cleanupInvalidChannels()` (which uses id range 0–7).
   */
  async cleanupEmptyChannelsForSource(sourceId: string): Promise<number> {
    const { channels } = this.tables;
    const whereClause = and(
      or(isNull(channels.name), eq(channels.name, '')),
      or(isNull(channels.psk), eq(channels.psk, '')),
      eq(channels.sourceId, sourceId)
    );
    const countRows = await this.db
      .select({ count: count() })
      .from(channels)
      .where(whereClause);
    const deleteCount = Number(countRows[0].count);
    if (deleteCount > 0) {
      await this.db.delete(channels).where(whereClause);
    }
    return deleteCount;
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

  // ========== SYNC METHODS (SQLite only) ==========
  // Used by legacy sync callers of DatabaseService. Throws on PG/MySQL.

  /**
   * Synchronously get a channel by id (SQLite only).
   */
  getChannelByIdSync(id: number): DbChannel | null {
    const db = this.getSqliteDb();
    const { channels } = this.tables;
    const rows = db
      .select()
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1)
      .all();
    if (rows.length === 0) return null;
    return this.normalizeBigInts(rows[0]) as DbChannel;
  }

  /**
   * Synchronously get all channels (SQLite only).
   */
  getAllChannelsSync(): DbChannel[] {
    const db = this.getSqliteDb();
    const { channels } = this.tables;
    const rows = db
      .select()
      .from(channels)
      .orderBy(channels.id)
      .all();
    return (rows as any[]).map((row) => this.normalizeBigInts(row)) as DbChannel[];
  }

  /**
   * Synchronously count channels (SQLite only).
   */
  getChannelCountSync(): number {
    const db = this.getSqliteDb();
    const { channels } = this.tables;
    const rows = db.select({ count: count() }).from(channels).all();
    return Number((rows[0] as any).count);
  }

  /**
   * Synchronously upsert a channel (SQLite only).
   * Matches the legacy DatabaseService.upsertChannel semantics:
   * - Does NOT preserve non-empty names across updates (overwrites with incoming)
   * - Uses COALESCE-like behavior for nullable fields
   * - Role rules already validated at call site
   */
  upsertChannelSync(channelData: ChannelInput): void {
    const db = this.getSqliteDb();
    const { channels } = this.tables;
    const now = this.now();

    // Look up existing row by id
    const existingRows = db
      .select()
      .from(channels)
      .where(eq(channels.id, channelData.id))
      .limit(1)
      .all();
    const existing = existingRows.length > 0 ? (existingRows[0] as any) : null;

    if (existing) {
      // Update existing — COALESCE(new, old) semantics for nullable fields
      const updateSet: any = {
        name: channelData.name,
        psk: channelData.psk ?? existing.psk,
        role: channelData.role ?? existing.role,
        uplinkEnabled: channelData.uplinkEnabled ?? existing.uplinkEnabled,
        downlinkEnabled: channelData.downlinkEnabled ?? existing.downlinkEnabled,
        positionPrecision: channelData.positionPrecision ?? existing.positionPrecision,
        updatedAt: now,
      };
      db.update(channels).set(updateSet).where(eq(channels.id, existing.id)).run();
      logger.info(`Updated channel ${existing.id} (sync)`);
    } else {
      // Insert new row
      const newRow: any = {
        id: channelData.id,
        name: channelData.name,
        psk: channelData.psk ?? null,
        role: channelData.role ?? null,
        uplinkEnabled: channelData.uplinkEnabled ?? true,
        downlinkEnabled: channelData.downlinkEnabled ?? true,
        positionPrecision: channelData.positionPrecision ?? null,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(channels).values(newRow).run();
      logger.debug(`Created channel: ${channelData.name} (ID: ${channelData.id}) (sync)`);
    }
  }

  /**
   * Synchronously delete invalid channels (id < 0 or id > 7). (SQLite only).
   * Returns the number of rows deleted.
   */
  cleanupInvalidChannelsSync(): number {
    const db = this.getSqliteDb();
    const { channels } = this.tables;
    const whereClause = or(lt(channels.id, 0), gt(channels.id, 7));
    const countRows = db.select({ count: count() }).from(channels).where(whereClause).all();
    const deleteCount = Number((countRows[0] as any).count);
    if (deleteCount > 0) {
      db.delete(channels).where(whereClause).run();
    }
    logger.debug(`Cleaned up ${deleteCount} invalid channels (sync)`);
    return deleteCount;
  }

  /**
   * Synchronously delete empty channels (id > 1, no PSK, no role). (SQLite only).
   * Returns the number of rows deleted.
   */
  cleanupEmptyChannelsSync(): number {
    const db = this.getSqliteDb();
    const { channels } = this.tables;
    const whereClause = and(
      gt(channels.id, 1),
      isNull(channels.psk),
      isNull(channels.role)
    );
    const countRows = db.select({ count: count() }).from(channels).where(whereClause).all();
    const deleteCount = Number((countRows[0] as any).count);
    if (deleteCount > 0) {
      db.delete(channels).where(whereClause).run();
    }
    logger.debug(`Cleaned up ${deleteCount} empty channels (sync)`);
    return deleteCount;
  }
}
