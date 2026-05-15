/**
 * MeshCore Repository
 *
 * Handles MeshCore node and message database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, sql, isNull, and, lt } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

/**
 * MeshCore node data for database operations
 */
export interface DbMeshCoreNode {
  publicKey: string;
  name?: string | null;
  advType?: number | null;
  txPower?: number | null;
  maxTxPower?: number | null;
  radioFreq?: number | null;
  radioBw?: number | null;
  radioSf?: number | null;
  radioCr?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  batteryMv?: number | null;
  uptimeSecs?: number | null;
  rssi?: number | null;
  snr?: number | null;
  lastHeard?: number | null;
  hasAdminAccess?: boolean | null;
  lastAdminCheck?: number | null;
  isLocalNode?: boolean | null;
  /** Owning source id; required on writes since slice 1 (migration 056). */
  sourceId?: string | null;
  /**
   * Per-node remote-telemetry retrieval config (migration 060). Controls
   * whether the MeshCoreRemoteTelemetryScheduler periodically issues
   * `req_telemetry_sync` against this node and at what cadence.
   */
  telemetryEnabled?: boolean | null;
  telemetryIntervalMinutes?: number | null;
  lastTelemetryRequestAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * MeshCore message data for database operations
 */
export interface DbMeshCoreMessage {
  id: string;
  fromPublicKey: string;
  toPublicKey?: string | null;
  text: string;
  timestamp: number;
  rssi?: number | null;
  snr?: number | null;
  messageType?: string | null;
  delivered?: boolean | null;
  deliveredAt?: number | null;
  /** Owning source id; required on writes since slice 1 (migration 056). */
  sourceId?: string | null;
  createdAt: number;
}

/**
 * Repository for MeshCore operations
 */
export class MeshCoreRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  // ============ Node Operations ============

