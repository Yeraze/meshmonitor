/**
 * Repository for `mqtt_native_identities` (#4305): the generated Meshtastic
 * identity of an MQTT source that sends with no radio attached, plus the send
 * state that must survive a restart (last NodeInfo announce, recent send
 * timestamps for the hourly cap). Per-source, keyed by sourceId.
 */
import { eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface DbMqttNativeIdentity {
  sourceId: string;
  nodeNum: number;
  /** Base64 X25519 public key (32 bytes). */
  publicKey: string;
  /** SourcePkiKeyStore envelope JSON sealing the 32-byte private key. */
  encryptedPrivateKey: string;
  /** ms epoch of the last NodeInfo announce, or null when none was sent yet. */
  lastNodeInfoAt: number | null;
  /** JSON array of ms epochs of recent user sends (rate-limit window). */
  sendTimes: string | null;
  createdAt: number;
  updatedAt: number;
}

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class MqttNativeIdentitiesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private map(row: Record<string, unknown> | undefined): DbMqttNativeIdentity | null {
    if (!row) return null;
    return {
      sourceId: String(row.sourceId),
      // BIGINT on PG/MySQL: always coerce.
      nodeNum: Number(row.nodeNum) >>> 0,
      publicKey: String(row.publicKey),
      encryptedPrivateKey: String(row.encryptedPrivateKey),
      lastNodeInfoAt: toNumOrNull(row.lastNodeInfoAt),
      sendTimes: (row.sendTimes as string | null) ?? null,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  async getBySourceId(sourceId: string): Promise<DbMqttNativeIdentity | null> {
    const { mqttNativeIdentities } = this.tables;
    const rows = await this.db
      .select()
      .from(mqttNativeIdentities)
      .where(eq(mqttNativeIdentities.sourceId, sourceId))
      .limit(1);
    return this.map(rows[0] as Record<string, unknown> | undefined);
  }

  /** Every stored identity (node numbers + public keys; the envelope rides along). */
  async listAll(): Promise<DbMqttNativeIdentity[]> {
    const { mqttNativeIdentities } = this.tables;
    const rows = await this.db.select().from(mqttNativeIdentities);
    return (rows as Array<Record<string, unknown>>)
      .map((r) => this.map(r))
      .filter((r): r is DbMqttNativeIdentity => r !== null);
  }

  /**
   * Insert a new identity. Fails (primary-key violation) when the source
   * already has one: an identity is created once and never silently replaced,
   * since the mesh knows us by it.
   */
  async create(input: { sourceId: string; nodeNum: number; publicKey: string; encryptedPrivateKey: string }): Promise<void> {
    if (!input.sourceId) throw new Error('MqttNativeIdentitiesRepository.create requires a sourceId');
    const { mqttNativeIdentities } = this.tables;
    const now = Date.now();
    await this.db.insert(mqttNativeIdentities).values({
      sourceId: input.sourceId,
      nodeNum: input.nodeNum >>> 0,
      publicKey: input.publicKey,
      encryptedPrivateKey: input.encryptedPrivateKey,
      lastNodeInfoAt: null,
      sendTimes: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async setLastNodeInfoAt(sourceId: string, at: number): Promise<void> {
    const { mqttNativeIdentities } = this.tables;
    await this.db
      .update(mqttNativeIdentities)
      .set({ lastNodeInfoAt: at, updatedAt: Date.now() })
      .where(eq(mqttNativeIdentities.sourceId, sourceId));
  }

  async setSendTimes(sourceId: string, times: number[]): Promise<void> {
    const { mqttNativeIdentities } = this.tables;
    await this.db
      .update(mqttNativeIdentities)
      .set({ sendTimes: JSON.stringify(times), updatedAt: Date.now() })
      .where(eq(mqttNativeIdentities.sourceId, sourceId));
  }

  async deleteBySourceId(sourceId: string): Promise<void> {
    const { mqttNativeIdentities } = this.tables;
    await this.db.delete(mqttNativeIdentities).where(eq(mqttNativeIdentities.sourceId, sourceId));
  }
}
