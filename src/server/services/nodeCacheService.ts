/**
 * Node Cache Service
 *
 * Wraps the in-memory node cache that DatabaseService maintains for
 * PostgreSQL/MySQL sync-method compatibility (e.g. getNode()/getAllNodes()
 * called from sync code paths). Previously this lived as a bare
 * `Map<string, DbNode>` plus a handful of private helpers on DatabaseService;
 * extracting it keeps the cache key scheme, repo→cache conversion, and the
 * NodesRepository cache-hook wiring in one cohesive, testable place.
 *
 * The cache is keyed by `${nodeNum}:${sourceId}` — the nodes table PK is
 * (nodeNum, sourceId) post-migration 029.
 */
import type { DbNode } from '../../services/database.js';
import type { NodesRepository, NodesCacheHook } from '../../db/repositories/nodes.js';
import { ALL_SOURCES, SourceScope } from '../../db/repositories/base.js';

/**
 * Repository-shaped node row: DbNode fields but with `null` allowed for
 * missing values (the repo layer returns SQL NULLs), plus the `sourceId`
 * column present on multi-source rows. Structurally compatible with both
 * the repo-layer DbNode (src/db/types.ts) and the service-layer DbNode.
 */
type RepoNodeInput = { [K in keyof DbNode]?: DbNode[K] | null } & {
  nodeNum: number;
  nodeId: string;
  sourceId?: string | null;
};

export class NodeCacheService {
  private readonly cache: Map<string, DbNode> = new Map();

  /** Build composite cache key from nodeNum + sourceId. */
  cacheKey(nodeNum: number, sourceId: string): string {
    return `${nodeNum}:${sourceId}`;
  }

  /**
   * Convert a repository-shaped node row (with `null` for missing fields and a
   * `sourceId` column) into the local cache shape (with `undefined` for
   * optional fields). Keeps cache-hook writes structurally identical to the
   * startup warm-load entries.
   */
  fromRepoNode(node: RepoNodeInput, sourceId: string): DbNode {
    return {
      nodeNum: node.nodeNum,
      nodeId: node.nodeId,
      longName: node.longName ?? '',
      shortName: node.shortName ?? '',
      hwModel: node.hwModel ?? 0,
      role: node.role ?? undefined,
      hopsAway: node.hopsAway ?? undefined,
      lastMessageHops: node.lastMessageHops ?? undefined,
      viaMqtt: node.viaMqtt ?? undefined,
      macaddr: node.macaddr ?? undefined,
      latitude: node.latitude ?? undefined,
      longitude: node.longitude ?? undefined,
      altitude: node.altitude ?? undefined,
      batteryLevel: node.batteryLevel ?? undefined,
      voltage: node.voltage ?? undefined,
      channelUtilization: node.channelUtilization ?? undefined,
      airUtilTx: node.airUtilTx ?? undefined,
      lastHeard: node.lastHeard ?? undefined,
      snr: node.snr ?? undefined,
      rssi: node.rssi ?? undefined,
      lastTracerouteRequest: node.lastTracerouteRequest ?? undefined,
      firmwareVersion: node.firmwareVersion ?? undefined,
      channel: node.channel ?? undefined,
      isFavorite: node.isFavorite ?? undefined,
      favoriteLocked: node.favoriteLocked ?? undefined,
      isIgnored: node.isIgnored ?? undefined,
      mobile: node.mobile ?? undefined,
      rebootCount: node.rebootCount ?? undefined,
      publicKey: node.publicKey ?? undefined,
      hasPKC: node.hasPKC ?? undefined,
      lastPKIPacket: node.lastPKIPacket ?? undefined,
      keyIsLowEntropy: node.keyIsLowEntropy ?? undefined,
      duplicateKeyDetected: node.duplicateKeyDetected ?? undefined,
      keyMismatchDetected: node.keyMismatchDetected ?? undefined,
      keySecurityIssueDetails: node.keySecurityIssueDetails ?? undefined,
      welcomedAt: node.welcomedAt ?? undefined,
      positionChannel: node.positionChannel ?? undefined,
      positionPrecisionBits: node.positionPrecisionBits ?? undefined,
      positionGpsAccuracy: node.positionGpsAccuracy ?? undefined,
      positionHdop: node.positionHdop ?? undefined,
      positionTimestamp: node.positionTimestamp ?? undefined,
      positionOverrideEnabled: node.positionOverrideEnabled ?? undefined,
      latitudeOverride: node.latitudeOverride ?? undefined,
      longitudeOverride: node.longitudeOverride ?? undefined,
      altitudeOverride: node.altitudeOverride ?? undefined,
      positionOverrideIsPrivate: node.positionOverrideIsPrivate ?? undefined,
      hideFromMap: node.hideFromMap ?? undefined,
      notes: node.notes ?? undefined,
      hasRemoteAdmin: node.hasRemoteAdmin ?? undefined,
      lastRemoteAdminCheck: node.lastRemoteAdminCheck ?? undefined,
      remoteAdminMetadata: node.remoteAdminMetadata ?? undefined,
      sourceId: node.sourceId ?? sourceId,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    } as DbNode;
  }

