/**
 * Embed Profiles Repository
 *
 * Handles all embed_profiles-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq } from 'drizzle-orm';
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
  showTraceroutes: boolean;
  showMqttNodes: boolean;
  pollIntervalSeconds: number;
  allowedOrigins: string[];
  sourceId: string | null;
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
    showTraceroutes: Boolean(row.showTraceroutes),
    showMqttNodes: Boolean(row.showMqttNodes),
    pollIntervalSeconds: Number(row.pollIntervalSeconds),
    allowedOrigins: typeof row.allowedOrigins === 'string' ? JSON.parse(row.allowedOrigins) : row.allowedOrigins,
    sourceId: row.sourceId ?? null,
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
    const { embedProfiles } = this.tables;
    const rows = await this.db.select().from(embedProfiles);
    return rows.map(deserializeRow);
  }

  /**
   * Get a single embed profile by ID
   */
  async getByIdAsync(id: string): Promise<EmbedProfile | null> {
    const { embedProfiles } = this.tables;
    const rows = await this.db
      .select()
      .from(embedProfiles)
      .where(eq(embedProfiles.id, id))
      .limit(1);
    return rows.length > 0 ? deserializeRow(rows[0]) : null;
  }

  /**
   * Create a new embed profile
   */
  async createAsync(input: EmbedProfileInput): Promise<EmbedProfile> {
    const now = this.now();
    const { embedProfiles } = this.tables;
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
      showTraceroutes: input.showTraceroutes,
      showMqttNodes: input.showMqttNodes,
      pollIntervalSeconds: input.pollIntervalSeconds,
      allowedOrigins: JSON.stringify(input.allowedOrigins),
      sourceId: input.sourceId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(embedProfiles).values(values);

    return deserializeRow({ ...values, channels: values.channels, allowedOrigins: values.allowedOrigins });
  }

  /**
   * Update an embed profile by ID
   */
  async updateAsync(id: string, input: Partial<EmbedProfileInput>): Promise<EmbedProfile | null> {
    const now = this.now();
    const { embedProfiles } = this.tables;
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
    if (input.showTraceroutes !== undefined) updateValues.showTraceroutes = input.showTraceroutes;
    if (input.showMqttNodes !== undefined) updateValues.showMqttNodes = input.showMqttNodes;
    if (input.pollIntervalSeconds !== undefined) updateValues.pollIntervalSeconds = input.pollIntervalSeconds;
    if (input.allowedOrigins !== undefined) updateValues.allowedOrigins = JSON.stringify(input.allowedOrigins);
    if (input.sourceId !== undefined) updateValues.sourceId = input.sourceId;

    await this.db.update(embedProfiles).set(updateValues).where(eq(embedProfiles.id, id));

    return this.getByIdAsync(id);
  }

  /**
   * Delete an embed profile by ID
   */
  async deleteAsync(id: string): Promise<boolean> {
    // Check if the profile exists first
    const existing = await this.getByIdAsync(id);
    if (!existing) return false;

    const { embedProfiles } = this.tables;
    await this.db.delete(embedProfiles).where(eq(embedProfiles.id, id));

    return true;
  }
}
