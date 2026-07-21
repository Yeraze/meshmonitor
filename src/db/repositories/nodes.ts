/**
 * Nodes Repository
 *
 * Handles all node-related database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, gt, lt, isNull, or, desc, asc, and, isNotNull, ne, sql, inArray, count, countDistinct } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase, SourceScope } from './base.js';
import { DatabaseType, DbNode } from '../types.js';
import { logger } from '../../utils/logger.js';
import { isValidNodeNum } from '../../server/constants/meshtastic.js';

/**
 * Hook for keeping an external in-memory node cache coherent with PG/MySQL writes.
 *
 * Background: DatabaseService maintains a `nodesCache` (PG/MySQL only) for sync-method
 * compatibility. The cache is loaded once at startup, but production writes flow
 * through this repository directly — bypassing the DatabaseService facade — so without
 * this hook the cache goes stale after every new node discovery (issue #2858).
 *
 * The repository fetches authoritative rows from the DB before invoking the hook so
 * the cache always reflects DB state, not the repo's pre-write inputs.
 *
 * SQLite paths skip the hook entirely (the SQLite cache is structured differently
 * and reads from DB directly).
 */
export interface NodesCacheHook {
  /** Replace or remove a single (nodeNum, sourceId) cache entry. node=null removes. */
  setNode(nodeNum: number, sourceId: string, node: DbNode | null): void;
  /** Replace all cache entries for nodeNum. Removes entries not present in `nodes`. */
  setNodeAcrossSources(nodeNum: number, nodes: DbNode[]): void;
  /** Replace all cache entries matching nodeId. Removes entries not present in `nodes`. */
  setNodeByNodeId(nodeId: string, nodes: DbNode[]): void;
  /** Clear the entire cache. */
  clear(): void;
}

/**
 * Repository for node operations
 */
export class NodesRepository extends BaseRepository {
  private cacheHook: NodesCacheHook | null = null;

  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Register a cache hook to be notified of node writes (PG/MySQL only).
   * Pass null to detach. See {@link NodesCacheHook} for semantics.
   */
  setCacheHook(hook: NodesCacheHook | null): void {
    this.cacheHook = hook;
  }

  private cacheEnabled(): boolean {
    return this.cacheHook !== null && (this.dbType === 'postgres' || this.dbType === 'mysql');
  }

  private async syncCacheNode(nodeNum: number, sourceId: string): Promise<void> {
    if (!this.cacheEnabled()) return;
    try {
      const fresh = await this.getNode(nodeNum, sourceId);
      this.cacheHook!.setNode(nodeNum, sourceId, fresh);
    } catch (err) {
      logger.error('NodesRepository cache sync (single) failed:', err);
    }
  }

  private async syncCacheAcrossSources(nodeNum: number): Promise<void> {
    if (!this.cacheEnabled()) return;
    try {
      const { nodes } = this.tables;
      const rows = await this.db.select().from(nodes).where(eq(nodes.nodeNum, nodeNum));
      const fresh = (this.normalizeBigInts(rows) ?? []) as DbNode[];
      this.cacheHook!.setNodeAcrossSources(nodeNum, fresh);
    } catch (err) {
      logger.error('NodesRepository cache sync (cross-source) failed:', err);
    }
  }

  private async syncCacheByNodeId(nodeId: string): Promise<void> {
    if (!this.cacheEnabled()) return;
    try {
      const { nodes } = this.tables;
      const rows = await this.db.select().from(nodes).where(eq(nodes.nodeId, nodeId));
      const fresh = (this.normalizeBigInts(rows) ?? []) as DbNode[];
      this.cacheHook!.setNodeByNodeId(nodeId, fresh);
    } catch (err) {
      logger.error('NodesRepository cache sync (by-nodeId) failed:', err);
    }
  }

  private removeCacheNode(nodeNum: number, sourceId: string): void {
    if (!this.cacheEnabled()) return;
    try {
      this.cacheHook!.setNode(nodeNum, sourceId, null);
    } catch (err) {
      logger.error('NodesRepository cache remove failed:', err);
    }
  }