  /**
   * Get all MeshCore nodes
   */
  async getAllNodes(): Promise<DbMeshCoreNode[]> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .orderBy(desc(meshcoreNodes.lastHeard));
    return this.normalizeBigInts(result) as unknown as DbMeshCoreNode[];
  }

  /**
   * Get a specific node by public key, ignoring source ownership.
   * Prefer `getNodeByPublicKeyAndSource` for write paths — this variant
   * exists for cross-source read paths that legitimately don't care which
   * source owns the row.
   */
  async getNodeByPublicKey(publicKey: string): Promise<DbMeshCoreNode | null> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .where(eq(meshcoreNodes.publicKey, publicKey))
      .limit(1);
    return result[0] ? this.normalizeBigInts(result[0]) as unknown as DbMeshCoreNode : null;
  }

  /**
   * Get a node scoped by both publicKey and sourceId. Required for any
   * write path: looking up by publicKey alone would let one source's
   * upsert clobber another source's row when both happen to advertise
   * the same key.
   */
  async getNodeByPublicKeyAndSource(
    publicKey: string,
    sourceId: string,
  ): Promise<DbMeshCoreNode | null> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)))
      .limit(1);
    return result[0] ? this.normalizeBigInts(result[0]) as unknown as DbMeshCoreNode : null;
  }

  /**
   * Get the local node
   */
  async getLocalNode(): Promise<DbMeshCoreNode | null> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .where(eq(meshcoreNodes.isLocalNode, true))
      .limit(1);
    return result[0] ? this.normalizeBigInts(result[0]) as unknown as DbMeshCoreNode : null;
  }

  /**
   * Upsert a MeshCore node (insert or update). `sourceId` is required so
   * every row in `meshcore_nodes` is stamped with its owning source —
   * non-negotiable since the multi-source MeshCore refactor (slice 1).
   */
  async upsertNode(
    node: Partial<DbMeshCoreNode> & { publicKey: string },
    sourceId: string,
  ): Promise<void> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.upsertNode requires a sourceId');
    }
    const now = this.now();
    const { meshcoreNodes } = this.tables;
    const existing = await this.getNodeByPublicKeyAndSource(node.publicKey, sourceId);

    if (existing) {
      await this.db
        .update(meshcoreNodes)
        .set({ ...node, sourceId, updatedAt: now })
        .where(and(eq(meshcoreNodes.publicKey, node.publicKey), eq(meshcoreNodes.sourceId, sourceId)));
    } else {
      await this.db
        .insert(meshcoreNodes)
        .values({
          ...node,
          sourceId,
          createdAt: now,
          updatedAt: now,
        });
    }
  }

  /**
   * Set the per-node remote-telemetry retrieval config for a
   * (sourceId, publicKey) row. Inserts a stub row if one doesn't yet
   * exist — MeshCoreManager doesn't currently persist every observed
   * contact, so the user may toggle telemetry on a node that has only
   * been seen in-memory. Idempotent on the (publicKey, sourceId) pair.
   *
   * Caller is responsible for validating `intervalMinutes` (>0, sane
   * ceiling). Passing `undefined` for either field leaves the existing
   * value intact (on update) or applies the column default (on insert).
   */
  async setNodeTelemetryConfig(
    sourceId: string,
    publicKey: string,
    cfg: { enabled?: boolean; intervalMinutes?: number },
  ): Promise<void> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.setNodeTelemetryConfig requires a sourceId');
    }
    const now = this.now();
    const { meshcoreNodes } = this.tables;
    const existing = await this.getNodeByPublicKeyAndSource(publicKey, sourceId);

    if (existing) {
      const patch: Record<string, unknown> = { updatedAt: now };
      if (cfg.enabled !== undefined) patch.telemetryEnabled = cfg.enabled;
      if (cfg.intervalMinutes !== undefined) patch.telemetryIntervalMinutes = cfg.intervalMinutes;
      await this.db
        .update(meshcoreNodes)
        .set(patch)
        .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
      return;
    }

    const seed: Record<string, unknown> = {
      publicKey,
      sourceId,
      createdAt: now,
      updatedAt: now,
    };
    if (cfg.enabled !== undefined) seed.telemetryEnabled = cfg.enabled;
    if (cfg.intervalMinutes !== undefined) seed.telemetryIntervalMinutes = cfg.intervalMinutes;
    await this.db.insert(meshcoreNodes).values(seed);
  }

  /**
   * Mark a node as having just had a telemetry request sent. Stamps
   * `lastTelemetryRequestAt` to `now` so the scheduler will wait at
   * least `telemetryIntervalMinutes` before picking it again.
   */
  async markTelemetryRequested(
    sourceId: string,
    publicKey: string,
    when: number = this.now(),
  ): Promise<void> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.markTelemetryRequested requires a sourceId');
    }
    const { meshcoreNodes } = this.tables;
    await this.db
      .update(meshcoreNodes)
      .set({ lastTelemetryRequestAt: when, updatedAt: when })
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
  }

  /**
   * Return every node in a source that currently has telemetry retrieval
   * enabled. The scheduler decides per-node eligibility (interval vs
   * `lastTelemetryRequestAt`) in memory so it can stay engine-portable
   * without needing per-backend time math in the query.
   */
  async getTelemetryEnabledNodes(sourceId: string): Promise<DbMeshCoreNode[]> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .where(and(eq(meshcoreNodes.sourceId, sourceId), eq(meshcoreNodes.telemetryEnabled, true)));
    return this.normalizeBigInts(result) as unknown as DbMeshCoreNode[];
  }

  /**
   * Delete a node row scoped by (sourceId, publicKey). Required since the
   * composite-PK migration: the same publicKey can exist under multiple
   * sources, so a publicKey-only delete would wipe rows from every source.
   */
  async deleteNode(publicKey: string, sourceId: string): Promise<boolean> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.deleteNode requires a sourceId');
    }
    const { meshcoreNodes } = this.tables;
    await this.db
      .delete(meshcoreNodes)
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
    return true;
  }

  /**
   * Get node count
   */
  async getNodeCount(): Promise<number> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db.select({ count: sql<number>`COUNT(*)` }).from(meshcoreNodes);
    return Number(result[0]?.count ?? 0);
  }

  /**
   * Delete all nodes
   */
  async deleteAllNodes(): Promise<number> {
    const count = await this.getNodeCount();
    const { meshcoreNodes } = this.tables;
    await this.db.delete(meshcoreNodes);
    return count;
  }

  // ============ Message Operations ============

  /**
   * Get recent messages
   */
  async getRecentMessages(limit: number = 50): Promise<DbMeshCoreMessage[]> {
    const { meshcoreMessages } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreMessages)
      .orderBy(desc(meshcoreMessages.timestamp))
      .limit(limit);
    return this.normalizeBigInts(result) as unknown as DbMeshCoreMessage[];
  }

  /**
   * Get messages for a specific conversation (to/from a public key)
   */
  async getMessagesForConversation(publicKey: string, limit: number = 50): Promise<DbMeshCoreMessage[]> {
    const { meshcoreMessages } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreMessages)
      .where(
        sql`${meshcoreMessages.fromPublicKey} = ${publicKey} OR ${meshcoreMessages.toPublicKey} = ${publicKey}`
      )
      .orderBy(desc(meshcoreMessages.timestamp))
      .limit(limit);
    return this.normalizeBigInts(result) as unknown as DbMeshCoreMessage[];
  }

  /**
   * Get broadcast messages (no toPublicKey)
   */
  async getBroadcastMessages(limit: number = 50): Promise<DbMeshCoreMessage[]> {
    const { meshcoreMessages } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreMessages)
      .where(isNull(meshcoreMessages.toPublicKey))
      .orderBy(desc(meshcoreMessages.timestamp))
      .limit(limit);
    return this.normalizeBigInts(result) as unknown as DbMeshCoreMessage[];
  }

  /**
   * Insert a message. `sourceId` is required so every row in
   * `meshcore_messages` is stamped with its owning source.
   */
  async insertMessage(message: DbMeshCoreMessage, sourceId: string): Promise<void> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.insertMessage requires a sourceId');
    }
    const { meshcoreMessages } = this.tables;
    await this.db.insert(meshcoreMessages).values({ ...message, sourceId });
  }

  /**
   * Mark a message as delivered
   */
  async markMessageDelivered(messageId: string): Promise<void> {
    const now = this.now();
    const { meshcoreMessages } = this.tables;
    await this.db
      .update(meshcoreMessages)
      .set({ delivered: true, deliveredAt: now })
      .where(eq(meshcoreMessages.id, messageId));
  }

  /**
   * Get message count
   */
  async getMessageCount(): Promise<number> {
    const { meshcoreMessages } = this.tables;
    const result = await this.db.select({ count: sql<number>`COUNT(*)` }).from(meshcoreMessages);
    return Number(result[0]?.count ?? 0);
  }

  /**
   * Delete messages older than a timestamp
   */
  async deleteMessagesOlderThan(timestamp: number): Promise<number> {
    const { meshcoreMessages } = this.tables;
    const toDelete = await this.db
      .select({ id: meshcoreMessages.id })
      .from(meshcoreMessages)
      .where(lt(meshcoreMessages.timestamp, timestamp));

    if (toDelete.length === 0) return 0;

    await this.db
      .delete(meshcoreMessages)
      .where(lt(meshcoreMessages.timestamp, timestamp));
    return toDelete.length;
  }

  /**
   * Delete all messages
   */
  async deleteAllMessages(): Promise<number> {
    const count = await this.getMessageCount();
    const { meshcoreMessages } = this.tables;
    await this.db.delete(meshcoreMessages);
    return count;
  }
}
