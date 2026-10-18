/**
 * Repository for `mqtt_broker_presets` (issue #5794): MQTT brokers an admin
 * saved for reuse across the Meshtastic MQTT forms.
 *
 * GLOBAL by design — no sourceId. The table is a short admin-curated list, so
 * reads return every row. Callers decide who may see `username`/`password`
 * (routes/mqttBrokerPresetRoutes.ts); this layer returns them as stored.
 */
import { asc, eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface MqttBrokerPreset {
  id: number;
  name: string;
  host: string;
  port: number;
  tls: boolean;
  username: string | null;
  password: string | null;
  rootTopic: string | null;
  /** ms since epoch */
  createdAt: number;
  /** ms since epoch */
  updatedAt: number;
}

export type MqttBrokerPresetInput = Omit<MqttBrokerPreset, 'id' | 'createdAt' | 'updatedAt'>;

export class MqttBrokerPresetsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private toPreset(r: Record<string, unknown>): MqttBrokerPreset {
    return {
      id: Number(r.id),
      name: String(r.name),
      host: String(r.host),
      port: Number(r.port),
      tls: r.tls === true || r.tls === 1,
      username: (r.username as string | null) ?? null,
      password: (r.password as string | null) ?? null,
      rootTopic: (r.rootTopic as string | null) ?? null,
      createdAt: Number(r.createdAt),
      updatedAt: Number(r.updatedAt),
    };
  }

  /** Every preset, by name. */
  async listAsync(): Promise<MqttBrokerPreset[]> {
    const { mqttBrokerPresets } = this.tables;
    const rows = await this.db.select().from(mqttBrokerPresets).orderBy(asc(mqttBrokerPresets.name));
    return (rows as Record<string, unknown>[]).map(r => this.toPreset(r));
  }

  async getAsync(id: number): Promise<MqttBrokerPreset | null> {
    const { mqttBrokerPresets } = this.tables;
    const rows = await this.db.select().from(mqttBrokerPresets).where(eq(mqttBrokerPresets.id, id)).limit(1);
    const row = (rows as Record<string, unknown>[])[0];
    return row ? this.toPreset(row) : null;
  }

  /** Insert one preset and return it. The name must be free (see `isNameTakenAsync`). */
  async createAsync(input: MqttBrokerPresetInput, now: number = Date.now()): Promise<MqttBrokerPreset> {
    const { mqttBrokerPresets } = this.tables;
    await this.db.insert(mqttBrokerPresets).values({ ...input, createdAt: now, updatedAt: now });
    // Read back by the unique name: works on all three backends, unlike RETURNING.
    const rows = await this.db.select().from(mqttBrokerPresets).where(eq(mqttBrokerPresets.name, input.name)).limit(1);
    return this.toPreset((rows as Record<string, unknown>[])[0]);
  }

  /** Replace one preset's fields. Returns null when there is no such preset. */
  async updateAsync(id: number, input: MqttBrokerPresetInput, now: number = Date.now()): Promise<MqttBrokerPreset | null> {
    const { mqttBrokerPresets } = this.tables;
    await this.db.update(mqttBrokerPresets).set({ ...input, updatedAt: now }).where(eq(mqttBrokerPresets.id, id));
    return this.getAsync(id);
  }

  /** Returns false when there was no such preset. */
  async deleteAsync(id: number): Promise<boolean> {
    if (!(await this.getAsync(id))) return false;
    const { mqttBrokerPresets } = this.tables;
    await this.db.delete(mqttBrokerPresets).where(eq(mqttBrokerPresets.id, id));
    return true;
  }

  /** Is `name` used by a preset other than `exceptId`? Case-insensitive, so "Home" and "home" cannot both exist. */
  async isNameTakenAsync(name: string, exceptId?: number): Promise<boolean> {
    const wanted = name.trim().toLowerCase();
    return (await this.listAsync()).some(p => p.id !== exceptId && p.name.trim().toLowerCase() === wanted);
  }
}
