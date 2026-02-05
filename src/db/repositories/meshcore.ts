/**
 * MeshCore Repository
 *
 * Handles MeshCore node and message database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, sql, isNull } from 'drizzle-orm';
import { meshcoreNodesSqlite, meshcoreNodesPostgres, meshcoreNodesMysql } from '../schema/meshcoreNodes.js';
import { meshcoreMessagesSqlite, meshcoreMessagesPostgres, meshcoreMessagesMysql } from '../schema/meshcoreMessages.js';
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
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(meshcoreNodesSqlite)
        .orderBy(desc(meshcoreNodesSqlite.lastHeard));
      return result.map(n => this.normalizeBigInts(n) as DbMeshCoreNode);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(meshcoreNodesMysql)
        .orderBy(desc(meshcoreNodesMysql.lastHeard));
      return result as unknown as DbMeshCoreNode[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(meshcoreNodesPostgres)
        .orderBy(desc(meshcoreNodesPostgres.lastHeard));
      return result as unknown as DbMeshCoreNode[];
    }
  }

  /**
   * Get a specific node by public key
   */
  async getNodeByPublicKey(publicKey: string): Promise<DbMeshCoreNode | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(meshcoreNodesSqlite)
        .where(eq(meshcoreNodesSqlite.publicKey, publicKey))
        .limit(1);
      return result[0] ? this.normalizeBigInts(result[0]) as DbMeshCoreNode : null;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(meshcoreNodesMysql)
        .where(eq(meshcoreNodesMysql.publicKey, publicKey))
        .limit(1);
      return result[0] as unknown as DbMeshCoreNode || null;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(meshcoreNodesPostgres)
        .where(eq(meshcoreNodesPostgres.publicKey, publicKey))
        .limit(1);
      return result[0] as unknown as DbMeshCoreNode || null;
    }
  }

  /**
   * Get the local node
   */
  async getLocalNode(): Promise<DbMeshCoreNode | null> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(meshcoreNodesSqlite)
        .where(eq(meshcoreNodesSqlite.isLocalNode, true))
        .limit(1);
      return result[0] ? this.normalizeBigInts(result[0]) as DbMeshCoreNode : null;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(meshcoreNodesMysql)
        .where(eq(meshcoreNodesMysql.isLocalNode, true))
        .limit(1);
      return result[0] as unknown as DbMeshCoreNode || null;
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(meshcoreNodesPostgres)
        .where(eq(meshcoreNodesPostgres.isLocalNode, true))
        .limit(1);
      return result[0] as unknown as DbMeshCoreNode || null;
    }
  }

  /**
   * Upsert a MeshCore node (insert or update)
   */
  async upsertNode(node: Partial<DbMeshCoreNode> & { publicKey: string }): Promise<void> {
    const now = this.now();

    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const existing = await this.getNodeByPublicKey(node.publicKey);

      if (existing) {
        await db
          .update(meshcoreNodesSqlite)
          .set({ ...node, updatedAt: now })
          .where(eq(meshcoreNodesSqlite.publicKey, node.publicKey));
      } else {
        await db
          .insert(meshcoreNodesSqlite)
          .values({
            ...node,
            createdAt: now,
            updatedAt: now,
          });
      }
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const existing = await this.getNodeByPublicKey(node.publicKey);

      if (existing) {
        await db
          .update(meshcoreNodesMysql)
          .set({ ...node, updatedAt: now })
          .where(eq(meshcoreNodesMysql.publicKey, node.publicKey));
      } else {
        await db
          .insert(meshcoreNodesMysql)
          .values({
            ...node,
            createdAt: now,
            updatedAt: now,
          });
      }
    } else {
      const db = this.getPostgresDb();
      const existing = await this.getNodeByPublicKey(node.publicKey);

      if (existing) {
        await db
          .update(meshcoreNodesPostgres)
          .set({ ...node, updatedAt: now })
          .where(eq(meshcoreNodesPostgres.publicKey, node.publicKey));
      } else {
        await db
          .insert(meshcoreNodesPostgres)
          .values({
            ...node,
            createdAt: now,
            updatedAt: now,
          });
      }
    }
  }

  /**
   * Delete a node by public key
   */
  async deleteNode(publicKey: string): Promise<boolean> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(meshcoreNodesSqlite).where(eq(meshcoreNodesSqlite.publicKey, publicKey));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(meshcoreNodesMysql).where(eq(meshcoreNodesMysql.publicKey, publicKey));
    } else {
      const db = this.getPostgresDb();
      await db.delete(meshcoreNodesPostgres).where(eq(meshcoreNodesPostgres.publicKey, publicKey));
    }
    return true;
  }

  /**
   * Get node count
   */
  async getNodeCount(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.select({ count: sql<number>`COUNT(*)` }).from(meshcoreNodesSqlite);
      return Number(result[0]?.count ?? 0);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.select({ count: sql<number>`COUNT(*)` }).from(meshcoreNodesMysql);
      return Number(result[0]?.count ?? 0);
    } else {
      const db = this.getPostgresDb();
      const result = await db.select({ count: sql<number>`COUNT(*)` }).from(meshcoreNodesPostgres);
      return Number(result[0]?.count ?? 0);
    }
  }

  /**
   * Delete all nodes
   */
  async deleteAllNodes(): Promise<number> {
    const count = await this.getNodeCount();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(meshcoreNodesSqlite);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(meshcoreNodesMysql);
    } else {
      const db = this.getPostgresDb();
      await db.delete(meshcoreNodesPostgres);
    }
    return count;
  }

  // ============ Message Operations ============

  /**
   * Get recent messages
   */
  async getRecentMessages(limit: number = 50): Promise<DbMeshCoreMessage[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(meshcoreMessagesSqlite)
        .orderBy(desc(meshcoreMessagesSqlite.timestamp))
        .limit(limit);
      return result.map(m => this.normalizeBigInts(m) as DbMeshCoreMessage);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(meshcoreMessagesMysql)
        .orderBy(desc(meshcoreMessagesMysql.timestamp))
        .limit(limit);
      return result as unknown as DbMeshCoreMessage[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(meshcoreMessagesPostgres)
        .orderBy(desc(meshcoreMessagesPostgres.timestamp))
        .limit(limit);
      return result as unknown as DbMeshCoreMessage[];
    }
  }

  /**
   * Get messages for a specific conversation (to/from a public key)
   */
  async getMessagesForConversation(publicKey: string, limit: number = 50): Promise<DbMeshCoreMessage[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(meshcoreMessagesSqlite)
        .where(
          sql`${meshcoreMessagesSqlite.fromPublicKey} = ${publicKey} OR ${meshcoreMessagesSqlite.toPublicKey} = ${publicKey}`
        )
        .orderBy(desc(meshcoreMessagesSqlite.timestamp))
        .limit(limit);
      return result.map(m => this.normalizeBigInts(m) as DbMeshCoreMessage);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(meshcoreMessagesMysql)
        .where(
          sql`${meshcoreMessagesMysql.fromPublicKey} = ${publicKey} OR ${meshcoreMessagesMysql.toPublicKey} = ${publicKey}`
        )
        .orderBy(desc(meshcoreMessagesMysql.timestamp))
        .limit(limit);
      return result as unknown as DbMeshCoreMessage[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(meshcoreMessagesPostgres)
        .where(
          sql`${meshcoreMessagesPostgres.fromPublicKey} = ${publicKey} OR ${meshcoreMessagesPostgres.toPublicKey} = ${publicKey}`
        )
        .orderBy(desc(meshcoreMessagesPostgres.timestamp))
        .limit(limit);
      return result as unknown as DbMeshCoreMessage[];
    }
  }

  /**
   * Get broadcast messages (no toPublicKey)
   */
  async getBroadcastMessages(limit: number = 50): Promise<DbMeshCoreMessage[]> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db
        .select()
        .from(meshcoreMessagesSqlite)
        .where(isNull(meshcoreMessagesSqlite.toPublicKey))
        .orderBy(desc(meshcoreMessagesSqlite.timestamp))
        .limit(limit);
      return result.map(m => this.normalizeBigInts(m) as DbMeshCoreMessage);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db
        .select()
        .from(meshcoreMessagesMysql)
        .where(isNull(meshcoreMessagesMysql.toPublicKey))
        .orderBy(desc(meshcoreMessagesMysql.timestamp))
        .limit(limit);
      return result as unknown as DbMeshCoreMessage[];
    } else {
      const db = this.getPostgresDb();
      const result = await db
        .select()
        .from(meshcoreMessagesPostgres)
        .where(isNull(meshcoreMessagesPostgres.toPublicKey))
        .orderBy(desc(meshcoreMessagesPostgres.timestamp))
        .limit(limit);
      return result as unknown as DbMeshCoreMessage[];
    }
  }

  /**
   * Insert a message
   */
  async insertMessage(message: DbMeshCoreMessage): Promise<void> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.insert(meshcoreMessagesSqlite).values(message);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      // MySQL uses integer for boolean fields
      const mysqlMessage = {
        ...message,
        delivered: message.delivered ? 1 : (message.delivered === false ? 0 : null),
      };
      await db.insert(meshcoreMessagesMysql).values(mysqlMessage);
    } else {
      const db = this.getPostgresDb();
      // PostgreSQL uses integer for boolean fields in this schema
      const pgMessage = {
        ...message,
        delivered: message.delivered ? 1 : (message.delivered === false ? 0 : null),
      };
      await db.insert(meshcoreMessagesPostgres).values(pgMessage);
    }
  }

  /**
   * Mark a message as delivered
   */
  async markMessageDelivered(messageId: string): Promise<void> {
    const now = this.now();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db
        .update(meshcoreMessagesSqlite)
        .set({ delivered: true, deliveredAt: now })
        .where(eq(meshcoreMessagesSqlite.id, messageId));
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db
        .update(meshcoreMessagesMysql)
        .set({ delivered: 1, deliveredAt: now })
        .where(eq(meshcoreMessagesMysql.id, messageId));
    } else {
      const db = this.getPostgresDb();
      await db
        .update(meshcoreMessagesPostgres)
        .set({ delivered: 1, deliveredAt: now })
        .where(eq(meshcoreMessagesPostgres.id, messageId));
    }
  }

  /**
   * Get message count
   */
  async getMessageCount(): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const result = await db.select({ count: sql<number>`COUNT(*)` }).from(meshcoreMessagesSqlite);
      return Number(result[0]?.count ?? 0);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const result = await db.select({ count: sql<number>`COUNT(*)` }).from(meshcoreMessagesMysql);
      return Number(result[0]?.count ?? 0);
    } else {
      const db = this.getPostgresDb();
      const result = await db.select({ count: sql<number>`COUNT(*)` }).from(meshcoreMessagesPostgres);
      return Number(result[0]?.count ?? 0);
    }
  }

  /**
   * Delete messages older than a timestamp
   */
  async deleteMessagesOlderThan(timestamp: number): Promise<number> {
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      const toDelete = await db
        .select({ id: meshcoreMessagesSqlite.id })
        .from(meshcoreMessagesSqlite)
        .where(sql`${meshcoreMessagesSqlite.timestamp} < ${timestamp}`);

      for (const msg of toDelete) {
        await db.delete(meshcoreMessagesSqlite).where(eq(meshcoreMessagesSqlite.id, msg.id));
      }
      return toDelete.length;
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      const toDelete = await db
        .select({ id: meshcoreMessagesMysql.id })
        .from(meshcoreMessagesMysql)
        .where(sql`${meshcoreMessagesMysql.timestamp} < ${timestamp}`);

      for (const msg of toDelete) {
        await db.delete(meshcoreMessagesMysql).where(eq(meshcoreMessagesMysql.id, msg.id));
      }
      return toDelete.length;
    } else {
      const db = this.getPostgresDb();
      const toDelete = await db
        .select({ id: meshcoreMessagesPostgres.id })
        .from(meshcoreMessagesPostgres)
        .where(sql`${meshcoreMessagesPostgres.timestamp} < ${timestamp}`);

      for (const msg of toDelete) {
        await db.delete(meshcoreMessagesPostgres).where(eq(meshcoreMessagesPostgres.id, msg.id));
      }
      return toDelete.length;
    }
  }

  /**
   * Delete all messages
   */
  async deleteAllMessages(): Promise<number> {
    const count = await this.getMessageCount();
    if (this.isSQLite()) {
      const db = this.getSqliteDb();
      await db.delete(meshcoreMessagesSqlite);
    } else if (this.isMySQL()) {
      const db = this.getMysqlDb();
      await db.delete(meshcoreMessagesMysql);
    } else {
      const db = this.getPostgresDb();
      await db.delete(meshcoreMessagesPostgres);
    }
    return count;
  }
}