  private clearCacheAll(): void {
    if (!this.cacheEnabled()) return;
    try {
      this.cacheHook!.clear();
    } catch (err) {
      logger.error('NodesRepository cache clear failed:', err);
    }
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
    if (!isValidNodeNum(nodeNum)) {
      // Defensive guard: PG `bigint` rejects out-of-range JS numbers with
      // `invalid input syntax for type bigint` (issue #3186). Treat the
      // value as "no such node" rather than crashing the query.
      logger.warn(`NodesRepository.getNode: rejecting out-of-range nodeNum ${nodeNum}`);
      return null;
    }
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
  async getNodesByNums(nodeNums: number[], sourceId?: string): Promise<Map<number, DbNode>> {
    if (nodeNums.length === 0) return new Map();
    // Filter out-of-range values up front (issue #3186) — one bad entry would
    // otherwise fail the whole batch query against a PG `bigint` column.
    const validNums = nodeNums.filter((n) => {
      if (isValidNodeNum(n)) return true;
      logger.warn(`NodesRepository.getNodesByNums: dropping out-of-range nodeNum ${n}`);
      return false;
    });
    if (validNums.length === 0) return new Map();

    const { nodes } = this.tables;
    const whereClause = sourceId
      ? and(inArray(nodes.nodeNum, validNums), eq(nodes.sourceId, sourceId))
      : inArray(nodes.nodeNum, validNums);
    const result = await this.db
      .select()
      .from(nodes)
      .where(whereClause);

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
   * Get a node by its 32-byte public key (base64-encoded), optionally scoped
   * to a source. Used by request-routing helpers to resolve a 64-hex-char
   * public-key destination to the node's `nodeNum` so the protocol-level
   * 32-bit address can be used for sending. See `parseDestinationNum`.
   *
   * The repository stores publicKey as base64. Callers passing a hex string
   * should convert via `Buffer.from(hex, 'hex').toString('base64')` first.
   */
  async getNodeByPublicKey(publicKey: string, sourceId?: string): Promise<DbNode | null> {
    if (!publicKey) return null;
    const { nodes } = this.tables;
    const whereClause = sourceId
      ? and(eq(nodes.publicKey, publicKey), eq(nodes.sourceId, sourceId))
      : eq(nodes.publicKey, publicKey);
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
  async getAllNodes(sourceId: SourceScope): Promise<DbNode[]> {
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
  async getActiveNodes(sinceDays: number = 7, sourceId?: SourceScope): Promise<DbNode[]> {
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
  async getNodeCount(sourceId: SourceScope): Promise<number> {
    const { nodes } = this.tables;
    const result = await this.db.select({ count: count() }).from(nodes)
      .where(this.withSourceScope(nodes, sourceId));
    return Number(result[0].count);
  }

  /**
   * Count nodes whose `lastHeard` falls within the given window (default 2h).
   *
   * Powers the per-source "node activity" badge in the dashboard sidebar so
   * users can tell at a glance whether a source is hearing live mesh traffic
   * even when the gateway link itself is up (issue #2883). The link-state
   * badge only reflects MeshMonitor↔gateway TCP/serial; this complements it
   * with mesh-level liveness.
   *
   * `lastHeard` is stored in seconds (Unix epoch). Returns 0 for a source
   * with no recently-heard nodes.
   */
  async getActiveNodeCount(sourceId: SourceScope, sinceSeconds: number = 7200): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds;
    const { nodes } = this.tables;
    const result = await this.db
      .select({ count: count() })
      .from(nodes)
      .where(and(gt(nodes.lastHeard, cutoff), this.withSourceScope(nodes, sourceId)));
    return Number(result[0].count);
  }

  /**
   * Count distinct nodeNums across the given source IDs.
   *
   * Used by the Unified source card so the displayed count reflects the
   * deduped merged view (a node present in multiple sources counts once),
   * matching what the user sees when Unified is selected. The previous
   * fallback summed per-source counts, which over-counted shared nodes and
   * made the Unified count drift as the user clicked between sources
   * (issue #2805).
   *
   * Returns 0 when sourceIds is empty.
   */
  async getDistinctNodeCount(sourceIds: string[]): Promise<number> {
    if (sourceIds.length === 0) return 0;
    const { nodes } = this.tables;
    const result = await this.db
      .select({ count: countDistinct(nodes.nodeNum) })
      .from(nodes)
      .where(inArray(nodes.sourceId, sourceIds));
    return Number(result[0].count);
  }

  /**
   * Count distinct nodeNums heard within the window across the given source
   * IDs. Powers the Unified card's node-activity badge (issue #2883) so a
   * single deduped active count is shown across the whole fleet, matching
   * the deduped total. Returns 0 when sourceIds is empty.
   */
  async getDistinctActiveNodeCount(sourceIds: string[], sinceSeconds: number = 7200): Promise<number> {
    if (sourceIds.length === 0) return 0;
    const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds;
    const { nodes } = this.tables;
    const result = await this.db
      .select({ count: countDistinct(nodes.nodeNum) })
      .from(nodes)
      .where(and(inArray(nodes.sourceId, sourceIds), gt(nodes.lastHeard, cutoff)));
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
    // If the caller omits the sourceId arg but the node object itself carries a sourceId
    // (e.g. cached node objects produced by DatabaseService), prefer that over 'default' —
    // otherwise we'd silently insert a stray 'default' row and lose the update on the
    // real source row (see issue #2902).
    const effectiveSourceId = sourceId ?? (nodeData as { sourceId?: string }).sourceId ?? 'default';

    const now = this.now();
    const { nodes } = this.tables;
    const existingNode = await this.getNode(nodeData.nodeNum, effectiveSourceId);

    if (existingNode) {
      // Treat '' (and null/undefined) as "not provided" for string identity
      // fields, so a blank incoming name/macaddr preserves the stored value
      // instead of clobbering it (#3456/#3505).
      const nameOrExisting = (incoming: any, existing: any) =>
        (incoming === null || incoming === undefined || incoming === '') ? existing : incoming;
      // Update existing node - coerceBigintField is safe for all dialects (just Math.floor)
      await this.db
        .update(nodes)
        .set({
          nodeId: nodeData.nodeId ?? existingNode.nodeId,
          // String identity fields: '' means "blank / not reported", not "clear" —
          // preserve a learned value rather than clobber it (#3456/#3505).
          longName: nameOrExisting(nodeData.longName, existingNode.longName),
          shortName: nameOrExisting(nodeData.shortName, existingNode.shortName),
          // hwModel 0 = HardwareModel.UNSET (unknown) — keep a known model.
          hwModel: (nodeData.hwModel === null || nodeData.hwModel === undefined || nodeData.hwModel === 0)
            ? existingNode.hwModel : nodeData.hwModel,
          role: nodeData.role ?? existingNode.role,
          hopsAway: nodeData.hopsAway ?? existingNode.hopsAway,
          viaMqtt: nodeData.viaMqtt ?? existingNode.viaMqtt,
          transportMechanism: nodeData.transportMechanism ?? existingNode.transportMechanism,
          // #4240: per-transport last-seen stamps. Each carries forward
          // independently, so an MQTT echo advances only transportLastMqtt and
          // cannot erase the node's RF history. Staleness is applied at read
          // time against the user's active window, so these never need sweeping.
          transportLastRf: nodeData.transportLastRf ?? existingNode.transportLastRf,
          transportLastMqtt: nodeData.transportLastMqtt ?? existingNode.transportLastMqtt,
          transportLastUdp: nodeData.transportLastUdp ?? existingNode.transportLastUdp,
          isStoreForwardServer: nodeData.isStoreForwardServer ?? existingNode.isStoreForwardServer,
          macaddr: nameOrExisting(nodeData.macaddr, existingNode.macaddr),
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
          isFavorite: existingNode.favoriteLocked
            ? existingNode.isFavorite
            : (nodeData.isFavorite ?? existingNode.isFavorite),
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
          positionLocationSource: nodeData.positionLocationSource ?? existingNode.positionLocationSource,
          positionTimestamp: this.coerceBigintField(nodeData.positionTimestamp ?? existingNode.positionTimestamp),
          positionOverrideEnabled: nodeData.positionOverrideEnabled ?? existingNode.positionOverrideEnabled,
          latitudeOverride: nodeData.latitudeOverride ?? existingNode.latitudeOverride,
          longitudeOverride: nodeData.longitudeOverride ?? existingNode.longitudeOverride,
          altitudeOverride: nodeData.altitudeOverride ?? existingNode.altitudeOverride,
          positionOverrideIsPrivate: nodeData.positionOverrideIsPrivate ?? existingNode.positionOverrideIsPrivate,
          // #3549: preserve the user's "Hide from Map" toggle across packet-driven updates
          hideFromMap: nodeData.hideFromMap ?? existingNode.hideFromMap,
          // #3921: preserve the user's free-text notes across packet-driven updates
          notes: nodeData.notes ?? existingNode.notes,
          // #3684: User capability flags from NodeInfo (preserve prior value if not present)
          isUnmessagable: nodeData.isUnmessagable ?? existingNode.isUnmessagable,
          isLicensed: nodeData.isLicensed ?? existingNode.isLicensed,
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
        transportMechanism: nodeData.transportMechanism ?? null,
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
        positionLocationSource: nodeData.positionLocationSource ?? null,
        positionTimestamp: this.coerceBigintField(nodeData.positionTimestamp),
        positionOverrideEnabled: nodeData.positionOverrideEnabled ?? false,
        latitudeOverride: nodeData.latitudeOverride ?? null,
        longitudeOverride: nodeData.longitudeOverride ?? null,
        altitudeOverride: nodeData.altitudeOverride ?? null,
        positionOverrideIsPrivate: nodeData.positionOverrideIsPrivate ?? false,
        hideFromMap: nodeData.hideFromMap ?? false,
        notes: nodeData.notes ?? null,
        isUnmessagable: nodeData.isUnmessagable ?? false,
        isLicensed: nodeData.isLicensed ?? false,
        createdAt: now,
        updatedAt: now,
      } as any;

      // Only set sourceId on INSERT — once a node is associated with a source,
      // that association must not be overwritten by subsequent upserts.
      newNode.sourceId = effectiveSourceId;

      // All databases use atomic upsert to prevent race conditions where
      // concurrent getNode() calls both return null and then both try to INSERT.
      // For string identity fields a blank '' is normalized to null (matching the
      // rest of the codebase) so a blank never persists as '' on the conflict
      // DO-UPDATE; hwModel 0 (UNSET) likewise → null (#3505). This is the
      // insert/first-seen path, so there's no prior value to preserve here.
      const blankToNull = (v: any) => (v === '' || v === null || v === undefined) ? null : v;
      const upsertSet = {
        nodeId: nodeData.nodeId,
        longName: blankToNull(nodeData.longName),
        shortName: blankToNull(nodeData.shortName),
        hwModel: (nodeData.hwModel === 0 || nodeData.hwModel === null || nodeData.hwModel === undefined) ? null : nodeData.hwModel,
        role: nodeData.role ?? null,
        hopsAway: nodeData.hopsAway ?? null,
        viaMqtt: nodeData.viaMqtt ?? null,
        transportMechanism: nodeData.transportMechanism ?? null,
        isStoreForwardServer: nodeData.isStoreForwardServer ?? null,
        macaddr: blankToNull(nodeData.macaddr),
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
        positionLocationSource: nodeData.positionLocationSource ?? null,
        positionTimestamp: this.coerceBigintField(nodeData.positionTimestamp),
        positionOverrideEnabled: nodeData.positionOverrideEnabled ?? false,
        latitudeOverride: nodeData.latitudeOverride ?? null,
        longitudeOverride: nodeData.longitudeOverride ?? null,
        altitudeOverride: nodeData.altitudeOverride ?? null,
        positionOverrideIsPrivate: nodeData.positionOverrideIsPrivate ?? false,
        hideFromMap: nodeData.hideFromMap ?? false,
        // Note: notes is intentionally NOT included here (#3921) — like mobile,
        // it's a user-authored value that must never be clobbered on a
        // packet-driven upsert conflict. It is only written by setNodeNotes.
        isUnmessagable: nodeData.isUnmessagable ?? false,
        isLicensed: nodeData.isLicensed ?? false,
        updatedAt: now,
      };

      await this.upsert(nodes, newNode, [nodes.nodeNum, nodes.sourceId], upsertSet);
    }

    await this.syncCacheNode(nodeData.nodeNum, effectiveSourceId);
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

    await this.syncCacheAcrossSources(nodeNum);
  }

  /**
   * Set `hideFromMap` on EVERY row for this nodeNum, regardless of sourceId
   * (issue #4137). The per-source setNodeHideFromMapAsync (database.ts) only
   * flips the row for one sourceId; since mergeNodesAcrossSources now ORs
   * hideFromMap across sources (hidden-anywhere -> hidden), un-hiding from a
   * unified/cross-source view has to clear every source's row, or a stale
   * `true` on another source's row keeps the node hidden forever.
   *
   * Returns the number of rows affected (cheap: driven by a row count select,
   * not a database-specific affected-rows API — those differ across
   * SQLite/PostgreSQL/MySQL drivers).
   */
  async setNodeHideFromMapAllSourcesAsync(nodeNum: number, hidden: boolean): Promise<number> {
    const { nodes } = this.tables;

    const existing = await this.db
      .select({ sourceId: nodes.sourceId })
      .from(nodes)
      .where(eq(nodes.nodeNum, nodeNum));
    const affected = existing.length;

    if (affected > 0) {
      // Reuses updateNode's cross-source update + cache sync (avoids a second
      // `.set(... as any)` site — Drizzle's update-builder typing needs the
      // cast, and updateNode already carries it).
      await this.updateNode(nodeNum, { hideFromMap: hidden, updatedAt: this.now() });
    }

    return affected;
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

    await this.syncCacheNode(nodeNum, sourceId);
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
        .where(sourceId
          ? and(eq(nodes.nodeNum, node.nodeNum), eq(nodes.sourceId, sourceId))
          : eq(nodes.nodeNum, node.nodeNum));
      await this.syncCacheAcrossSources(node.nodeNum);
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
      await this.syncCacheNode(nodeNum, sourceId);
      return true;
    }
    return false;
  }

  /**
   * Delete nodes for a source whose last-known position is outside the given
   * bbox. Nodes with no recorded position (latitude/longitude null) are NOT
   * deleted — we have no evidence they're outside.
   *
   * Used by the "Prune Outside ROI" kebab action on mqtt_bridge sources to
   * clean up rows that were ingested before the current geo filter was
   * configured. New traffic is gated by MqttPacketFilter.postFilterPosition
   * at ingestion time; this method handles the legacy cleanup.
   *
   * Returns the number of node rows actually deleted.
   *
   * @param sourceId  Mandatory — never prune across sources.
   * @param bbox      Inclusive bounds; any axis may be undefined (no bound on
   *                  that side). A node is "outside" if it violates *any*
   *                  defined bound.
   */
  async pruneNodesOutsideBbox(
    sourceId: string,
    bbox: { minLat?: number; maxLat?: number; minLng?: number; maxLng?: number },
  ): Promise<number> {
    const { nodes } = this.tables;
    const outsideTerms = [];
    if (typeof bbox.minLat === 'number') outsideTerms.push(lt(nodes.latitude, bbox.minLat));
    if (typeof bbox.maxLat === 'number') outsideTerms.push(gt(nodes.latitude, bbox.maxLat));
    if (typeof bbox.minLng === 'number') outsideTerms.push(lt(nodes.longitude, bbox.minLng));
    if (typeof bbox.maxLng === 'number') outsideTerms.push(gt(nodes.longitude, bbox.maxLng));
    // No bounds → no-op. Caller should validate this earlier and return 400,
    // but be defensive here so a misconfigured row doesn't wipe the source.
    if (outsideTerms.length === 0) return 0;

    const whereClause = and(
      eq(nodes.sourceId, sourceId),
      isNotNull(nodes.latitude),
      isNotNull(nodes.longitude),
      or(...outsideTerms),
    );

    // Collect nodeNums first so we can invalidate cache entries. Drizzle's
    // `.delete().returning()` works on PG/SQLite but not MySQL, so do a
    // SELECT-then-DELETE to keep the path uniform across backends.
    const toDelete = await this.db
      .select({ nodeNum: nodes.nodeNum })
      .from(nodes)
      .where(whereClause);
    if (toDelete.length === 0) return 0;

    await this.db.delete(nodes).where(whereClause);

    for (const row of toDelete) {
      await this.syncCacheNode(Number(row.nodeNum), sourceId);
    }

    return toDelete.length;
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
  async getNodesWithPublicKeys(sourceId?: SourceScope): Promise<Array<{ nodeNum: number; publicKey: string | null }>> {
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

    await this.syncCacheNode(nodeNum, sourceId);
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

    await this.syncCacheNode(nodeNum, sourceId);
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

    this.removeCacheNode(nodeNum, sourceId);
    return true;
  }

  /**
   * Cleanup inactive nodes
   */
  async cleanupInactiveNodes(days: number = 30): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);
    const { nodes } = this.tables;

    const toDelete = await this.db
      .select({ nodeNum: nodes.nodeNum, sourceId: nodes.sourceId })
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
      this.removeCacheNode(node.nodeNum, node.sourceId);
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

    await this.syncCacheNode(nodeNum, sourceId);
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

    await this.syncCacheNode(nodeNum, sourceId);
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

    await this.syncCacheNode(nodeNum, sourceId);
  }

  /**
   * Set the free-text per-node notes field (issue #3921), scoped to sourceId.
   * MeshMonitor-local annotation — never synced to the mesh. An empty string
   * clears the note.
   */
  async setNodeNotes(nodeNum: number, notes: string, sourceId: string): Promise<void> {
    const now = this.now();
    const { nodes } = this.tables;

    await this.db
      .update(nodes)
      .set({ notes, updatedAt: now })
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));

    await this.syncCacheNode(nodeNum, sourceId);
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

    await this.syncCacheByNodeId(nodeId);
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

    await this.syncCacheAcrossSources(nodeNum);
  }

  /**
   * Delete inactive nodes (not heard since cutoff timestamp)
   */
  async deleteInactiveNodes(cutoffTimestamp: number): Promise<number> {
    const { nodes } = this.tables;
    const toDelete = await this.db
      .select({ nodeNum: nodes.nodeNum, sourceId: nodes.sourceId })
      .from(nodes)
      .where(
        and(
          or(lt(nodes.lastHeard, cutoffTimestamp), isNull(nodes.lastHeard)),
          or(eq(nodes.isIgnored, false), isNull(nodes.isIgnored))
        )
      );

    for (const node of toDelete) {
      await this.db.delete(nodes).where(eq(nodes.nodeNum, node.nodeNum));
      this.removeCacheNode(node.nodeNum, node.sourceId);
    }
    return toDelete.length;
  }

  /**
   * Delete all nodes, optionally scoped to a single source.
   */
  async deleteAllNodes(sourceId?: string): Promise<number> {
    const { nodes } = this.tables;
    const baseSelect = this.db.select({ nodeNum: nodes.nodeNum }).from(nodes);
    const result = await (sourceId
      ? baseSelect.where(eq(nodes.sourceId, sourceId))
      : baseSelect);
    if (sourceId) {
      await this.db.delete(nodes).where(eq(nodes.sourceId, sourceId));
    } else {
      await this.db.delete(nodes);
    }
    this.clearCacheAll();
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

    await this.syncCacheNode(nodeNum, sourceId);
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
   * Prioritizes nearby nodes: orders by hopsAway ASC (NULLs last), then lastHeard DESC.
   * Without this priority, MQTT-flooded distant nodes can starve close-by admin scans.
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
      .orderBy(sql`${nodes.hopsAway} IS NULL`, asc(nodes.hopsAway), desc(nodes.lastHeard))
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

    await this.syncCacheNode(nodeNum, sourceId);
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

    await this.syncCacheNode(nodeNum, sourceId);
  }

  /**
   * Update spam detection flags for a node, scoped per-source (Drizzle, all backends).
   * Used by DatabaseService.updateNodeSpamFlagsAsync for PG/MySQL paths.
   */
  async updateNodeExcessivePacketsAsync(
    nodeNum: number,
    isExcessivePackets: boolean,
    packetRatePerHour: number,
    lastChecked: number,
    sourceId: string
  ): Promise<void> {
    const now = Date.now();
    const { nodes } = this.tables;
    await this.db
      .update(nodes)
      .set({
        isExcessivePackets,
        packetRatePerHour,
        packetRateLastChecked: lastChecked,
        updatedAt: now,
      } as any)
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));

