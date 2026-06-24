/**
 * Channel Database Repository
 *
 * Handles all channel database operations for server-side decryption.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, and, asc, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbChannelDatabase, DbChannelDatabasePermission } from '../types.js';
import { logger } from '../../utils/logger.js';
import { expandShorthandPsk } from '../../server/constants/meshtastic.js';

/**
 * Meshtastic 8-bit XOR hash over a byte buffer. Mirrors `xorHash` in
 * channelDecryptionService.ts. Duplicated here (rather than imported) to keep
 * repositories free of a dependency on the server service layer, which would
 * create a circular import (channelDecryptionService → databaseService →
 * repositories).
 */
function xorHashBytes(bytes: Buffer): number {
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) hash ^= bytes[i];
  return hash & 0xff;
}

/**
 * Compute the Meshtastic channel hash from a channel name and its (already
 * expanded) PSK buffer: hash = xorHash(utf8(name)) ^ xorHash(psk).
 */
function computeChannelHashFromName(name: string, psk: Buffer): number {
  return xorHashBytes(Buffer.from(name, 'utf8')) ^ xorHashBytes(psk);
}

/**
 * Channel database data for insert/update operations
 */
export interface ChannelDatabaseInput {
  name: string;
  psk: string; // Base64-encoded PSK
  pskLength: number; // 16 for AES-128, 32 for AES-256
  channelHash?: number | null; // Observed channel hash for passive MQTT rows
  description?: string | null;
  isEnabled?: boolean;
  enforceNameValidation?: boolean;
  createdBy?: number | null;
}

/**
 * Channel database update data
 */
export interface ChannelDatabaseUpdate {
  name?: string;
  psk?: string;
  pskLength?: number;
  description?: string | null;
  isEnabled?: boolean;
  enforceNameValidation?: boolean;
  sortOrder?: number;
}

/**
 * Channel reorder entry
 */
export interface ChannelReorderEntry {
  id: number;
  sortOrder: number;
}

/**
 * Channel database permission input
 */
export interface ChannelDatabasePermissionInput {
  userId: number;
  channelDatabaseId: number;
  canViewOnMap: boolean;
  canRead: boolean;
  grantedBy?: number | null;
}

/**
 * Repository for channel database operations
 */
