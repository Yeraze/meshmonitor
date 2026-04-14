/**
 * Nodes Repository
 *
 * Handles all node-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, gt, lt, isNull, or, desc, asc, and, isNotNull, ne, sql, inArray, count } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType, DbNode } from '../types.js';
import { logger } from '../../utils/logger.js';

/**
 * Repository for node operations
 */
export class NodesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Helper to coerce timestamp values to integers for PostgreSQL BIGINT columns.
   * PostgreSQL BIGINT does not accept decimal values, so we truncate to integer.
   */
  private coerceBigintField(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    // Truncate to integer - handles both Date.now() (ms) and Date.now()/1000 (s with decimals)
    return Math.floor(value);
  }

  /**
   * Get a node by nodeNum, optionally scoped to a source.
   *
   * When sourceId is provided, the WHERE clause is scoped per-source — required
   * after migration 029 made (nodeNum, sourceId) the composite PK. When omitted,
   * returns the first matching row across any source (legacy / cross-source
   * lookups retained for back-compat with non-threaded callers).
   */
  async getNode(nodeNum: number, sourceId?: string): Promise<DbNode | null> {
    const { nodes } = this.tables;
    const whereClause = sourceId
      ? and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId))
      : eq(nodes.nodeNum, nodeNum);
    const result = await this.db
      .select()
      .from(nodes)
      .where(whereClause)
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbNode;
  }

  /**
   * Get multiple nodes by nodeNum in a single query
   */
  async getNodesByNums(nodeNums: number[]): Promise<Map<number, DbNode>> {
    if (nodeNums.length === 0) return new Map();
    const { nodes } = this.tables;
    const result = await this.db
      .select()
      .from(nodes)
      .where(inArray(nodes.nodeNum, nodeNums));

    const map = new Map<number, DbNode>();
    for (const row of result) {
      const node = this.normalizeBigInts(row) as DbNode;
      map.set(node.nodeNum, node);
    }
    return map;
  }

  /**
   * Get a node by nodeId, optionally scoped to a source.
   *
   * After migration 029, (nodeId, sourceId) is the composite unique key. When
   * sourceId is provided, the lookup is scoped per-source. When omitted,
   * returns the first matching row across any source (back-compat fallback).
   */
  async getNodeByNodeId(nodeId: string, sourceId?: string): Promise<DbNode | null> {
    const { nodes } = this.tables;
    const whereClause = sourceId
      ? and(eq(nodes.nodeId, nodeId), eq(nodes.sourceId, sourceId))
      : eq(nodes.nodeId, nodeId);
    const result = await this.db
      .select()
      .from(nodes)
      .where(whereClause)
      .limit(1);

    if (result.length === 0) return null;
    return this.normalizeBigInts(result[0]) as DbNode;
  }

  /**
   * Get all nodes ordered by update time
   */
  async getAllNodes(sourceId?: string): Promise<DbNode[]> {
    const { nodes } = this.tables;
    const result = await this.db
      .select()
      .from(nodes)
      .where(this.withSourceScope(nodes, sourceId))
      .orderBy(desc(nodes.updatedAt));

    return this.normalizeBigInts(result) as DbNode[];
  }

  /**
   * Get active nodes (heard within sinceDays)
   */
  async getActiveNodes(sinceDays: number = 7, sourceId?: string): Promise<DbNode[]> {
    // lastHeard is stored in seconds (Unix timestamp)
    const cutoff = Math.floor(Date.now() / 1000) - (sinceDays * 24 * 60 * 60);
    const { nodes } = this.tables;

    const result = await this.db
      .select()
      .from(nodes)
      .where(and(gt(nodes.lastHeard, cutoff), this.withSourceScope(nodes, sourceId)))
      .orderBy(desc(nodes.lastHeard));

    return this.normalizeBigInts(result) as DbNode[];
  }

  /**
   * Get total node count
   */
  async getNodeCount(sourceId?: string): Promise<number> {
    const { nodes } = this.tables;
    const result = await this.db.select({ count: count() }).from(nodes)
      .where(this.withSourceScope(nodes, sourceId));
    return Number(result[0].count);
  }

  /**
   * Insert or update a node.
   * Keeps branching for:
   * - Update path: coerceBigintField needed for MySQL/Postgres BIGINT timestamps (harmless for SQLite, now unified)
   * - Insert path: MySQL uses onDuplicateKeyUpdate vs onConflictDoUpdate
   */
  async upsertNode(nodeData: Partial<DbNode>, sourceId?: string): Promise<void> {
    if (nodeData.nodeNum === undefined || nodeData.nodeNum === null || !nodeData.nodeId) {
      logger.error('Cannot upsert node: missing nodeNum or nodeId');
      return;
    }
    // Fall back to 'default' source for callers that predate multi-source.
    // After migration 029 the primary key is (nodeNum, sourceId) so a value is always needed.
    const effectiveSourceId = sourceId ?? 'default';

    const now = this.now();
    const { nodes } = this.tables;
    const existingNode = await this.getNode(nodeData.nodeNum, effectiveSourceId);

    if (existingNode) {
      // Update existing node - coerceBigintField is safe for all dialects (just Math.floor)
      await this.db
        .update(nodes)
        .set({
          nodeId: nodeData.nodeId ?? existingNode.nodeId,
          longName: nodeData.longName ?? existingNode.longName,
          shortName: nodeData.shortName ?? existingNode.shortName,
          hwModel: nodeData.hwModel ?? existingNode.hwModel,
          role: nodeData.role ?? existingNode.role,
          hopsAway: nodeData.hopsAway ?? existingNode.hopsAway,
          viaMqtt: nodeData.viaMqtt ?? existingNode.viaMqtt,
          isStoreForwardServer: nodeData.isStoreForwardServer ?? existingNode.isStoreForwardServer,
          macaddr: nodeData.macaddr ?? existingNode.macaddr,
          latitude: nodeData.latitude ?? existingNode.latitude,
          longitude: nodeData.longitude ?? existingNode.longitude,
          altitude: nodeData.altitude ?? existingNode.altitude,
          batteryLevel: nodeData.batteryLevel ?? existingNode.batteryLevel,
          voltage: nodeData.voltage ?? existingNode.voltage,
          channelUtilization: nodeData.channelUtilization ?? existingNode.channelUtilization,
          airUtilTx: nodeData.airUtilTx ?? existingNode.airUtilTx,
          lastHeard: this.coerceBigintField(nodeData.lastHeard ?? existingNode.lastHeard),
          snr: nodeData.snr ?? existingNode.snr,
          rssi: nodeData.rssi ?? existingNode.rssi,
          firmwareVersion: nodeData.firmwareVersion ?? existingNode.firmwareVersion,
          channel: nodeData.channel ?? existingNode.channel,
          isFavorite: nodeData.isFavorite ?? existingNode.isFavorite,
          mobile: nodeData.mobile ?? existingNode.mobile,
          rebootCount: nodeData.rebootCount ?? existingNode.rebootCount,
          publicKey: nodeData.publicKey ?? existingNode.publicKey,
          hasPKC: nodeData.hasPKC ?? existingNode.hasPKC,
          lastPKIPacket: this.coerceBigintField(nodeData.lastPKIPacket ?? existingNode.lastPKIPacket),
          // Don't update welcomedAt here - it's managed by markNodeAsWelcomedIfNotAlready
          // to avoid race conditions where this upsert overwrites a concurrent welcome update
          keyIsLowEntropy: nodeData.keyIsLowEntropy !== undefined ? nodeData.keyIsLowEntropy : existingNode.keyIsLowEntropy,
          duplicateKeyDetected: nodeData.duplicateKeyDetected !== undefined ? nodeData.duplicateKeyDetected : existingNode.duplicateKeyDetected,
          keyMismatchDetected: nodeData.keyMismatchDetected !== undefined ? nodeData.keyMismatchDetected : existingNode.keyMismatchDetected,
          keySecurityIssueDetails: nodeData.keySecurityIssueDetails !== undefined ? nodeData.keySecurityIssueDetails : existingNode.keySecurityIssueDetails,
          positionChannel: nodeData.positionChannel ?? existingNode.positionChannel,
          positionPrecisionBits: nodeData.positionPrecisionBits ?? existingNode.positionPrecisionBits,
          positionTimestamp: this.coerceBigintField(nodeData.positionTimestamp ?? existingNode.positionTimestamp),
          updatedAt: now,
        })
        .where(and(eq(nodes.nodeNum, nodeData.nodeNum), eq(nodes.sourceId, effectiveSourceId)));
    } else {
      // Insert new node - coerce BIGINT fields for PostgreSQL
      const newNode = {
        nodeNum: nodeData.nodeNum,
        nodeId: nodeData.nodeId,
        longName: nodeData.longName ?? null,
        shortName: nodeData.shortName ?? null,
        hwModel: nodeData.hwModel ?? null,
        role: nodeData.role ?? null,
        hopsAway: nodeData.hopsAway ?? null,
        viaMqtt: nodeData.viaMqtt ?? null,
        isStoreForwardServer: nodeData.isStoreForwardServer ?? null,
        macaddr: nodeData.macaddr ?? null,
        latitude: nodeData.latitude ?? null,
        longitude: nodeData.longitude ?? null,
        altitude: nodeData.altitude ?? null,
        batteryLevel: nodeData.batteryLevel ?? null,
        voltage: nodeData.voltage ?? null,
        channelUtilization: nodeData.channelUtilization ?? null,
        airUtilTx: nodeData.airUtilTx ?? null,
        lastHeard: this.coerceBigintField(nodeData.lastHeard),
        snr: nodeData.snr ?? null,
        rssi: nodeData.rssi ?? null,
        firmwareVersion: nodeData.firmwareVersion ?? null,
        channel: nodeData.channel ?? null,
        isFavorite: nodeData.isFavorite ?? false,
        mobile: nodeData.mobile ?? null,
        rebootCount: nodeData.rebootCount ?? null,
        publicKey: nodeData.publicKey ?? null,
        hasPKC: nodeData.hasPKC ?? null,
        lastPKIPacket: this.coerceBigintField(nodeData.lastPKIPacket),
        welcomedAt: this.coerceBigintField(nodeData.welcomedAt),
        keyIsLowEntropy: nodeData.keyIsLowEntropy ?? null,
        duplicateKeyDetected: nodeData.duplicateKeyDetected ?? null,
        keyMismatchDetected: nodeData.keyMismatchDetected ?? null,
        keySecurityIssueDetails: nodeData.keySecurityIssueDetails ?? null,
        positionChannel: nodeData.positionChannel ?? null,
        positionPrecisionBits: nodeData.positionPrecisionBits ?? null,
        positionTimestamp: this.coerceBigintField(nodeData.positionTimestamp),
        createdAt: now,
        updatedAt: now,
      } as any;

      // Only set sourceId on INSERT — once a node is associated with a source,
      // that association must not be overwritten by subsequent upserts.
      newNode.sourceId = effectiveSourceId;

      // All databases use atomic upsert to prevent race conditions where
      // concurrent getNode() calls both return null and then both try to INSERT
      const upsertSet = {
        nodeId: nodeData.nodeId,
        longName: nodeData.longName ?? null,
        shortName: nodeData.shortName ?? null,
        hwModel: nodeData.hwModel ?? null,
        role: nodeData.role ?? null,
        hopsAway: nodeData.hopsAway ?? null,
        viaMqtt: nodeData.viaMqtt ?? null,
        isStoreForwardServer: nodeData.isStoreForwardServer ?? null,
        macaddr: nodeData.macaddr ?? null,
        latitude: nodeData.latitude ?? null,
        longitude: nodeData.longitude ?? null,
        altitude: nodeData.altitude ?? null,
        batteryLevel: nodeData.batteryLevel ?? null,
        voltage: nodeData.voltage ?? null,
        channelUtilization: nodeData.channelUtilization ?? null,
        airUtilTx: nodeData.airUtilTx ?? null,
        lastHeard: this.coerceBigintField(nodeData.lastHeard),
        snr: nodeData.snr ?? null,
        rssi: nodeData.rssi ?? null,
        firmwareVersion: nodeData.firmwareVersion ?? null,
        channel: nodeData.channel ?? null,
        isFavorite: nodeData.isFavorite ?? false,
        // Note: mobile is NOT included here - it's only set by updateNodeMobility
        // to prevent overwriting the computed mobility flag on conflict
        rebootCount: nodeData.rebootCount ?? null,
        publicKey: nodeData.publicKey ?? null,
        hasPKC: nodeData.hasPKC ?? null,
        lastPKIPacket: this.coerceBigintField(nodeData.lastPKIPacket),
        welcomedAt: this.coerceBigintField(nodeData.welcomedAt),
        keyIsLowEntropy: nodeData.keyIsLowEntropy ?? null,
        duplicateKeyDetected: nodeData.duplicateKeyDetected ?? null,
        keyMismatchDetected: nodeData.keyMismatchDetected ?? null,
        keySecurityIssueDetails: nodeData.keySecurityIssueDetails ?? null,
        positionChannel: nodeData.positionChannel ?? null,
        positionPrecisionBits: nodeData.positionPrecisionBits ?? null,
        positionTimestamp: this.coerceBigintField(nodeData.positionTimestamp),
        updatedAt: now,
      };

      await this.upsert(nodes, newNode, [nodes.nodeNum, nodes.sourceId], upsertSet);
    }
  }

  /**
   * Generic update for a node's fields
   */
  async updateNode(nodeNum: number, updates: Partial<Omit<DbNode, 'nodeNum'>>): Promise<void> {
    const { nodes } = this.tables;
    await this.db
      .update(nodes)
      .set(updates as any)
      .where(eq(nodes.nodeNum, nodeNum));
  }

  /**
   * Update the lastMessageHops for a node, scoped per-source.
   *
   * After migration 029 (nodeNum, sourceId) is the composite PK, so packet
   * handlers must always supply the sourceId of the manager that received
   * the packet.
   */
  async updateNodeMessageHops(nodeNum: number, hops: number, sourceId: string): Promise<void> {
    const now = this.now();
    const { nodes } = this.tables;
    await this.db
      .update(nodes)
      .set({ lastMessageHops: hops, updatedAt: now })
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
  }

  /**
   * Mark all existing nodes as welcomed.
   * If `sourceId` is provided, only nodes belonging to that source are updated;
   * otherwise all nodes are updated (legacy behavior).
   */
  async markAllNodesAsWelcomed(sourceId?: string | null): Promise<number> {
    const now = this.now();
    const { nodes } = this.tables;

    const whereClause = sourceId
      ? and(isNull(nodes.welcomedAt), eq(nodes.sourceId, sourceId))
      : isNull(nodes.welcomedAt);

    const toUpdate = await this.db
      .select({ nodeNum: nodes.nodeNum })
      .from(nodes)
      .where(whereClause);

    for (const node of toUpdate) {
      await this.db
        .update(nodes)
        .set({ welcomedAt: now })
        .where(eq(nodes.nodeNum, node.nodeNum));
    }
    return toUpdate.length;
  }

  /**
   * Atomically mark a specific node as welcomed if not already welcomed,
   * scoped per-source. After migration 029 (nodeNum, sourceId) is the
   * composite PK so the auto-welcome path must always pass a real sourceId.
   */
  async markNodeAsWelcomedIfNotAlready(nodeNum: number, nodeId: string, sourceId: string): Promise<boolean> {
    const now = this.now();
    const { nodes } = this.tables;

    const toUpdate = await this.db
      .select({ nodeNum: nodes.nodeNum })
      .from(nodes)
      .where(
        and(
          eq(nodes.nodeNum, nodeNum),
          eq(nodes.nodeId, nodeId),
          eq(nodes.sourceId, sourceId),
          isNull(nodes.welcomedAt)
        )
      );

    if (toUpdate.length > 0) {
      await this.db
        .update(nodes)
        .set({ welcomedAt: now, updatedAt: now })
        .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
      return true;
    }
    return false;
  }

  /**
   * Get nodes with key security issues
   */
  async getNodesWithKeySecurityIssues(sourceId?: string): Promise<DbNode[]> {
    const { nodes } = this.tables;
    const result = await this.db
      .select()
      .from(nodes)
      .where(
        and(
          or(
            eq(nodes.keyIsLowEntropy, true),
            eq(nodes.duplicateKeyDetected, true)
          ),
          this.withSourceScope(nodes, sourceId)
        )
      )
      .orderBy(desc(nodes.lastHeard));

    return this.normalizeBigInts(result) as DbNode[];
  }

  /**
   * Get all nodes that have public keys
   */
  async getNodesWithPublicKeys(sourceId?: string): Promise<Array<{ nodeNum: number; publicKey: string | null }>> {
    const { nodes } = this.tables;
    const result = await this.db
      .select({ nodeNum: nodes.nodeNum, publicKey: nodes.publicKey })
      .from(nodes)
      .where(
        and(
          isNotNull(nodes.publicKey),
          ne(nodes.publicKey, ''),
          this.withSourceScope(nodes, sourceId)
        )
      );

    return result;
  }

  /**
   * Update security flags for a node, scoped per-source.
   *
   * After migration 029, (nodeNum, sourceId) is the composite PK so the
   * duplicate-key scanner must always pass a real sourceId.
   */
  async updateNodeSecurityFlags(
    nodeNum: number,
    duplicateKeyDetected: boolean,
    keySecurityIssueDetails: string | undefined,
    sourceId: string
  ): Promise<void> {
    const now = this.now();
    const { nodes } = this.tables;

    await this.db
      .update(nodes)
      .set({
        duplicateKeyDetected,
        keySecurityIssueDetails: keySecurityIssueDetails ?? null,
        updatedAt: now,
      })
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
  }

  /**
   * Update low entropy flag for a node, scoped per-source.
   *
   * After migration 029 (nodeNum, sourceId) is the composite PK so the
   * scanner must always pass a real sourceId.
   */
  async updateNodeLowEntropyFlag(
    nodeNum: number,
    keyIsLowEntropy: boolean,
    details: string | undefined,
    sourceId: string
  ): Promise<void> {
    const node = await this.getNode(nodeNum, sourceId);
    if (!node) return;

    let combinedDetails = details || '';

    if (keyIsLowEntropy && details) {
      if (node.duplicateKeyDetected && node.keySecurityIssueDetails) {
        const existingDetails = node.keySecurityIssueDetails;
        if (existingDetails.includes('Key shared with')) {
          combinedDetails = `${details}; ${existingDetails}`;
        }
      }
    } else if (!keyIsLowEntropy) {
      if (node.duplicateKeyDetected && node.keySecurityIssueDetails) {
        const existingDetails = node.keySecurityIssueDetails;
        if (existingDetails.includes('Key shared with')) {
          combinedDetails = existingDetails.replace(/Known low-entropy key[;,]?\s*/gi, '').trim();
        } else {
          combinedDetails = '';
        }
      } else {
        combinedDetails = '';
      }
    }

    const now = this.now();
    const { nodes } = this.tables;

    await this.db
      .update(nodes)
      .set({
        keyIsLowEntropy,
        keySecurityIssueDetails: combinedDetails || null,
        updatedAt: now,
      })
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
  }

  /**
   * Delete a node by nodeNum scoped to sourceId
   */
  async deleteNodeRecord(nodeNum: number, sourceId: string): Promise<boolean> {
    const { nodes } = this.tables;
    const existing = await this.db
      .select({ nodeNum: nodes.nodeNum })
      .from(nodes)
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));

    if (existing.length === 0) return false;

    await this.db
      .delete(nodes)
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
    return true;
  }

  /**
   * Cleanup inactive nodes
   */
  async cleanupInactiveNodes(days: number = 30): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);
    const { nodes } = this.tables;

    const toDelete = await this.db
      .select({ nodeNum: nodes.nodeNum })
      .from(nodes)
      .where(
        and(
          or(
            lt(nodes.lastHeard, cutoff),
            isNull(nodes.lastHeard)
          ),
          or(
            eq(nodes.isIgnored, false),
            isNull(nodes.isIgnored)
          )
        )
      );

    for (const node of toDelete) {
      await this.db.delete(nodes).where(eq(nodes.nodeNum, node.nodeNum));
    }
    return toDelete.length;
  }

  /**
   * Set node favorite status (scoped to sourceId)
   */
  async setNodeFavorite(nodeNum: number, isFavorite: boolean, sourceId: string, favoriteLocked?: boolean): Promise<void> {
    const now = this.now();
    const { nodes } = this.tables;

    const setData: Record<string, any> = { isFavorite, updatedAt: now };
    if (favoriteLocked !== undefined) {
      setData.favoriteLocked = favoriteLocked;
    }

    await this.db
      .update(nodes)
      .set(setData)
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
  }

  /**
   * Set only the favoriteLocked flag (without changing isFavorite), scoped to sourceId
   */
  async setNodeFavoriteLocked(nodeNum: number, favoriteLocked: boolean, sourceId: string): Promise<void> {
    const now = this.now();
    const { nodes } = this.tables;

    await this.db
      .update(nodes)
      .set({ favoriteLocked, updatedAt: now })
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
  }

  /**
   * Set node ignored status (scoped to sourceId)
   */
  async setNodeIgnored(nodeNum: number, isIgnored: boolean, sourceId: string): Promise<void> {
    const now = this.now();
    const { nodes } = this.tables;

    await this.db
      .update(nodes)
      .set({ isIgnored, updatedAt: now })
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
  }

  /**
   * Update node mobility status
   */
  async updateNodeMobility(nodeId: string, mobile: number): Promise<void> {
    const { nodes } = this.tables;
    await this.db
      .update(nodes)
      .set({ mobile })
      .where(eq(nodes.nodeId, nodeId));
  }

  /**
   * Update last traceroute request time
   */
  async updateLastTracerouteRequest(nodeNum: number, timestamp: number): Promise<void> {
    const now = this.now();
    const { nodes } = this.tables;

    await this.db
      .update(nodes)
      .set({ lastTracerouteRequest: timestamp, updatedAt: now })
      .where(eq(nodes.nodeNum, nodeNum));
  }

  /**
   * Delete inactive nodes (not heard since cutoff timestamp)
   */
  async deleteInactiveNodes(cutoffTimestamp: number): Promise<number> {
    const { nodes } = this.tables;
    const toDelete = await this.db
      .select({ nodeNum: nodes.nodeNum })
      .from(nodes)
      .where(
        and(
          or(lt(nodes.lastHeard, cutoffTimestamp), isNull(nodes.lastHeard)),
          or(eq(nodes.isIgnored, false), isNull(nodes.isIgnored))
        )
      );

    for (const node of toDelete) {
      await this.db.delete(nodes).where(eq(nodes.nodeNum, node.nodeNum));
    }
    return toDelete.length;
  }

  /**
   * Delete all nodes
   */
  async deleteAllNodes(): Promise<number> {
    const { nodes } = this.tables;
    const result = await this.db
      .select({ nodeNum: nodes.nodeNum })
      .from(nodes);
    await this.db.delete(nodes);
    return result.length;
  }

  /**
   * Update node's last traceroute request timestamp, scoped per-source.
   */
  async updateNodeLastTracerouteRequest(nodeNum: number, timestamp: number, sourceId: string): Promise<void> {
    const { nodes } = this.tables;
    await this.db
      .update(nodes)
      .set({ lastTracerouteRequest: timestamp })
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
  }

  /**
   * Get nodes eligible for auto-traceroute
   * Returns nodes that haven't been traced recently based on:
   * - Category 1: No traceroute exists, retry every 3 hours
   * - Category 2: Traceroute exists, retry every expirationHours
   *
   * Keeps branching: raw SQL with different column quoting per dialect.
   */
  async getEligibleNodesForTraceroute(
    localNodeNum: number,
    activeNodeCutoffSeconds: number,
    threeHoursAgoMs: number,
    expirationMsAgo: number,
    sourceId?: string
  ): Promise<DbNode[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const sourceFilter = sourceId ? sql` AND n.sourceId = ${sourceId}` : sql``;
      // SQLite uses raw SQL for the complex subquery
      const results = await db.all<DbNode>(sql`
        SELECT n.*
        FROM nodes n
        WHERE n.nodeNum != ${localNodeNum}
          AND n.lastHeard > ${activeNodeCutoffSeconds}
          ${sourceFilter}
          AND (
            -- Category 1: No traceroute exists, and (never requested OR requested > 3 hours ago)
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ${localNodeNum} AND t.toNodeNum = n.nodeNum) = 0
              AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ${threeHoursAgoMs})
            )
            OR
            -- Category 2: Traceroute exists, and (never requested OR requested > expiration hours ago)
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ${localNodeNum} AND t.toNodeNum = n.nodeNum) > 0
              AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ${expirationMsAgo})
            )
          )
        ORDER BY n.lastHeard DESC
      `);
      return results.map(r => this.normalizeNode(r));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const sourceFilter = sourceId ? sql` AND n.sourceId = ${sourceId}` : sql``;
      const results = await db.execute(sql`
        SELECT n.*
        FROM nodes n
        WHERE n.nodeNum != ${localNodeNum}
          AND n.lastHeard > ${activeNodeCutoffSeconds}
          ${sourceFilter}
          AND (
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ${localNodeNum} AND t.toNodeNum = n.nodeNum) = 0
              AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ${threeHoursAgoMs})
            )
            OR
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.fromNodeNum = ${localNodeNum} AND t.toNodeNum = n.nodeNum) > 0
              AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ${expirationMsAgo})
            )
          )
        ORDER BY n.lastHeard DESC
      `);
      // MySQL returns [rows, fields] tuple
      const rows = (results as unknown as [unknown[], unknown])[0] as DbNode[];
      return rows.map(r => this.normalizeNode(r));
    } else {
      // PostgreSQL
      const db = this.getPostgresDb();
      const nodeNum = this.col('nodeNum');
      const lastHeard = this.col('lastHeard');
      const fromNodeNum = this.col('fromNodeNum');
      const toNodeNum = this.col('toNodeNum');
      const lastTracerouteRequest = this.col('lastTracerouteRequest');
      const sourceFilter = sourceId ? sql` AND n."sourceId" = ${sourceId}` : sql``;
      const results = await db.execute(sql`
        SELECT n.*
        FROM nodes n
        WHERE n.${nodeNum} != ${localNodeNum}
          AND n.${lastHeard} > ${activeNodeCutoffSeconds}
          ${sourceFilter}
          AND (
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.${fromNodeNum} = ${localNodeNum} AND t.${toNodeNum} = n.${nodeNum}) = 0
              AND (n.${lastTracerouteRequest} IS NULL OR n.${lastTracerouteRequest} < ${threeHoursAgoMs})
            )
            OR
            (
              (SELECT COUNT(*) FROM traceroutes t
               WHERE t.${fromNodeNum} = ${localNodeNum} AND t.${toNodeNum} = n.${nodeNum}) > 0
              AND (n.${lastTracerouteRequest} IS NULL OR n.${lastTracerouteRequest} < ${expirationMsAgo})
            )
          )
        ORDER BY n.${lastHeard} DESC
      `);
      // PostgreSQL returns { rows: [...] }
      const rows = (results as unknown as { rows: unknown[] }).rows as DbNode[];
      return rows.map(r => this.normalizeNode(r));
    }
  }

  /**
   * Normalize node data, converting BigInt to Number where needed
   */
  private normalizeNode(node: DbNode): DbNode {
    return {
      ...node,
      nodeNum: Number(node.nodeNum),
      lastHeard: node.lastHeard != null ? Number(node.lastHeard) : null,
      lastTracerouteRequest: node.lastTracerouteRequest != null ? Number(node.lastTracerouteRequest) : null,
      lastRemoteAdminCheck: node.lastRemoteAdminCheck != null ? Number(node.lastRemoteAdminCheck) : null,
      latitude: node.latitude != null ? Number(node.latitude) : null,
      longitude: node.longitude != null ? Number(node.longitude) : null,
      altitude: node.altitude != null ? Number(node.altitude) : null,
      snr: node.snr != null ? Number(node.snr) : null,
      hopsAway: node.hopsAway != null ? Number(node.hopsAway) : null,
      channel: node.channel != null ? Number(node.channel) : null,
      role: node.role != null ? Number(node.role) : null,
      hwModel: node.hwModel != null ? Number(node.hwModel) : null,
    };
  }

  /**
   * Get a single node that needs remote admin checking
   * Filters for:
   * - Not the local node
   * - Has a public key (required for admin)
   * - Active (lastHeard recent)
   * - Not checked recently (lastRemoteAdminCheck null or expired)
   * Returns the most recently heard node matching these criteria
   */
  async getNodeNeedingRemoteAdminCheckAsync(
    localNodeNum: number,
    activeNodeCutoff: number,
    expirationMsAgo: number,
    sourceId?: string
  ): Promise<DbNode | null> {
    const { nodes } = this.tables;
    const results = await this.db
      .select()
      .from(nodes)
      .where(
        and(
          ne(nodes.nodeNum, localNodeNum),
          isNotNull(nodes.publicKey),
          ne(nodes.publicKey, ''),
          gt(nodes.lastHeard, activeNodeCutoff),
          or(
            isNull(nodes.lastRemoteAdminCheck),
            lt(nodes.lastRemoteAdminCheck, expirationMsAgo)
          ),
          this.withSourceScope(nodes, sourceId)
        )
      )
      .orderBy(desc(nodes.lastHeard))
      .limit(1);

    if (results.length === 0) return null;
    return this.normalizeNode(results[0] as DbNode);
  }

  /**
   * Update a node's remote admin status
   * @param nodeNum The node number to update
   * @param hasRemoteAdmin Whether the node has remote admin access
   * @param metadata Optional metadata to save (if null, existing metadata is preserved)
   */
  async updateNodeRemoteAdminStatusAsync(
    nodeNum: number,
    hasRemoteAdmin: boolean,
    metadata: string | null,
    sourceId: string
  ): Promise<void> {
    const now = Date.now();
    const { nodes } = this.tables;

    // Build update object - only include metadata if provided (not null)
    const baseUpdate = {
      hasRemoteAdmin: hasRemoteAdmin,
      lastRemoteAdminCheck: now,
      updatedAt: now,
    };

    const updateData = metadata !== null
      ? { ...baseUpdate, remoteAdminMetadata: metadata }
      : baseUpdate;

    await this.db
      .update(nodes)
      .set(updateData as any)
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
  }

  /**
   * Get a node that needs time sync
   * @param activeNodeCutoff Only consider nodes heard after this timestamp (in seconds, since lastHeard is in seconds)
   * @param expirationMsAgo Only consider nodes with lastTimeSync before this timestamp (in ms, since lastTimeSync is in ms)
   * @param filterNodeNums Optional list of node numbers to filter to (if empty, all nodes with remote admin)
   * @returns A node needing time sync, or null if none found
   */
  async getNodeNeedingTimeSyncAsync(
    activeNodeCutoff: number,
    expirationMsAgo: number,
    filterNodeNums?: number[],
    sourceId?: string
  ): Promise<DbNode | null> {
    const { nodes } = this.tables;
    const baseConditions = [
      eq(nodes.hasRemoteAdmin, true),
      gt(nodes.lastHeard, activeNodeCutoff),
      or(
        isNull(nodes.lastTimeSync),
        lt(nodes.lastTimeSync, expirationMsAgo)
      )
    ];

    // Add filter condition if specific nodes are provided
    if (filterNodeNums && filterNodeNums.length > 0) {
      baseConditions.push(inArray(nodes.nodeNum, filterNodeNums));
    }

    const sourceScope = this.withSourceScope(nodes, sourceId);
    if (sourceScope) baseConditions.push(sourceScope);

    const results = await this.db
      .select()
      .from(nodes)
      .where(and(...baseConditions))
      .orderBy(asc(nodes.lastTimeSync))
      .limit(1);

    if (results.length === 0) return null;
    return this.normalizeNode(results[0] as DbNode);
  }

  /**
   * Update a node's lastTimeSync timestamp
   * @param nodeNum The node number to update
   * @param timestamp The timestamp to set
   */
  async updateNodeTimeSyncAsync(nodeNum: number, timestamp: number, sourceId: string): Promise<void> {
    const now = this.now();
    const { nodes } = this.tables;

    await this.db
      .update(nodes)
      .set({ lastTimeSync: timestamp, updatedAt: now })
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));
  }

  /**
   * Get inactive monitored nodes — nodes in the given nodeId list whose lastHeard is before the cutoff
   */
  async getInactiveMonitoredNodes(
    nodeIds: string[],
    cutoffSeconds: number,
    sourceId?: string
  ): Promise<Array<{ nodeNum: number; nodeId: string; longName: string | null; shortName: string | null; lastHeard: number | null }>> {
    if (nodeIds.length === 0) return [];

    try {
      const { nodes } = this.tables;
      const conditions = [
        inArray(nodes.nodeId, nodeIds),
        isNotNull(nodes.lastHeard),
        lt(nodes.lastHeard, cutoffSeconds),
      ];
      // Phase C: scope to a specific source so per-source inactive checks don't bleed across sources
      if (sourceId) {
        conditions.push(eq(nodes.sourceId, sourceId));
      }
      const rows = await this.db
        .select({ nodeNum: nodes.nodeNum, nodeId: nodes.nodeId, longName: nodes.longName, shortName: nodes.shortName, lastHeard: nodes.lastHeard })
        .from(nodes)
        .where(and(...conditions))
        .orderBy(asc(nodes.lastHeard));
      return rows.map((r: any) => ({ ...r, nodeNum: Number(r.nodeNum) }));
    } catch (error) {
      logger.error('Failed to query inactive monitored nodes:', error);
      return [];
    }
  }
}
