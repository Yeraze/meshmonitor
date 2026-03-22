/**
 * MeshCore Repository
 *
 * Handles MeshCore node and message database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, sql, isNull } from 'drizzle-orm';
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
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .orderBy(desc(meshcoreNodes.lastHeard));
    return this.normalizeBigInts(result) as unknown as DbMeshCoreNode[];
  }

  /**
   * Get a specific node by public key
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
   * Upsert a MeshCore node (insert or update)
   */
  async upsertNode(node: Partial<DbMeshCoreNode> & { publicKey: string }): Promise<void> {
    const now = this.now();
    const { meshcoreNodes } = this.tables;
    const existing = await this.getNodeByPublicKey(node.publicKey);

    if (existing) {
      await this.db
        .update(meshcoreNodes)
        .set({ ...node, updatedAt: now })
        .where(eq(meshcoreNodes.publicKey, node.publicKey));
    } else {
      await this.db
        .insert(meshcoreNodes)
        .values({
          ...node,
          createdAt: now,
          updatedAt: now,
        });
    }
  }

  /**
   * Delete a node by public key
   */
  async deleteNode(publicKey: string): Promise<boolean> {
    const { meshcoreNodes } = this.tables;
    await this.db.delete(meshcoreNodes).where(eq(meshcoreNodes.publicKey, publicKey));
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
   * Insert a message
   */
  async insertMessage(message: DbMeshCoreMessage): Promise<void> {
    const { meshcoreMessages } = this.tables;
    await this.db.insert(meshcoreMessages).values(message);
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
      .where(sql`${meshcoreMessages.timestamp} < ${timestamp}`);

    for (const msg of toDelete) {
      await this.db.delete(meshcoreMessages).where(eq(meshcoreMessages.id, msg.id));
    }
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
