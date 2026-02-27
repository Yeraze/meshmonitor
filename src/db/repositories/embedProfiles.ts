/**
 * Embed Profiles Repository
 *
 * Handles all embed_profiles-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq } from 'drizzle-orm';
import {
  embedProfilesSqlite,
  embedProfilesPostgres,
  embedProfilesMysql,
} from '../schema/embedProfiles.js';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

/**
 * Deserialized embed profile (JSON fields are arrays, booleans are proper bools)
 */
export interface EmbedProfile {
  id: string;
  name: string;
  enabled: boolean;
  channels: number[];
  tileset: string;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
  showTooltips: boolean;
  showPopups: boolean;
  showLegend: boolean;
  showPaths: boolean;
  showNeighborInfo: boolean;
  showMqttNodes: boolean;
  pollIntervalSeconds: number;
  allowedOrigins: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Input type for creating/updating embed profiles (omits timestamps)
 */
export type EmbedProfileInput = Omit<EmbedProfile, 'createdAt' | 'updatedAt'>;

/**
 * Deserialize a raw database row into an EmbedProfile
 */
function deserializeRow(row: any): EmbedProfile {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    channels: typeof row.channels === 'string' ? JSON.parse(row.channels) : row.channels,
    tileset: row.tileset,
    defaultLat: Number(row.defaultLat),
    defaultLng: Number(row.defaultLng),
    defaultZoom: Number(row.defaultZoom),
    showTooltips: Boolean(row.showTooltips),
    showPopups: Boolean(row.showPopups),
    showLegend: Boolean(row.showLegend),
    showPaths: Boolean(row.showPaths),
    showNeighborInfo: Boolean(row.showNeighborInfo),
    showMqttNodes: Boolean(row.showMqttNodes),
    pollIntervalSeconds: Number(row.pollIntervalSeconds),
    allowedOrigins: typeof row.allowedOrigins === 'string' ? JSON.parse(row.allowedOrigins) : row.allowedOrigins,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

/**
 * Repository for embed profile operations
 */
export class EmbedProfileRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Get all embed profiles
   */
  async getAllAsync(): Promise<EmbedProfile[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const rows = await db.select().from(embedProfilesSqlite);
      return rows.map(deserializeRow);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const rows = await db.select().from(embedProfilesMysql);
      return rows.map(deserializeRow);
    } else {
      const db = this.getPostgresDb();
      const rows = await db.select().from(embedProfilesPostgres);
      return rows.map(deserializeRow);
    }
  }

  /**
   * Get a single embed profile by ID
   */
  async getByIdAsync(id: string): Promise<EmbedProfile | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const rows = await db
        .select()
        .from(embedProfilesSqlite)
        .where(eq(embedProfilesSqlite.id, id))
        .limit(1);
      return rows.length > 0 ? deserializeRow(rows[0]) : null;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const rows = await db
        .select()
        .from(embedProfilesMysql)
        .where(eq(embedProfilesMysql.id, id))
        .limit(1);
      return rows.length > 0 ? deserializeRow(rows[0]) : null;
    } else {
      const db = this.getPostgresDb();
      const rows = await db
        .select()
        .from(embedProfilesPostgres)
        .where(eq(embedProfilesPostgres.id, id))
        .limit(1);
      return rows.length > 0 ? deserializeRow(rows[0]) : null;
    }
  }

  /**
   * Create a new embed profile
   */
  async createAsync(input: EmbedProfileInput): Promise<EmbedProfile> {
    const now = this.now();
    const values = {
      id: input.id,
      name: input.name,
      enabled: input.enabled,
      channels: JSON.stringify(input.channels),
      tileset: input.tileset,
      defaultLat: input.defaultLat,
      defaultLng: input.defaultLng,
      defaultZoom: input.defaultZoom,
      showTooltips: input.showTooltips,
      showPopups: input.showPopups,
      showLegend: input.showLegend,
      showPaths: input.showPaths,
      showNeighborInfo: input.showNeighborInfo,
      showMqttNodes: input.showMqttNodes,
      pollIntervalSeconds: input.pollIntervalSeconds,
      allowedOrigins: JSON.stringify(input.allowedOrigins),
      createdAt: now,
      updatedAt: now,
    };

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.insert(embedProfilesSqlite).values(values);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.insert(embedProfilesMysql).values(values);
    } else {
      const db = this.getPostgresDb();
      await db.insert(embedProfilesPostgres).values(values);
    }

    return deserializeRow({ ...values, channels: values.channels, allowedOrigins: values.allowedOrigins });
  }

  /**
   * Update an embed profile by ID
   */
  async updateAsync(id: string, input: Partial<EmbedProfileInput>): Promise<EmbedProfile | null> {
    const now = this.now();
    const updateValues: Record<string, any> = { updatedAt: now };

    if (input.name !== undefined) updateValues.name = input.name;
    if (input.enabled !== undefined) updateValues.enabled = input.enabled;
    if (input.channels !== undefined) updateValues.channels = JSON.stringify(input.channels);
    if (input.tileset !== undefined) updateValues.tileset = input.tileset;
    if (input.defaultLat !== undefined) updateValues.defaultLat = input.defaultLat;
    if (input.defaultLng !== undefined) updateValues.defaultLng = input.defaultLng;
    if (input.defaultZoom !== undefined) updateValues.defaultZoom = input.defaultZoom;
    if (input.showTooltips !== undefined) updateValues.showTooltips = input.showTooltips;
    if (input.showPopups !== undefined) updateValues.showPopups = input.showPopups;
    if (input.showLegend !== undefined) updateValues.showLegend = input.showLegend;
    if (input.showPaths !== undefined) updateValues.showPaths = input.showPaths;
    if (input.showNeighborInfo !== undefined) updateValues.showNeighborInfo = input.showNeighborInfo;
    if (input.showMqttNodes !== undefined) updateValues.showMqttNodes = input.showMqttNodes;
    if (input.pollIntervalSeconds !== undefined) updateValues.pollIntervalSeconds = input.pollIntervalSeconds;
    if (input.allowedOrigins !== undefined) updateValues.allowedOrigins = JSON.stringify(input.allowedOrigins);

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.update(embedProfilesSqlite).set(updateValues).where(eq(embedProfilesSqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.update(embedProfilesMysql).set(updateValues).where(eq(embedProfilesMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db.update(embedProfilesPostgres).set(updateValues).where(eq(embedProfilesPostgres.id, id));
    }

    return this.getByIdAsync(id);
  }

  /**
   * Delete an embed profile by ID
   */
  async deleteAsync(id: string): Promise<boolean> {
    // Check if the profile exists first
    const existing = await this.getByIdAsync(id);
    if (!existing) return false;

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(embedProfilesSqlite).where(eq(embedProfilesSqlite.id, id));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(embedProfilesMysql).where(eq(embedProfilesMysql.id, id));
    } else {
      const db = this.getPostgresDb();
      await db.delete(embedProfilesPostgres).where(eq(embedProfilesPostgres.id, id));
    }

    return true;
  }
}
