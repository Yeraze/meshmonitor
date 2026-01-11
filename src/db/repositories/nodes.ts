/**
 * Nodes Repository
 *
 * Handles all node-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, gt, lt, isNull, or, desc, and, isNotNull, ne } from 'drizzle-orm';
import { nodesSqlite, nodesPostgres, nodesMysql } from '../schema/nodes.js';
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
   * Get a node by nodeNum
   */
  async getNode(nodeNum: number): Promise<DbNode | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(nodesSqlite)
        .where(eq(nodesSqlite.nodeNum, nodeNum))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbNode;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(nodesMysql)
        .where(eq(nodesMysql.nodeNum, nodeNum))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbNode;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(nodesPostgres)
        .where(eq(nodesPostgres.nodeNum, nodeNum))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbNode;
    }
  }

  /**
   * Get a node by nodeId
   */
  async getNodeByNodeId(nodeId: string): Promise<DbNode | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(nodesSqlite)
        .where(eq(nodesSqlite.nodeId, nodeId))
        .limit(1);

      if (result.length === 0) return null;
      return this.normalizeBigInts(result[0]) as DbNode;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(nodesMysql)
        .where(eq(nodesMysql.nodeId, nodeId))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbNode;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(nodesPostgres)
        .where(eq(nodesPostgres.nodeId, nodeId))
        .limit(1);

      if (result.length === 0) return null;
      return result[0] as DbNode;
    }
  }

  /**
   * Get all nodes ordered by update time
   */
  async getAllNodes(): Promise<DbNode[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const nodes = await db
        .select()
        .from(nodesSqlite)
        .orderBy(desc(nodesSqlite.updatedAt));

      return nodes.map(n => this.normalizeBigInts(n) as DbNode);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const nodes = await db
        .select()
        .from(nodesMysql)
        .orderBy(desc(nodesMysql.updatedAt));

      return nodes as DbNode[];
    } else {
      const db = this.getPostgresDb();
      const nodes = await db
        .select()
        .from(nodesPostgres)
        .orderBy(desc(nodesPostgres.updatedAt));

      return nodes as DbNode[];
    }
  }

  /**
   * Get active nodes (heard within sinceDays)
   */
  async getActiveNodes(sinceDays: number = 7): Promise<DbNode[]> {
    // lastHeard is stored in seconds (Unix timestamp)
    const cutoff = Math.floor(Date.now() / 1000) - (sinceDays * 24 * 60 * 60);

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const nodes = await db
        .select()
        .from(nodesSqlite)
        .where(gt(nodesSqlite.lastHeard, cutoff))
        .orderBy(desc(nodesSqlite.lastHeard));

      return nodes.map(n => this.normalizeBigInts(n) as DbNode);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const nodes = await db
        .select()
        .from(nodesMysql)
        .where(gt(nodesMysql.lastHeard, cutoff))
        .orderBy(desc(nodesMysql.lastHeard));

      return nodes as DbNode[];
    } else {
      const db = this.getPostgresDb();
      const nodes = await db
        .select()
        .from(nodesPostgres)
        .where(gt(nodesPostgres.lastHeard, cutoff))
        .orderBy(desc(nodesPostgres.lastHeard));

      return nodes as DbNode[];
    }
  }

  /**
   * Get total node count
   */
  async getNodeCount(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.select().from(nodesSqlite);
      return result.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.select().from(nodesMysql);
      return result.length;
    } else {
      const db = this.getPostgresDb();
      const result = await db.select().from(nodesPostgres);
      return result.length;
    }
  }

  /**
   * Insert or update a node
   */
  async upsertNode(nodeData: Partial<DbNode>): Promise<void> {
    if (nodeData.nodeNum === undefined || nodeData.nodeNum === null || !nodeData.nodeId) {
      logger.error('Cannot upsert node: missing nodeNum or nodeId');
      return;
    }

    const now = this.now();
    const existingNode = await this.getNode(nodeData.nodeNum);

    if (existingNode) {
      // Update existing node
      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        await db
          .update(nodesSqlite)
          .set({
            nodeId: nodeData.nodeId ?? existingNode.nodeId,
            longName: nodeData.longName ?? existingNode.longName,
            shortName: nodeData.shortName ?? existingNode.shortName,
            hwModel: nodeData.hwModel ?? existingNode.hwModel,
            role: nodeData.role ?? existingNode.role,
            hopsAway: nodeData.hopsAway ?? existingNode.hopsAway,
            viaMqtt: nodeData.viaMqtt ?? existingNode.viaMqtt,
            macaddr: nodeData.macaddr ?? existingNode.macaddr,
            latitude: nodeData.latitude ?? existingNode.latitude,
            longitude: nodeData.longitude ?? existingNode.longitude,
            altitude: nodeData.altitude ?? existingNode.altitude,
            batteryLevel: nodeData.batteryLevel ?? existingNode.batteryLevel,
            voltage: nodeData.voltage ?? existingNode.voltage,
            channelUtilization: nodeData.channelUtilization ?? existingNode.channelUtilization,
            airUtilTx: nodeData.airUtilTx ?? existingNode.airUtilTx,
            lastHeard: nodeData.lastHeard ?? existingNode.lastHeard,
            snr: nodeData.snr ?? existingNode.snr,
            rssi: nodeData.rssi ?? existingNode.rssi,
            firmwareVersion: nodeData.firmwareVersion ?? existingNode.firmwareVersion,
            channel: nodeData.channel ?? existingNode.channel,
            isFavorite: nodeData.isFavorite ?? existingNode.isFavorite,
            rebootCount: nodeData.rebootCount ?? existingNode.rebootCount,
            publicKey: nodeData.publicKey ?? existingNode.publicKey,
            hasPKC: nodeData.hasPKC ?? existingNode.hasPKC,
            lastPKIPacket: nodeData.lastPKIPacket ?? existingNode.lastPKIPacket,
            welcomedAt: nodeData.welcomedAt ?? existingNode.welcomedAt,
            keyIsLowEntropy: nodeData.keyIsLowEntropy ?? existingNode.keyIsLowEntropy,
            duplicateKeyDetected: nodeData.duplicateKeyDetected ?? existingNode.duplicateKeyDetected,
            keyMismatchDetected: nodeData.keyMismatchDetected ?? existingNode.keyMismatchDetected,
            keySecurityIssueDetails: nodeData.keySecurityIssueDetails ?? existingNode.keySecurityIssueDetails,
            positionChannel: nodeData.positionChannel ?? existingNode.positionChannel,
            positionPrecisionBits: nodeData.positionPrecisionBits ?? existingNode.positionPrecisionBits,
            positionTimestamp: nodeData.positionTimestamp ?? existingNode.positionTimestamp,
            updatedAt: now,
          })
          .where(eq(nodesSqlite.nodeNum, nodeData.nodeNum));
      } else if (this.isMySQL()) {
        // MySQL requires BIGINT fields to be integers (no decimals)
        const db = this.getMysqlDb();
        await db
          .update(nodesMysql)
          .set({
            nodeId: nodeData.nodeId ?? existingNode.nodeId,
            longName: nodeData.longName ?? existingNode.longName,
            shortName: nodeData.shortName ?? existingNode.shortName,
            hwModel: nodeData.hwModel ?? existingNode.hwModel,
            role: nodeData.role ?? existingNode.role,
            hopsAway: nodeData.hopsAway ?? existingNode.hopsAway,
            viaMqtt: nodeData.viaMqtt ?? existingNode.viaMqtt,
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
            rebootCount: nodeData.rebootCount ?? existingNode.rebootCount,
            publicKey: nodeData.publicKey ?? existingNode.publicKey,
            hasPKC: nodeData.hasPKC ?? existingNode.hasPKC,
            lastPKIPacket: this.coerceBigintField(nodeData.lastPKIPacket ?? existingNode.lastPKIPacket),
            welcomedAt: this.coerceBigintField(nodeData.welcomedAt ?? existingNode.welcomedAt),
            keyIsLowEntropy: nodeData.keyIsLowEntropy ?? existingNode.keyIsLowEntropy,
            duplicateKeyDetected: nodeData.duplicateKeyDetected ?? existingNode.duplicateKeyDetected,
            keyMismatchDetected: nodeData.keyMismatchDetected ?? existingNode.keyMismatchDetected,
            keySecurityIssueDetails: nodeData.keySecurityIssueDetails ?? existingNode.keySecurityIssueDetails,
            positionChannel: nodeData.positionChannel ?? existingNode.positionChannel,
            positionPrecisionBits: nodeData.positionPrecisionBits ?? existingNode.positionPrecisionBits,
            positionTimestamp: this.coerceBigintField(nodeData.positionTimestamp ?? existingNode.positionTimestamp),
            updatedAt: now,
          })
          .where(eq(nodesMysql.nodeNum, nodeData.nodeNum));
      } else {
        // PostgreSQL requires BIGINT fields to be integers (no decimals)
        const db = this.getPostgresDb();
        await db
          .update(nodesPostgres)
          .set({
            nodeId: nodeData.nodeId ?? existingNode.nodeId,
            longName: nodeData.longName ?? existingNode.longName,
            shortName: nodeData.shortName ?? existingNode.shortName,
            hwModel: nodeData.hwModel ?? existingNode.hwModel,
            role: nodeData.role ?? existingNode.role,
            hopsAway: nodeData.hopsAway ?? existingNode.hopsAway,
            viaMqtt: nodeData.viaMqtt ?? existingNode.viaMqtt,
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
            rebootCount: nodeData.rebootCount ?? existingNode.rebootCount,
            publicKey: nodeData.publicKey ?? existingNode.publicKey,
            hasPKC: nodeData.hasPKC ?? existingNode.hasPKC,
            lastPKIPacket: this.coerceBigintField(nodeData.lastPKIPacket ?? existingNode.lastPKIPacket),
            welcomedAt: this.coerceBigintField(nodeData.welcomedAt ?? existingNode.welcomedAt),
            keyIsLowEntropy: nodeData.keyIsLowEntropy ?? existingNode.keyIsLowEntropy,
            duplicateKeyDetected: nodeData.duplicateKeyDetected ?? existingNode.duplicateKeyDetected,
            keyMismatchDetected: nodeData.keyMismatchDetected ?? existingNode.keyMismatchDetected,
            keySecurityIssueDetails: nodeData.keySecurityIssueDetails ?? existingNode.keySecurityIssueDetails,
            positionChannel: nodeData.positionChannel ?? existingNode.positionChannel,
            positionPrecisionBits: nodeData.positionPrecisionBits ?? existingNode.positionPrecisionBits,
            positionTimestamp: this.coerceBigintField(nodeData.positionTimestamp ?? existingNode.positionTimestamp),
            updatedAt: now,
          })
          .where(eq(nodesPostgres.nodeNum, nodeData.nodeNum));
      }
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
      };

      if (this.isSQLite()) {
        const db = this.getSqliteDb();
        await db.insert(nodesSqlite).values(newNode);
      } else if (this.isMySQL()) {
        const db = this.getMysqlDb();
        await db.insert(nodesMysql).values(newNode);
      } else {
        const db = this.getPostgresDb();
        await db.insert(nodesPostgres).values(newNode);
      }
    }
  }

  /**
   * Generic update for a node's fields
   */
  async updateNode(nodeNum: number, updates: Partial<Omit<DbNode, 'nodeNum'>>): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(nodesSqlite)
        .set(updates as any)
        .where(eq(nodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(nodesMysql)
        .set(updates as any)
        .where(eq(nodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(nodesPostgres)
        .set(updates as any)
        .where(eq(nodesPostgres.nodeNum, nodeNum));
    }
  }

  /**
   * Update the lastMessageHops for a node
   */
  async updateNodeMessageHops(nodeNum: number, hops: number): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(nodesSqlite)
        .set({ lastMessageHops: hops, updatedAt: now })
        .where(eq(nodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(nodesMysql)
        .set({ lastMessageHops: hops, updatedAt: now })
        .where(eq(nodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(nodesPostgres)
        .set({ lastMessageHops: hops, updatedAt: now })
        .where(eq(nodesPostgres.nodeNum, nodeNum));
    }
  }

  /**
   * Mark all existing nodes as welcomed
   */
  async markAllNodesAsWelcomed(): Promise<number> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toUpdate = await db
        .select({ nodeNum: nodesSqlite.nodeNum })
        .from(nodesSqlite)
        .where(isNull(nodesSqlite.welcomedAt));

      for (const node of toUpdate) {
        await db
          .update(nodesSqlite)
          .set({ welcomedAt: now })
          .where(eq(nodesSqlite.nodeNum, node.nodeNum));
      }
      return toUpdate.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toUpdate = await db
        .select({ nodeNum: nodesMysql.nodeNum })
        .from(nodesMysql)
        .where(isNull(nodesMysql.welcomedAt));

      for (const node of toUpdate) {
        await db
          .update(nodesMysql)
          .set({ welcomedAt: now })
          .where(eq(nodesMysql.nodeNum, node.nodeNum));
      }
      return toUpdate.length;
    } else {
      const db = this.getPostgresDb();
      const toUpdate = await db
        .select({ nodeNum: nodesPostgres.nodeNum })
        .from(nodesPostgres)
        .where(isNull(nodesPostgres.welcomedAt));

      for (const node of toUpdate) {
        await db
          .update(nodesPostgres)
          .set({ welcomedAt: now })
          .where(eq(nodesPostgres.nodeNum, node.nodeNum));
      }
      return toUpdate.length;
    }
  }

  /**
   * Atomically mark a specific node as welcomed if not already welcomed
   */
  async markNodeAsWelcomedIfNotAlready(nodeNum: number, nodeId: string): Promise<boolean> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toUpdate = await db
        .select({ nodeNum: nodesSqlite.nodeNum })
        .from(nodesSqlite)
        .where(
          and(
            eq(nodesSqlite.nodeNum, nodeNum),
            eq(nodesSqlite.nodeId, nodeId),
            isNull(nodesSqlite.welcomedAt)
          )
        );

      if (toUpdate.length > 0) {
        await db
          .update(nodesSqlite)
          .set({ welcomedAt: now, updatedAt: now })
          .where(eq(nodesSqlite.nodeNum, nodeNum));
        return true;
      }
      return false;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toUpdate = await db
        .select({ nodeNum: nodesMysql.nodeNum })
        .from(nodesMysql)
        .where(
          and(
            eq(nodesMysql.nodeNum, nodeNum),
            eq(nodesMysql.nodeId, nodeId),
            isNull(nodesMysql.welcomedAt)
          )
        );

      if (toUpdate.length > 0) {
        await db
          .update(nodesMysql)
          .set({ welcomedAt: now, updatedAt: now })
          .where(eq(nodesMysql.nodeNum, nodeNum));
        return true;
      }
      return false;
    } else {
      const db = this.getPostgresDb();
      const toUpdate = await db
        .select({ nodeNum: nodesPostgres.nodeNum })
        .from(nodesPostgres)
        .where(
          and(
            eq(nodesPostgres.nodeNum, nodeNum),
            eq(nodesPostgres.nodeId, nodeId),
            isNull(nodesPostgres.welcomedAt)
          )
        );

      if (toUpdate.length > 0) {
        await db
          .update(nodesPostgres)
          .set({ welcomedAt: now, updatedAt: now })
          .where(eq(nodesPostgres.nodeNum, nodeNum));
        return true;
      }
      return false;
    }
  }

  /**
   * Get nodes with key security issues
   */
  async getNodesWithKeySecurityIssues(): Promise<DbNode[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const nodes = await db
        .select()
        .from(nodesSqlite)
        .where(
          or(
            eq(nodesSqlite.keyIsLowEntropy, true),
            eq(nodesSqlite.duplicateKeyDetected, true)
          )
        )
        .orderBy(desc(nodesSqlite.lastHeard));

      return nodes.map(n => this.normalizeBigInts(n) as DbNode);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const nodes = await db
        .select()
        .from(nodesMysql)
        .where(
          or(
            eq(nodesMysql.keyIsLowEntropy, true),
            eq(nodesMysql.duplicateKeyDetected, true)
          )
        )
        .orderBy(desc(nodesMysql.lastHeard));

      return nodes as DbNode[];
    } else {
      const db = this.getPostgresDb();
      const nodes = await db
        .select()
        .from(nodesPostgres)
        .where(
          or(
            eq(nodesPostgres.keyIsLowEntropy, true),
            eq(nodesPostgres.duplicateKeyDetected, true)
          )
        )
        .orderBy(desc(nodesPostgres.lastHeard));

      return nodes as DbNode[];
    }
  }

  /**
   * Get all nodes that have public keys
   */
  async getNodesWithPublicKeys(): Promise<Array<{ nodeNum: number; publicKey: string | null }>> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const nodes = await db
        .select({ nodeNum: nodesSqlite.nodeNum, publicKey: nodesSqlite.publicKey })
        .from(nodesSqlite)
        .where(
          and(
            isNotNull(nodesSqlite.publicKey),
            ne(nodesSqlite.publicKey, '')
          )
        );

      return nodes;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const nodes = await db
        .select({ nodeNum: nodesMysql.nodeNum, publicKey: nodesMysql.publicKey })
        .from(nodesMysql)
        .where(
          and(
            isNotNull(nodesMysql.publicKey),
            ne(nodesMysql.publicKey, '')
          )
        );

      return nodes;
    } else {
      const db = this.getPostgresDb();
      const nodes = await db
        .select({ nodeNum: nodesPostgres.nodeNum, publicKey: nodesPostgres.publicKey })
        .from(nodesPostgres)
        .where(
          and(
            isNotNull(nodesPostgres.publicKey),
            ne(nodesPostgres.publicKey, '')
          )
        );

      return nodes;
    }
  }

  /**
   * Update security flags for a node
   */
  async updateNodeSecurityFlags(
    nodeNum: number,
    duplicateKeyDetected: boolean,
    keySecurityIssueDetails?: string
  ): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(nodesSqlite)
        .set({
          duplicateKeyDetected,
          keySecurityIssueDetails: keySecurityIssueDetails ?? null,
          updatedAt: now,
        })
        .where(eq(nodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(nodesMysql)
        .set({
          duplicateKeyDetected,
          keySecurityIssueDetails: keySecurityIssueDetails ?? null,
          updatedAt: now,
        })
        .where(eq(nodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(nodesPostgres)
        .set({
          duplicateKeyDetected,
          keySecurityIssueDetails: keySecurityIssueDetails ?? null,
          updatedAt: now,
        })
        .where(eq(nodesPostgres.nodeNum, nodeNum));
    }
  }

  /**
   * Update low entropy flag for a node
   */
  async updateNodeLowEntropyFlag(
    nodeNum: number,
    keyIsLowEntropy: boolean,
    details?: string
  ): Promise<void> {
    const node = await this.getNode(nodeNum);
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

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(nodesSqlite)
        .set({
          keyIsLowEntropy,
          keySecurityIssueDetails: combinedDetails || null,
          updatedAt: now,
        })
        .where(eq(nodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(nodesMysql)
        .set({
          keyIsLowEntropy,
          keySecurityIssueDetails: combinedDetails || null,
          updatedAt: now,
        })
        .where(eq(nodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(nodesPostgres)
        .set({
          keyIsLowEntropy,
          keySecurityIssueDetails: combinedDetails || null,
          updatedAt: now,
        })
        .where(eq(nodesPostgres.nodeNum, nodeNum));
    }
  }

  /**
   * Delete a node by nodeNum
   */
  async deleteNodeRecord(nodeNum: number): Promise<boolean> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const existing = await db
        .select({ nodeNum: nodesSqlite.nodeNum })
        .from(nodesSqlite)
        .where(eq(nodesSqlite.nodeNum, nodeNum));

      if (existing.length === 0) return false;

      await db.delete(nodesSqlite).where(eq(nodesSqlite.nodeNum, nodeNum));
      return true;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const existing = await db
        .select({ nodeNum: nodesMysql.nodeNum })
        .from(nodesMysql)
        .where(eq(nodesMysql.nodeNum, nodeNum));

      if (existing.length === 0) return false;

      await db.delete(nodesMysql).where(eq(nodesMysql.nodeNum, nodeNum));
      return true;
    } else {
      const db = this.getPostgresDb();
      const existing = await db
        .select({ nodeNum: nodesPostgres.nodeNum })
        .from(nodesPostgres)
        .where(eq(nodesPostgres.nodeNum, nodeNum));

      if (existing.length === 0) return false;

      await db.delete(nodesPostgres).where(eq(nodesPostgres.nodeNum, nodeNum));
      return true;
    }
  }

  /**
   * Cleanup inactive nodes
   */
  async cleanupInactiveNodes(days: number = 30): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ nodeNum: nodesSqlite.nodeNum })
        .from(nodesSqlite)
        .where(
          or(
            lt(nodesSqlite.lastHeard, cutoff),
            isNull(nodesSqlite.lastHeard)
          )
        );

      for (const node of toDelete) {
        await db.delete(nodesSqlite).where(eq(nodesSqlite.nodeNum, node.nodeNum));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ nodeNum: nodesMysql.nodeNum })
        .from(nodesMysql)
        .where(
          or(
            lt(nodesMysql.lastHeard, cutoff),
            isNull(nodesMysql.lastHeard)
          )
        );

      for (const node of toDelete) {
        await db.delete(nodesMysql).where(eq(nodesMysql.nodeNum, node.nodeNum));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ nodeNum: nodesPostgres.nodeNum })
        .from(nodesPostgres)
        .where(
          or(
            lt(nodesPostgres.lastHeard, cutoff),
            isNull(nodesPostgres.lastHeard)
          )
        );

      for (const node of toDelete) {
        await db.delete(nodesPostgres).where(eq(nodesPostgres.nodeNum, node.nodeNum));
      }
      return toDelete.length;
    }
  }

  /**
   * Set node favorite status
   */
  async setNodeFavorite(nodeNum: number, isFavorite: boolean): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(nodesSqlite)
        .set({ isFavorite, updatedAt: now })
        .where(eq(nodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(nodesMysql)
        .set({ isFavorite, updatedAt: now })
        .where(eq(nodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(nodesPostgres)
        .set({ isFavorite, updatedAt: now })
        .where(eq(nodesPostgres.nodeNum, nodeNum));
    }
  }

  /**
   * Set node ignored status
   */
  async setNodeIgnored(nodeNum: number, isIgnored: boolean): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(nodesSqlite)
        .set({ isIgnored, updatedAt: now })
        .where(eq(nodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(nodesMysql)
        .set({ isIgnored, updatedAt: now })
        .where(eq(nodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(nodesPostgres)
        .set({ isIgnored, updatedAt: now })
        .where(eq(nodesPostgres.nodeNum, nodeNum));
    }
  }

  /**
   * Update node mobility status
   */
  async updateNodeMobility(nodeId: string, mobile: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(nodesSqlite)
        .set({ mobile })
        .where(eq(nodesSqlite.nodeId, nodeId));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(nodesMysql)
        .set({ mobile })
        .where(eq(nodesMysql.nodeId, nodeId));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(nodesPostgres)
        .set({ mobile })
        .where(eq(nodesPostgres.nodeId, nodeId));
    }
  }

  /**
   * Update last traceroute request time
   */
  async updateLastTracerouteRequest(nodeNum: number, timestamp: number): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(nodesSqlite)
        .set({ lastTracerouteRequest: timestamp, updatedAt: now })
        .where(eq(nodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(nodesMysql)
        .set({ lastTracerouteRequest: timestamp, updatedAt: now })
        .where(eq(nodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(nodesPostgres)
        .set({ lastTracerouteRequest: timestamp, updatedAt: now })
        .where(eq(nodesPostgres.nodeNum, nodeNum));
    }
  }

  /**
   * Delete inactive nodes (not heard since cutoff timestamp)
   */
  async deleteInactiveNodes(cutoffTimestamp: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ nodeNum: nodesSqlite.nodeNum })
        .from(nodesSqlite)
        .where(or(lt(nodesSqlite.lastHeard, cutoffTimestamp), isNull(nodesSqlite.lastHeard)));

      for (const node of toDelete) {
        await db.delete(nodesSqlite).where(eq(nodesSqlite.nodeNum, node.nodeNum));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ nodeNum: nodesMysql.nodeNum })
        .from(nodesMysql)
        .where(or(lt(nodesMysql.lastHeard, cutoffTimestamp), isNull(nodesMysql.lastHeard)));

      for (const node of toDelete) {
        await db.delete(nodesMysql).where(eq(nodesMysql.nodeNum, node.nodeNum));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ nodeNum: nodesPostgres.nodeNum })
        .from(nodesPostgres)
        .where(or(lt(nodesPostgres.lastHeard, cutoffTimestamp), isNull(nodesPostgres.lastHeard)));

      for (const node of toDelete) {
        await db.delete(nodesPostgres).where(eq(nodesPostgres.nodeNum, node.nodeNum));
      }
      return toDelete.length;
    }
  }

  /**
   * Delete all nodes
   */
  async deleteAllNodes(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const count = await db
        .select({ nodeNum: nodesSqlite.nodeNum })
        .from(nodesSqlite);
      await db.delete(nodesSqlite);
      return count.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const count = await db
        .select({ nodeNum: nodesMysql.nodeNum })
        .from(nodesMysql);
      await db.delete(nodesMysql);
      return count.length;
    } else {
      const db = this.getPostgresDb();
      const count = await db
        .select({ nodeNum: nodesPostgres.nodeNum })
        .from(nodesPostgres);
      await db.delete(nodesPostgres);
      return count.length;
    }
  }

  /**
   * Update node's last traceroute request timestamp
   */
  async updateNodeLastTracerouteRequest(nodeNum: number, timestamp: number): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(nodesSqlite)
        .set({ lastTracerouteRequest: timestamp })
        .where(eq(nodesSqlite.nodeNum, nodeNum));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(nodesMysql)
        .set({ lastTracerouteRequest: timestamp })
        .where(eq(nodesMysql.nodeNum, nodeNum));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(nodesPostgres)
        .set({ lastTracerouteRequest: timestamp })
        .where(eq(nodesPostgres.nodeNum, nodeNum));
    }
  }
}
