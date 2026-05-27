/**
 * MeshCore Repository
 *
 * Handles MeshCore node and message database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, sql, isNull, and, lt, gte, inArray, type SQL } from 'drizzle-orm';
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
  /**
   * MeshCore per-contact forwarding route (migration 068). `outPath` is a
   * comma-separated hex chain of hop hashes ("a3,7f,02"); `pathLen` is the
   * hop count. Both null means the firmware's OUT_PATH_UNKNOWN (0xFF)
   * sentinel is set and the next send will flood.
   */
  outPath?: string | null;
  pathLen?: number | null;
  /**
   * Encrypted MeshCore admin password (migration 070). JSON envelope:
   * `{v, kid, iv, ct, tag}`. NULL means "no saved credential". Managed
   * exclusively by `MeshCoreCredentialStore`; callers outside that service
   * should not read or write this directly.
   */
  adminCredential?: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * MeshCore message data for database operations
 */
export interface DbMeshCoreMessage {
  id: string;
  fromPublicKey: string;
  /** Display name parsed from channel message body ("Name: text"); null for DMs. */
  fromName?: string | null;
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
   * Write (or clear) the encrypted admin-credential blob for a node.
   * Pass `envelope = null` to clear. UPDATE-only — does not insert a stub
   * row, because saving a credential for a node we've never seen is
   * nonsensical (the user must have logged in first, which means the
   * contact was already in our table).
   */
  async setAdminCredential(
    sourceId: string,
    publicKey: string,
    envelope: string | null,
  ): Promise<void> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.setAdminCredential requires a sourceId');
    }
    const { meshcoreNodes } = this.tables;
    const now = this.now();
    await this.db
      .update(meshcoreNodes)
      .set({ adminCredential: envelope, updatedAt: now })
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
  }

  /**
   * Read the raw encrypted admin-credential blob for a node. Returns null
   * when there is no row OR when the column is null. The caller (the
   * credential store) decrypts and validates.
   */
  async getAdminCredential(sourceId: string, publicKey: string): Promise<string | null> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.getAdminCredential requires a sourceId');
    }
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select({ adminCredential: meshcoreNodes.adminCredential })
      .from(meshcoreNodes)
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)))
      .limit(1);
    return (result[0]?.adminCredential as string | null) ?? null;
  }

  // ---- Room credential (same envelope format as adminCredential) ----

  async setRoomCredential(
    sourceId: string,
    publicKey: string,
    envelope: string | null,
  ): Promise<void> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.setRoomCredential requires a sourceId');
    }
    const { meshcoreNodes } = this.tables;
    const now = this.now();
    await this.db
      .update(meshcoreNodes)
      .set({ roomCredential: envelope, updatedAt: now })
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
  }

  async getRoomCredential(sourceId: string, publicKey: string): Promise<string | null> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.getRoomCredential requires a sourceId');
    }
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select({ roomCredential: meshcoreNodes.roomCredential })
      .from(meshcoreNodes)
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)))
      .limit(1);
    return (result[0]?.roomCredential as string | null) ?? null;
  }

  async listRoomCredentials(): Promise<
    Array<{ sourceId: string; publicKey: string; name: string | null; roomCredential: string }>
  > {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select({
        sourceId: meshcoreNodes.sourceId,
        publicKey: meshcoreNodes.publicKey,
        name: meshcoreNodes.name,
        roomCredential: meshcoreNodes.roomCredential,
      })
      .from(meshcoreNodes);
    const rows = this.normalizeBigInts(result) as unknown as Array<{
      sourceId: string;
      publicKey: string;
      name: string | null;
      roomCredential: string | null;
    }>;
    return rows
      .filter((r) => r.roomCredential != null)
      .map((r) => ({
        sourceId: r.sourceId,
        publicKey: r.publicKey,
        name: r.name,
        roomCredential: r.roomCredential as string,
      }));
  }

  // ---- Room sync config ----

  async getRoomSyncConfig(
    sourceId: string,
    publicKey: string,
  ): Promise<{ enabled: boolean; intervalMinutes: number } | null> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select({
        roomSyncEnabled: meshcoreNodes.roomSyncEnabled,
        roomSyncIntervalMinutes: meshcoreNodes.roomSyncIntervalMinutes,
      })
      .from(meshcoreNodes)
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
    const rows = this.normalizeBigInts(result) as unknown as Array<{
      roomSyncEnabled: boolean | number | null;
      roomSyncIntervalMinutes: number | null;
    }>;
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      enabled: row.roomSyncEnabled === true || row.roomSyncEnabled === 1,
      intervalMinutes: row.roomSyncIntervalMinutes ?? 60,
    };
  }

  async setRoomSyncConfig(
    sourceId: string,
    publicKey: string,
    config: { roomSyncEnabled?: boolean; roomSyncIntervalMinutes?: number },
  ): Promise<void> {
    const { meshcoreNodes } = this.tables;
    const now = this.now();
    await this.db
      .update(meshcoreNodes)
      .set({ ...config, updatedAt: now })
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
  }

  async updateLastRoomSyncAt(sourceId: string, publicKey: string): Promise<void> {
    const { meshcoreNodes } = this.tables;
    const now = this.now();
    await this.db
      .update(meshcoreNodes)
      .set({ lastRoomSyncAt: now, updatedAt: now })
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
  }

  async updateLastRoomPostAt(sourceId: string, publicKey: string, timestamp: number): Promise<void> {
    const { meshcoreNodes } = this.tables;
    const now = this.now();
    await this.db
      .update(meshcoreNodes)
      .set({ lastRoomPostAt: timestamp, updatedAt: now })
      .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
  }

  /**
   * Return every row that has a saved admin credential, across all
   * sources. Used by the startup banner to detect SESSION_SECRET rotation
   * — the credential store inspects each envelope's `kid` and reports
   * mismatches up to the UI.
   */
  async listAdminCredentials(): Promise<
    Array<{ sourceId: string; publicKey: string; name: string | null; adminCredential: string }>
  > {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select({
        sourceId: meshcoreNodes.sourceId,
        publicKey: meshcoreNodes.publicKey,
        name: meshcoreNodes.name,
        adminCredential: meshcoreNodes.adminCredential,
      })
      .from(meshcoreNodes);
    const rows = this.normalizeBigInts(result) as unknown as Array<{
      sourceId: string;
      publicKey: string;
      name: string | null;
      adminCredential: string | null;
    }>;
    return rows
      .filter((r) => r.adminCredential != null)
      .map((r) => ({
        sourceId: r.sourceId,
        publicKey: r.publicKey,
        name: r.name,
        adminCredential: r.adminCredential as string,
      }));
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

  async getRoomSyncEnabledNodes(sourceId: string): Promise<DbMeshCoreNode[]> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .where(and(
        eq(meshcoreNodes.sourceId, sourceId),
        eq(meshcoreNodes.roomSyncEnabled, true),
      ));
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
   * Get recent messages, optionally scoped to a source.
   */
  async getRecentMessages(limit: number = 50, sourceId?: string): Promise<DbMeshCoreMessage[]> {
    const { meshcoreMessages } = this.tables;
    const whereClause: SQL | undefined = sourceId
      ? eq(meshcoreMessages.sourceId, sourceId)
      : undefined;
    const result = await this.db
      .select()
      .from(meshcoreMessages)
      .where(whereClause)
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

  // ============ Neighbor Methods ============

  async insertNeighborsBatch(
    sourceId: string,
    publicKey: string,
    neighbors: Array<{ neighborPublicKey: string; snr: number | null; lastHeardSecs: number | null }>,
  ): Promise<void> {
    const { meshcoreNeighbors } = this.tables;
    const nowMs = Date.now();

    await this.db
      .delete(meshcoreNeighbors)
      .where(and(eq(meshcoreNeighbors.sourceId, sourceId), eq(meshcoreNeighbors.publicKey, publicKey)));

    if (neighbors.length === 0) return;

    await this.db.insert(meshcoreNeighbors).values(
      neighbors.map((n) => ({
        sourceId,
        publicKey,
        neighborPublicKey: n.neighborPublicKey,
        snr: n.snr,
        lastHeardSecs: n.lastHeardSecs,
        timestamp: nowMs,
        createdAt: nowMs,
      })),
    );
  }

  async getNeighbors(
    sourceIds: string[],
    sinceMs: number = 0,
  ): Promise<Array<{ id: number; sourceId: string; publicKey: string; neighborPublicKey: string; snr: number | null; timestamp: number; nodeName: string | null; neighborName: string | null }>> {
    const { meshcoreNeighbors, meshcoreNodes } = this.tables;
    if (sourceIds.length === 0) return [];

    const conditions: SQL[] = [
      inArray(meshcoreNeighbors.sourceId, sourceIds),
    ];
    if (sinceMs > 0) {
      conditions.push(gte(meshcoreNeighbors.timestamp, sinceMs));
    }

    const rows = await this.db
      .select({
        id: meshcoreNeighbors.id,
        sourceId: meshcoreNeighbors.sourceId,
        publicKey: meshcoreNeighbors.publicKey,
        neighborPublicKey: meshcoreNeighbors.neighborPublicKey,
        snr: meshcoreNeighbors.snr,
        timestamp: meshcoreNeighbors.timestamp,
      })
      .from(meshcoreNeighbors)
      .where(and(...conditions))
      .orderBy(desc(meshcoreNeighbors.timestamp));

    if (rows.length === 0) return [];

    const allKeys = new Set<string>();
    for (const r of rows) {
      allKeys.add(r.publicKey);
      allKeys.add(r.neighborPublicKey);
    }

    const nodes = await this.db
      .select({ publicKey: meshcoreNodes.publicKey, name: meshcoreNodes.name })
      .from(meshcoreNodes)
      .where(and(
        inArray(meshcoreNodes.sourceId, sourceIds),
        inArray(meshcoreNodes.publicKey, [...allKeys]),
      ));
    const nameMap = new Map(nodes.map((n: { publicKey: string; name: string | null }) => [n.publicKey, n.name]));

    return rows.map((r: typeof rows[number]) => ({
      ...r,
      nodeName: nameMap.get(r.publicKey) ?? null,
      neighborName: nameMap.get(r.neighborPublicKey) ?? null,
    }));
  }

  async deleteNeighborsForNode(sourceId: string, publicKey: string): Promise<void> {
    const { meshcoreNeighbors } = this.tables;
    await this.db
      .delete(meshcoreNeighbors)
      .where(and(eq(meshcoreNeighbors.sourceId, sourceId), eq(meshcoreNeighbors.publicKey, publicKey)));
  }

  async deleteAllNeighbors(sourceId?: string): Promise<void> {
    const { meshcoreNeighbors } = this.tables;
    if (sourceId) {
      await this.db.delete(meshcoreNeighbors).where(eq(meshcoreNeighbors.sourceId, sourceId));
    } else {
      await this.db.delete(meshcoreNeighbors);
    }
  }
}