  get(nodeNum: number, sourceId: string): DbNode | undefined {
    return this.cache.get(this.cacheKey(nodeNum, sourceId));
  }

  has(nodeNum: number, sourceId: string): boolean {
    return this.cache.has(this.cacheKey(nodeNum, sourceId));
  }

  set(nodeNum: number, sourceId: string, node: DbNode): void {
    this.cache.set(this.cacheKey(nodeNum, sourceId), node);
  }

  setByKey(key: string, node: DbNode): void {
    this.cache.set(key, node);
  }

  delete(nodeNum: number, sourceId: string): void {
    this.cache.delete(this.cacheKey(nodeNum, sourceId));
  }

  deleteByKey(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  values(): IterableIterator<DbNode> {
    return this.cache.values();
  }

  keys(): IterableIterator<string> {
    return this.cache.keys();
  }

  entries(): IterableIterator<[string, DbNode]> {
    return this.cache.entries();
  }

  rawGet(key: string): DbNode | undefined {
    return this.cache.get(key);
  }

  /**
   * Iterate cached nodes, optionally filtered by sourceId. ALL_SOURCES (or
   * undefined / empty) yields every entry; a concrete sourceId filters.
   */
  *iterate(sourceId?: SourceScope): Generator<DbNode> {
    for (const node of this.cache.values()) {
      if (typeof sourceId === 'string' && sourceId !== '' && node.sourceId !== sourceId) continue;
      yield node;
    }
  }

  /**
   * Patch the `mobile` flag in place for every cached row matching the given
   * string node id (e.g. `!abcd1234`). Used by the mobility service after a
   * mobility recompute so sync reads reflect the new value immediately.
   */
  patchMobility(nodeId: string, mobile: number): void {
    for (const [key, cachedNode] of this.cache.entries()) {
      if (cachedNode.nodeId === nodeId) {
        cachedNode.mobile = mobile;
        this.cache.set(key, cachedNode);
      }
    }
  }

  /**
   * Warm the cache from the repository — loads all nodes across all sources
   * (intentional cross-source init warm-up) and replaces the cache contents.
   */
  async warmFromRepo(nodesRepo: NodesRepository): Promise<void> {
    // intentional cross-source: init cache warm-up loads all sources at once
    const nodes = (await nodesRepo.getAllNodes(ALL_SOURCES)) as RepoNodeInput[];
    this.cache.clear();
    for (const node of nodes) {
      const sid = node.sourceId ?? 'default';
      this.setByKey(this.cacheKey(node.nodeNum, sid), this.fromRepoNode(node, sid));
    }
  }

  /**
   * Build the object implementing NodesRepository's cache-hook contract so the
   * in-memory cache stays coherent with DB writes made through the repo
   * (fixes #2858). Semantics mirror {@link NodesCacheHook}.
   */
  buildHook(): NodesCacheHook {
    return {
      setNode: (nodeNum: number, sourceId: string, node: DbNode | null) => {
        const key = this.cacheKey(nodeNum, sourceId);
        if (!node) {
          this.cache.delete(key);
          return;
        }
        this.cache.set(key, this.fromRepoNode(node, sourceId));
      },
      setNodeAcrossSources: (nodeNum: number, freshNodes: DbNode[]) => {
        // Remove existing cache entries for this nodeNum that aren't in
        // freshNodes, then upsert each fresh row.
        const keepSourceIds = new Set(freshNodes.map((n) => n.sourceId ?? 'default'));
        for (const key of Array.from(this.cache.keys())) {
          const cached = this.cache.get(key);
          if (cached && cached.nodeNum === nodeNum && !keepSourceIds.has(cached.sourceId ?? 'default')) {
            this.cache.delete(key);
          }
        }
        for (const fresh of freshNodes) {
          const sid = fresh.sourceId ?? 'default';
          this.cache.set(this.cacheKey(nodeNum, sid), this.fromRepoNode(fresh, sid));
        }
      },
      setNodeByNodeId: (nodeId: string, freshNodes: DbNode[]) => {
        // Replace all cache entries for this nodeId with the fresh set.
        const keepKeys = new Set(
          freshNodes.map((n) => this.cacheKey(n.nodeNum, n.sourceId ?? 'default'))
        );
        for (const key of Array.from(this.cache.keys())) {
          const cached = this.cache.get(key);
          if (cached && cached.nodeId === nodeId && !keepKeys.has(key)) {
            this.cache.delete(key);
          }
        }
        for (const fresh of freshNodes) {
          const sid = fresh.sourceId ?? 'default';
          this.cache.set(this.cacheKey(fresh.nodeNum, sid), this.fromRepoNode(fresh, sid));
        }
      },
      clear: () => {
        this.cache.clear();
      },
    };
  }
}