    await this.syncCacheNode(nodeNum, sourceId);
  }

  /**
   * Update time offset detection flags for a node, scoped per-source (Drizzle, all backends).
   * Used by DatabaseService.updateNodeTimeOffsetFlagsAsync for PG/MySQL paths.
   */
  async updateNodeTimeOffsetAsync(
    nodeNum: number,
    isTimeOffsetIssue: boolean,
    timeOffsetSeconds: number | null,
    sourceId: string
  ): Promise<void> {
    const now = Date.now();
    const { nodes } = this.tables;
    await this.db
      .update(nodes)
      .set({
        isTimeOffsetIssue,
        timeOffsetSeconds,
        updatedAt: now,
      } as any)
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)));

    await this.syncCacheNode(nodeNum, sourceId);
  }

  /**
   * Delete inactive nodes for a specific source (Drizzle, all backends).
   * Returns the count of rows deleted. Mirrors deleteInactiveNodesForSourceSqlite,
   * but works on Postgres/MySQL via Drizzle's async delete builder.
   */
  async cleanupInactiveNodesForSourceAsync(days: number, sourceId: string): Promise<number> {
    const cutoff = this.now() - (days * 24 * 60 * 60 * 1000);
    const { nodes } = this.tables;

    // Pre-count rows that will match so we can return an accurate affected count
    // across all backends (the per-driver result shape varies for delete()).
    const matching = await this.db
      .select({ nodeNum: nodes.nodeNum })
      .from(nodes)
      .where(and(lt(nodes.lastHeard, cutoff), eq(nodes.sourceId, sourceId)));

    if (matching.length === 0) return 0;

    await this.db
      .delete(nodes)
      .where(and(lt(nodes.lastHeard, cutoff), eq(nodes.sourceId, sourceId)));

    for (const row of matching) {
      this.removeCacheNode(row.nodeNum, sourceId);
    }

    return matching.length;
  }

  // ===========================================================================
  // SQLite-only synchronous variants (for legacy sync facade delegations)
  // These mirror the async versions above but run on better-sqlite3 synchronously
  // so callers on DatabaseService can keep non-async signatures.
  // ===========================================================================

  /**
   * SQLite-only synchronous getNode (legacy sync facade).
   */
  getNodeSqlite(nodeNum: number, sourceId?: string): DbNode | null {
    if (!this.sqliteDb) throw new Error('getNodeSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    const where = sourceId
      ? and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId))
      : eq(nodes.nodeNum, nodeNum);
    const rows = db.select().from(nodes).where(where).limit(1).all();
    if (rows.length === 0) return null;
    return this.normalizeBigInts(rows[0]) as DbNode;
  }







  /**
   * SQLite-only sync getNodesWithKeySecurityIssues.
   */
  getNodesWithKeySecurityIssuesSqlite(sourceId?: string): DbNode[] {
    if (!this.sqliteDb) throw new Error('getNodesWithKeySecurityIssuesSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    const keyFilter = or(eq(nodes.keyIsLowEntropy, true), eq(nodes.duplicateKeyDetected, true));
    const where = sourceId ? and(keyFilter, eq(nodes.sourceId, sourceId)) : keyFilter;
    const rows = db.select().from(nodes).where(where).orderBy(desc(nodes.lastHeard)).all();
    return rows.map((r: any) => this.normalizeBigInts(r)) as DbNode[];
  }




  /**
   * SQLite-only sync updateNodeSpamFlags.
   */
  updateNodeSpamFlagsSqlite(nodeNum: number, isExcessivePackets: boolean, packetRatePerHour: number, lastChecked: number, sourceId: string): void {
    if (!this.sqliteDb) throw new Error('updateNodeSpamFlagsSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    const now = Date.now();
    db.update(nodes)
      .set({
        isExcessivePackets,
        packetRatePerHour,
        packetRateLastChecked: lastChecked,
        updatedAt: now,
      } as any)
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)))
      .run();
  }

  /**
   * SQLite-only sync getNodesWithExcessivePackets.
   */
  getNodesWithExcessivePacketsSqlite(sourceId?: string): DbNode[] {
    if (!this.sqliteDb) throw new Error('getNodesWithExcessivePacketsSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    const where = sourceId
      ? and(eq((nodes as any).isExcessivePackets, true), eq(nodes.sourceId, sourceId))
      : eq((nodes as any).isExcessivePackets, true);
    const rows = db.select().from(nodes).where(where).all();
    return rows.map((r: any) => this.normalizeBigInts(r)) as DbNode[];
  }

  /**
   * SQLite-only sync updateNodeTimeOffsetFlags.
   */
  updateNodeTimeOffsetFlagsSqlite(nodeNum: number, isTimeOffsetIssue: boolean, timeOffsetSeconds: number | null, sourceId: string): void {
    if (!this.sqliteDb) throw new Error('updateNodeTimeOffsetFlagsSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    const now = Date.now();
    db.update(nodes)
      .set({ isTimeOffsetIssue, timeOffsetSeconds, updatedAt: now } as any)
      .where(and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId)))
      .run();
  }

  /**
   * SQLite-only sync getNodesWithTimeOffsetIssues.
   */
  getNodesWithTimeOffsetIssuesSqlite(sourceId?: string): DbNode[] {
    if (!this.sqliteDb) throw new Error('getNodesWithTimeOffsetIssuesSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    const where = sourceId
      ? and(eq((nodes as any).isTimeOffsetIssue, true), eq(nodes.sourceId, sourceId))
      : eq((nodes as any).isTimeOffsetIssue, true);
    const rows = db.select().from(nodes).where(where).all();
    return rows.map((r: any) => this.normalizeBigInts(r)) as DbNode[];
  }



  /**
   * SQLite-only sync update of lastTracerouteRequest column on nodes.
   * Scoped per-source when sourceId is provided.
   */
  updateNodeLastTracerouteRequestSqlite(nodeNum: number, timestamp: number, sourceId?: string): void {
    if (!this.sqliteDb) throw new Error('updateNodeLastTracerouteRequestSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    const whereExpr = sourceId
      ? and(eq(nodes.nodeNum, nodeNum), eq(nodes.sourceId, sourceId))
      : eq(nodes.nodeNum, nodeNum);
    db.update(nodes)
      .set({ lastTracerouteRequest: timestamp })
      .where(whereExpr)
      .run();
  }

  /**
   * SQLite-only sync delete inactive nodes scoped per-source (no isIgnored filter —
   * this is the per-source cleanup path used by cleanupInactiveNodesAsync).
   */
  deleteInactiveNodesForSourceSqlite(cutoffMs: number, sourceId: string): number {
    if (!this.sqliteDb) throw new Error('deleteInactiveNodesForSourceSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    const result: any = db.delete(nodes)
      .where(and(lt(nodes.lastHeard, cutoffMs), eq(nodes.sourceId, sourceId)))
      .run();
    return Number(result?.changes ?? 0);
  }






  /**
   * SQLite-only sync delete all nodes (used by importData / purgeAllNodes),
   * optionally scoped to a single source.
   */
  truncateNodesSqlite(sourceId?: string): void {
    if (!this.sqliteDb) throw new Error('truncateNodesSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    if (sourceId) {
      db.delete(nodes).where(eq(nodes.sourceId, sourceId)).run();
    } else {
      db.delete(nodes).run();
    }
  }

  /**
   * SQLite-only sync bulk insert for importData.
   */
  importNodeSqlite(node: DbNode): void {
    if (!this.sqliteDb) throw new Error('importNodeSqlite is SQLite-only');
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    db.insert(nodes).values({
      nodeNum: node.nodeNum,
      nodeId: node.nodeId,
      longName: node.longName ?? null,
      shortName: node.shortName ?? null,
      hwModel: node.hwModel ?? null,
      macaddr: node.macaddr ?? null,
      latitude: node.latitude ?? null,
      longitude: node.longitude ?? null,
      altitude: node.altitude ?? null,
      batteryLevel: node.batteryLevel ?? null,
      voltage: node.voltage ?? null,
      channelUtilization: node.channelUtilization ?? null,
      airUtilTx: node.airUtilTx ?? null,
      lastHeard: node.lastHeard ?? null,
      snr: node.snr ?? null,
      rssi: node.rssi ?? null,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    } as any).run();
  }

  /**
   * SQLite-only sync upsertNode mirroring the legacy raw-SQL facade path.
   * When a row already exists, fields are merged with COALESCE-style semantics
   * (undefined / null = keep existing). On insert the row is persisted with
   * the supplied source scope (defaults to 'default').
   */
  upsertNodeSqlite(nodeData: Partial<DbNode>, wasIgnored: boolean = false): void {
    if (!this.sqliteDb) throw new Error('upsertNodeSqlite is SQLite-only');
    if (nodeData.nodeNum === undefined || nodeData.nodeNum === null || !nodeData.nodeId) {
      logger.error('Cannot upsert node: missing nodeNum or nodeId');
      return;
    }
    const db = this.sqliteDb;
    const { nodes } = this.tables;
    const now = Date.now();
    const upsertSourceId = (nodeData as any).sourceId as string | undefined;
    const existing = this.getNodeSqlite(nodeData.nodeNum, upsertSourceId);

    if (existing) {
      // Build COALESCE-style update: pass null to keep existing, value to override
      const updateSet: Record<string, any> = { updatedAt: now };
      const setIfProvided = (key: keyof DbNode, value: any) => {
        if (value !== null && value !== undefined) {
          updateSet[key as string] = value;
        }
      };
      // For string identity fields an empty string means "blank / not reported",
      // not "clear the value" — preserve a previously-learned name/macaddr rather
      // than clobber it (the durable form of the #3456 fix; see #3505). Genuine
      // numerics below still write 0 via setIfProvided (0 snr/battery/lat-lon are
      // legitimate).
      const setIfNonBlank = (key: keyof DbNode, value: any) => {
        if (value !== null && value !== undefined && value !== '') {
          updateSet[key as string] = value;
        }
      };
      setIfProvided('nodeId', nodeData.nodeId);
      setIfNonBlank('longName', nodeData.longName);
      setIfNonBlank('shortName', nodeData.shortName);
      // hwModel 0 = HardwareModel.UNSET (unknown) — keep a known model.
      if (nodeData.hwModel !== null && nodeData.hwModel !== undefined && nodeData.hwModel !== 0) {
        updateSet.hwModel = nodeData.hwModel;
      }
      setIfProvided('role', nodeData.role);
      setIfProvided('hopsAway', nodeData.hopsAway);
      if (nodeData.viaMqtt !== undefined) updateSet.viaMqtt = nodeData.viaMqtt;
      if (nodeData.transportMechanism !== undefined) updateSet.transportMechanism = nodeData.transportMechanism;
      setIfNonBlank('macaddr', nodeData.macaddr);
      setIfProvided('latitude', nodeData.latitude);
      setIfProvided('longitude', nodeData.longitude);
      setIfProvided('altitude', nodeData.altitude);
      setIfProvided('batteryLevel', nodeData.batteryLevel);
      setIfProvided('voltage', nodeData.voltage);
      setIfProvided('channelUtilization', nodeData.channelUtilization);
      setIfProvided('airUtilTx', nodeData.airUtilTx);
      setIfProvided('lastHeard', nodeData.lastHeard);
      setIfProvided('snr', nodeData.snr);
      setIfProvided('rssi', nodeData.rssi);
      if (nodeData.firmwareVersion) updateSet.firmwareVersion = nodeData.firmwareVersion;
      if (nodeData.channel !== undefined) updateSet.channel = nodeData.channel;
      if (nodeData.isFavorite !== undefined) updateSet.isFavorite = !!nodeData.isFavorite;
      if (nodeData.rebootCount !== undefined) updateSet.rebootCount = nodeData.rebootCount;
      if (nodeData.publicKey) updateSet.publicKey = nodeData.publicKey;
      if (nodeData.hasPKC !== undefined) updateSet.hasPKC = !!nodeData.hasPKC;
      if (nodeData.lastPKIPacket !== undefined) updateSet.lastPKIPacket = nodeData.lastPKIPacket;
      if (nodeData.welcomedAt !== undefined) updateSet.welcomedAt = nodeData.welcomedAt;
      if (nodeData.keyIsLowEntropy !== undefined) updateSet.keyIsLowEntropy = !!nodeData.keyIsLowEntropy;
      if (nodeData.duplicateKeyDetected !== undefined) updateSet.duplicateKeyDetected = !!nodeData.duplicateKeyDetected;
      if (nodeData.keyMismatchDetected !== undefined) updateSet.keyMismatchDetected = !!nodeData.keyMismatchDetected;
      // Special: explicit empty-string clears, not-in-object keeps existing
      if ('keySecurityIssueDetails' in nodeData) {
        updateSet.keySecurityIssueDetails = (nodeData.keySecurityIssueDetails as string) || '';
      }
      if (nodeData.positionChannel !== undefined) updateSet.positionChannel = nodeData.positionChannel;
      if (nodeData.positionPrecisionBits !== undefined) updateSet.positionPrecisionBits = nodeData.positionPrecisionBits;
      if (nodeData.positionLocationSource !== undefined) updateSet.positionLocationSource = nodeData.positionLocationSource;
      if (nodeData.positionTimestamp !== undefined) updateSet.positionTimestamp = nodeData.positionTimestamp;
      // Per-source blocklist is authoritative (issue #2601): re-apply the ignore
      // flag on update when the caller signals the node is still blocklisted,
      // overriding any un-ignored status the device just reported. Note the
      // update path otherwise never touches isIgnored, so we only ever force it
      // on here — clearing is handled explicitly via setNodeIgnored.
      if (wasIgnored) updateSet.isIgnored = true;

      const where = upsertSourceId
        ? and(eq(nodes.nodeNum, nodeData.nodeNum), eq(nodes.sourceId, upsertSourceId))
        : eq(nodes.nodeNum, nodeData.nodeNum);
      db.update(nodes).set(updateSet).where(where).run();
    } else {
      const insertSourceId = upsertSourceId ?? 'default';
      db.insert(nodes).values({
        nodeNum: nodeData.nodeNum,
        nodeId: nodeData.nodeId,
        longName: nodeData.longName || null,
        shortName: nodeData.shortName || null,
        hwModel: nodeData.hwModel || null,
        role: nodeData.role || null,
        hopsAway: nodeData.hopsAway !== undefined ? nodeData.hopsAway : null,
        viaMqtt: nodeData.viaMqtt !== undefined ? !!nodeData.viaMqtt : null,
        transportMechanism: nodeData.transportMechanism !== undefined ? nodeData.transportMechanism : null,
        macaddr: nodeData.macaddr || null,
        latitude: nodeData.latitude || null,
        longitude: nodeData.longitude || null,
        altitude: nodeData.altitude || null,
        batteryLevel: nodeData.batteryLevel || null,
        voltage: nodeData.voltage || null,
        channelUtilization: nodeData.channelUtilization || null,
        airUtilTx: nodeData.airUtilTx || null,
        lastHeard: nodeData.lastHeard || null,
        snr: nodeData.snr || null,
        rssi: nodeData.rssi || null,
        firmwareVersion: nodeData.firmwareVersion || null,
        channel: nodeData.channel !== undefined ? nodeData.channel : null,
        isFavorite: !!nodeData.isFavorite,
        rebootCount: nodeData.rebootCount || null,
        publicKey: nodeData.publicKey || null,
        hasPKC: !!nodeData.hasPKC,
        lastPKIPacket: nodeData.lastPKIPacket || null,
        welcomedAt: nodeData.welcomedAt || null,
        keyIsLowEntropy: !!nodeData.keyIsLowEntropy,
        duplicateKeyDetected: !!nodeData.duplicateKeyDetected,
        keyMismatchDetected: !!nodeData.keyMismatchDetected,
        keySecurityIssueDetails: nodeData.keySecurityIssueDetails || null,
        positionChannel: nodeData.positionChannel !== undefined ? nodeData.positionChannel : null,
        positionPrecisionBits: nodeData.positionPrecisionBits !== undefined ? nodeData.positionPrecisionBits : null,
        positionLocationSource: nodeData.positionLocationSource !== undefined ? nodeData.positionLocationSource : null,
        positionTimestamp: nodeData.positionTimestamp !== undefined ? nodeData.positionTimestamp : null,
        isIgnored: wasIgnored,
        createdAt: now,
        updatedAt: now,
        sourceId: insertSourceId,
      } as any).run();
    }
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

  /**
   * Returns monitored nodes whose battery has dropped below the given threshold (percent).
   * Used by the low-battery notification service. Only Meshtastic nodes report batteryLevel
   * as a 0-100 percentage; a value of 101 means the node is externally powered / has no
   * battery, so it is excluded (lt 101). Source-scoped so checks don't bleed across sources.
   */
  async getLowBatteryMonitoredNodes(
    nodeIds: string[],
    thresholdPercent: number,
    sourceId?: string
  ): Promise<Array<{ nodeNum: number; nodeId: string; longName: string | null; shortName: string | null; batteryLevel: number | null }>> {
    if (nodeIds.length === 0) return [];

    try {
      const { nodes } = this.tables;
      const conditions = [
        inArray(nodes.nodeId, nodeIds),
        isNotNull(nodes.batteryLevel),
        lt(nodes.batteryLevel, thresholdPercent),
        lt(nodes.batteryLevel, 101), // exclude 101 = externally powered / no battery
      ];
      if (sourceId) {
        conditions.push(eq(nodes.sourceId, sourceId));
      }
      const rows = await this.db
        .select({ nodeNum: nodes.nodeNum, nodeId: nodes.nodeId, longName: nodes.longName, shortName: nodes.shortName, batteryLevel: nodes.batteryLevel })
        .from(nodes)
        .where(and(...conditions))
        .orderBy(asc(nodes.batteryLevel));
      return rows.map((r: any) => ({ ...r, nodeNum: Number(r.nodeNum) }));
    } catch (error) {
      logger.error('Failed to query low battery monitored nodes:', error);
      return [];
    }
  }
}