export class ChannelDatabaseRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * In-flight passive creates keyed by `lower(name)::hash`. MQTT ingest handles
   * packets concurrently, so two packets for the same channel identity can both
   * miss the find SELECT and each INSERT a duplicate row. There is no
   * cross-backend unique index on (name, hash) (a functional/text unique index
   * is awkward across SQLite/PostgreSQL/MySQL), so we serialize creates here —
   * the race is in this single Node process. (Migration 103 merges any
   * duplicates already on disk.)
   */
  private passiveCreateInFlight = new Map<string, Promise<number | null>>();

  // ============ CHANNEL DATABASE METHODS ============

  /**
   * Get a channel database entry by ID
   */
  async getByIdAsync(id: number): Promise<DbChannelDatabase | null> {
    const { channelDatabase } = this.tables;
    const result = await this.db
      .select()
      .from(channelDatabase)
      .where(eq(channelDatabase.id, id))
      .limit(1);

    if (result.length === 0) return null;
    return this.mapToDbChannelDatabase(result[0]);
  }

  /**
   * Get all channel database entries (ordered by sortOrder, then id)
   */
  async getAllAsync(): Promise<DbChannelDatabase[]> {
    const { channelDatabase } = this.tables;
    const results = await this.db
      .select()
      .from(channelDatabase)
      .orderBy(asc(channelDatabase.sortOrder), asc(channelDatabase.id));

    return results.map((r: any) => this.mapToDbChannelDatabase(r));
  }

  /**
   * Look up a channel_database row by its human-readable name. Case-insensitive
   * to mirror the bootstrap path in mqttIngestion.ts which dedups by lowercase
   * name. Returns null if no row matches.
   */
  async getByNameAsync(name: string): Promise<DbChannelDatabase | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const all = await this.getAllAsync();
    const lower = trimmed.toLowerCase();
    return all.find((c) => (c.name ?? '').toLowerCase() === lower) ?? null;
  }

  /**
   * Find-or-create a "passive" channel_database row keyed by name only. Thin
   * back-compat wrapper over {@link findOrCreateByNameAndHashAsync} with a null
   * hash. Callers that have no observed channel hash (e.g. an unencrypted MQTT
   * packet whose broker strips the channel byte) use this; it preserves the
   * historical name-only matching behaviour.
   */
  async findOrCreatePassiveByNameAsync(name: string): Promise<number | null> {
    return this.findOrCreateByNameAndHashAsync(name, null);
  }

  /**
   * Find-or-create a channel_database row keyed by (name, channel hash). The
   * channel hash is the Meshtastic 1-byte XOR hash seen on MQTT packets
   * (`packet.channel`), which equals `xorHash(name) ^ xorHash(psk)`. Using it as
   * a second identity dimension keeps two same-name / different-key channels
   * distinct even when neither can be decrypted server-side.
   *
   * Matching, among rows sharing the same (case-insensitive) name:
   *   1. An ENABLED row whose computed hash (from its name + expanded PSK)
   *      equals `hash` → return it. This is the same, decryptable channel.
   *   2. A PASSIVE row (no PSK) whose stored `channelHash` equals `hash` → return
   *      it. This is the same observed-but-undecryptable channel.
   *   3. If `hash` is null and a passive row with a null `channelHash` exists for
   *      the name → return it (back-compat with name-only registration).
   *   4. Otherwise create a new PASSIVE row (psk='', isEnabled=false) carrying
   *      `channelHash = hash`.
   *
   * Passive rows exist only as targets for channel_database_permissions and
   * never participate in server-side decryption. Enabled (real decryption)
   * rows are never demoted or modified here.
   */
  async findOrCreateByNameAndHashAsync(name: string, hash: number | null): Promise<number | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    // Normalize a missing/zero-ish hash to null so callers can pass undefined/0
    // meaning "no hash observed" without splitting a name-only channel.
    const normalizedHash =
      typeof hash === 'number' && Number.isFinite(hash) && hash > 0 ? Math.trunc(hash) & 0xff : null;

    const matched = await this.matchByNameAndHash(trimmed, normalizedHash);
    if (matched && typeof matched.id === 'number') return matched.id;

    // Serialize concurrent creates for the same (name, hash) identity so two
    // in-flight MQTT packets don't each insert a duplicate passive row.
    const key = `${trimmed.toLowerCase()}::${normalizedHash ?? 'null'}`;
    const inFlight = this.passiveCreateInFlight.get(key);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<number | null> => {
      // Re-check inside the guard: another call may have created the row between
      // our initial find and acquiring the in-flight slot.
      const recheck = await this.matchByNameAndHash(trimmed, normalizedHash);
      if (recheck && typeof recheck.id === 'number') return recheck.id;
      return this.createAsync({
        name: trimmed,
        psk: '',
        pskLength: 0,
        channelHash: normalizedHash,
        isEnabled: false,
        enforceNameValidation: false,
        description: 'Auto-registered for MQTT channel permissions (no PSK)',
        createdBy: null,
      });
    })();
    // Register before the first await above has a chance to clear it.
    this.passiveCreateInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.passiveCreateInFlight.delete(key);
    }
  }

  /**
   * Find an existing channel_database row matching a (name, hash) identity using
   * the priority rules documented on {@link findOrCreateByNameAndHashAsync}.
   * Returns null if nothing matches.
   */
  private async matchByNameAndHash(
    name: string,
    normalizedHash: number | null,
  ): Promise<DbChannelDatabase | null> {
    const lower = name.trim().toLowerCase();
    const all = await this.getAllAsync();
    const sameName = all.filter((c) => (c.name ?? '').toLowerCase() === lower);
    if (sameName.length === 0) return null;

    if (normalizedHash !== null) {
      // 1. Enabled row whose computed hash matches.
      for (const row of sameName) {
        if (!row.isEnabled || !row.psk) continue;
        const computed = this.computeEnabledRowHash(row);
        if (computed !== null && computed === normalizedHash) return row;
      }
      // 2. Passive row with a matching stored hash.
      const passiveMatch = sameName.find(
        (c) => !c.isEnabled && c.channelHash != null && (c.channelHash & 0xff) === normalizedHash,
      );
      if (passiveMatch) return passiveMatch;
      return null;
    }

    // 3. Hash is null: reuse a passive row with a null stored hash (back-compat).
    //    Prefer a passive null-hash row; fall back to any enabled row with the
    //    name so we never mint a duplicate alongside a real decryption entry.
    const passiveNull = sameName.find((c) => !c.isEnabled && (c.channelHash == null));
    if (passiveNull) return passiveNull;
    const enabled = sameName.find((c) => c.isEnabled);
    if (enabled) return enabled;
    return null;
  }

  /**
   * Compute the Meshtastic channel hash for an ENABLED row from its stored name
   * and base64 PSK (shorthand keys like `AQ==` are expanded the same way the
   * decryption service does). Returns null if the PSK can't be expanded.
   */
  private computeEnabledRowHash(row: DbChannelDatabase): number | null {
    try {
      const raw = Buffer.from(row.psk, 'base64');
      const expanded = expandShorthandPsk(raw);
      if (!expanded) return null;
      return computeChannelHashFromName(row.name, expanded);
    } catch {
      return null;
    }
  }

  /**
   * Get all enabled channel database entries (for decryption, ordered by sortOrder)
   */
  async getEnabledAsync(): Promise<DbChannelDatabase[]> {
    const { channelDatabase } = this.tables;
    const results = await this.db
      .select()
      .from(channelDatabase)
      .where(eq(channelDatabase.isEnabled, true))
      .orderBy(asc(channelDatabase.sortOrder), asc(channelDatabase.id));

    return results.map((r: any) => this.mapToDbChannelDatabase(r));
  }

  /**
   * Create a new channel database entry.
   * Keeps branching: MySQL returns insertId differently, SQLite/Postgres use .returning().
   */
  async createAsync(data: ChannelDatabaseInput): Promise<number> {
    const now = this.now();
    const { channelDatabase } = this.tables;
    const values: any = {
      name: data.name,
      psk: data.psk,
      pskLength: data.pskLength,
      channelHash: data.channelHash ?? null,
      description: data.description ?? null,
      isEnabled: data.isEnabled ?? true,
      enforceNameValidation: data.enforceNameValidation ?? false,
      decryptedPacketCount: 0,
      lastDecryptedAt: null,
      createdBy: data.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    };

    if (this.isMySQL()) {
      // MySQL returns insertId from mysql2
      const db = this.getMysqlDb();
      const result = await db.insert(channelDatabase).values(values);
      return Number(result[0].insertId);
    } else {
      // SQLite and PostgreSQL support .returning()
      const result = await (this.db as any)
        .insert(channelDatabase)
        .values(values)
        .returning({ id: channelDatabase.id });

      const insertId = Number(result[0].id);
      logger.debug(`Created channel database entry: ${data.name} (ID: ${insertId})`);
      return insertId;
    }
  }

  /**
   * Update a channel database entry
   */
  async updateAsync(id: number, data: ChannelDatabaseUpdate): Promise<void> {
    const now = this.now();
    const { channelDatabase } = this.tables;

    await this.db
      .update(channelDatabase)
      .set({
        ...data,
        updatedAt: now,
      })
      .where(eq(channelDatabase.id, id));

    logger.debug(`Updated channel database entry ID: ${id}`);
  }

  /**
   * Delete a channel database entry
   */
  async deleteAsync(id: number): Promise<void> {
    const { channelDatabase } = this.tables;
    await this.db.delete(channelDatabase).where(eq(channelDatabase.id, id));
    logger.debug(`Deleted channel database entry ID: ${id}`);
  }

  /**
   * Increment decrypted packet count for a channel
   */
  async incrementDecryptedCountAsync(id: number): Promise<void> {
    const now = this.now();
    const { channelDatabase } = this.tables;
    // Atomic increment — avoids read-then-write race on concurrent decryptions
    await this.db
      .update(channelDatabase)
      .set({
        decryptedPacketCount: sql`${channelDatabase.decryptedPacketCount} + 1`,
        lastDecryptedAt: now,
      } as any)
      .where(eq(channelDatabase.id, id));
  }

  /**
   * Reorder multiple channel database entries
   * Updates the sortOrder for each entry in the provided array
   */
  async reorderAsync(updates: ChannelReorderEntry[]): Promise<void> {
    const now = this.now();
    const { channelDatabase } = this.tables;

    for (const { id, sortOrder } of updates) {
      await this.db
        .update(channelDatabase)
        .set({ sortOrder, updatedAt: now })
        .where(eq(channelDatabase.id, id));
    }

    logger.debug(`Reordered ${updates.length} channel database entries`);
  }

  // ============ PERMISSION METHODS ============

  /**
   * Get permission for a specific user and channel
   */
  async getPermissionAsync(userId: number, channelDatabaseId: number): Promise<DbChannelDatabasePermission | null> {
    const { channelDatabasePermissions } = this.tables;
    const result = await this.db
      .select()
      .from(channelDatabasePermissions)
      .where(
        and(
          eq(channelDatabasePermissions.userId, userId),
          eq(channelDatabasePermissions.channelDatabaseId, channelDatabaseId)
        )
      )
      .limit(1);

    if (result.length === 0) return null;
    return this.mapToDbChannelDatabasePermission(result[0]);
  }

  /**
   * Get all permissions for a user
   */
  async getPermissionsForUserAsync(userId: number): Promise<DbChannelDatabasePermission[]> {
    const { channelDatabasePermissions } = this.tables;
    const results = await this.db
      .select()
      .from(channelDatabasePermissions)
      .where(eq(channelDatabasePermissions.userId, userId));

    return results.map((r: any) => this.mapToDbChannelDatabasePermission(r));
  }

  /**
   * Get all permissions for a channel
   */
  async getPermissionsForChannelAsync(channelDatabaseId: number): Promise<DbChannelDatabasePermission[]> {
    const { channelDatabasePermissions } = this.tables;
    const results = await this.db
      .select()
      .from(channelDatabasePermissions)
      .where(eq(channelDatabasePermissions.channelDatabaseId, channelDatabaseId));

    return results.map((r: any) => this.mapToDbChannelDatabasePermission(r));
  }

  /**
   * Set permission for a user on a channel (upsert)
   */
  async setPermissionAsync(data: ChannelDatabasePermissionInput): Promise<void> {
    const now = this.now();
    const { channelDatabasePermissions } = this.tables;
    const existing = await this.getPermissionAsync(data.userId, data.channelDatabaseId);

    if (existing) {
      // Update existing permission
      await this.db
        .update(channelDatabasePermissions)
        .set({
          canViewOnMap: data.canViewOnMap,
          canRead: data.canRead,
          grantedBy: data.grantedBy ?? existing.grantedBy,
          grantedAt: now,
        })
        .where(eq(channelDatabasePermissions.id, existing.id!));
    } else {
      // Create new permission
      await this.db.insert(channelDatabasePermissions).values({
        userId: data.userId,
        channelDatabaseId: data.channelDatabaseId,
        canViewOnMap: data.canViewOnMap,
        canRead: data.canRead,
        grantedBy: data.grantedBy ?? null,
        grantedAt: now,
      });
    }

    logger.debug(`Set permission for user ${data.userId} on channel_db ${data.channelDatabaseId}: canViewOnMap=${data.canViewOnMap}, canRead=${data.canRead}`);
  }

  /**
   * Delete permission for a user on a channel
   */
  async deletePermissionAsync(userId: number, channelDatabaseId: number): Promise<void> {
    const { channelDatabasePermissions } = this.tables;
    await this.db
      .delete(channelDatabasePermissions)
      .where(
        and(
          eq(channelDatabasePermissions.userId, userId),
          eq(channelDatabasePermissions.channelDatabaseId, channelDatabaseId)
        )
      );

    logger.debug(`Deleted permission for user ${userId} on channel_db ${channelDatabaseId}`);
  }

  // ============ MAPPING HELPERS ============

  /**
   * Unified mapper for all dialects. Uses normalizeBigInts for BigInt->Number
   * and Boolean() for boolean coercion (handles SQLite 0/1 and MySQL tinyint).
   */
  private mapToDbChannelDatabase(row: any): DbChannelDatabase {
    return this.normalizeBigInts({
      id: row.id,
      name: row.name,
      psk: row.psk,
      pskLength: row.pskLength,
      channelHash: row.channelHash ?? null,
      description: row.description,
      isEnabled: Boolean(row.isEnabled),
      enforceNameValidation: Boolean(row.enforceNameValidation),
      sortOrder: row.sortOrder ?? 0,
      decryptedPacketCount: row.decryptedPacketCount,
      lastDecryptedAt: row.lastDecryptedAt ? Number(row.lastDecryptedAt) : null,
      createdBy: row.createdBy,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    });
  }

  private mapToDbChannelDatabasePermission(row: any): DbChannelDatabasePermission {
    return this.normalizeBigInts({
      id: row.id,
      userId: row.userId,
      channelDatabaseId: row.channelDatabaseId,
      canViewOnMap: Boolean(row.canViewOnMap),
      canRead: Boolean(row.canRead),
      grantedBy: row.grantedBy,
      grantedAt: Number(row.grantedAt),
    });
  }
}
