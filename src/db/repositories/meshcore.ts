/**
 * MeshCore Repository
 *
 * Handles MeshCore node and message database operations.
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { eq, desc, sql, isNull, isNotNull, and, or, lt, gte, inArray, type SQL } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

/**
 * meshcore_nodes columns where an incoming `null` in upsertNode means "clear
 * this column" (e.g. CMD_RESET_PATH) rather than "not observed this update".
 * Every other column preserves its stored value on a null/undefined incoming —
 * see upsertNode's merge guard (#3504).
 */
const CLEARABLE_VIA_NULL = new Set<string>(['outPath', 'pathLen']);

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
  /**
   * Server-side favorite flag (migration 094). MeshCore firmware has no
   * native favorite concept, so this is stored locally only and never
   * pushed to the device. Favorited nodes pin to the top of the node list.
   */
  isFavorite?: boolean | null;
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
 * MeshCore OTA packet-log row. One per packet observed via the companion
 * `LogRxData` (0x88) push. See `src/db/schema/meshcorePacketLog.ts`.
 */
export interface DbMeshCorePacket {
  id?: number;
  /** Owning source id; required on writes. */
  sourceId: string;
  /** Server capture time (ms). */
  timestamp: number;
  payloadType: number;
  payloadTypeName?: string | null;
  routeType?: number | null;
  routeTypeName?: string | null;
  pathLenRaw?: number | null;
  hopCount?: number | null;
  /** Comma-separated lowercase hex relay-hash chain ("a3,7f,02"), or null. */
  pathHops?: string | null;
  snr?: number | null;
  rssi?: number | null;
  payloadSize?: number | null;
  rawHex?: string | null;
  createdAt: number;
}

/**
 * MeshCore "heard repeater" row (#3700). One per (outgoing channel message,
 * repeater relay-hash) inferred by self-echo correlation. See
 * `src/db/schema/meshcoreHeardRepeaters.ts`.
 */
export interface DbMeshCoreHeardRepeater {
  id?: number;
  /** Owning source id; required on writes. */
  sourceId: string;
  /** meshcore_messages.id of the outgoing channel message that was relayed. */
  messageId: string;
  /** Lowercase hex relay-hash of the repeater that re-flooded the packet. */
  repeaterHash: string;
  /** Resolved repeater contact name (best-effort; null when unknown). */
  repeaterName?: string | null;
  /** Best (max) SNR observed for this repeater across echoes. */
  snr?: number | null;
  /** When the echo was heard (Unix ms). */
  heardAt: number;
  createdAt: number;
}

/** Max of two nullable numbers; null only when both are null. */
function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * Filters accepted by the MeshCore packet-log query/count methods.
 */
export interface MeshCorePacketQuery {
  sourceId?: string;
  offset?: number;
  limit?: number;
  payloadType?: number;
  routeType?: number;
  /** Only return packets with `timestamp >= since` (ms). */
  since?: number;
  /**
   * Keyset cursor (paired with `untilId`): return only rows strictly "older"
   * than `(untilTs, untilId)` in the table's `timestamp DESC, id DESC` order —
   * `timestamp < untilTs OR (timestamp = untilTs AND id < untilId)`. Mirrors the
   * Meshtastic packet-log cursor so both logs can share one unified keyset page.
   */
  untilTs?: number;
  untilId?: number;
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
   * Get all MeshCore nodes for a single source. This is the per-source-scoped
   * read the node list / dashboard map should use — the manager merges these
   * durable rows with its live in-memory contacts so the UI reflects every
   * known node even when the in-memory contact map is transiently empty
   * (e.g. right after a reconnect).
   */
  async getNodesBySource(sourceId: string): Promise<DbMeshCoreNode[]> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .where(eq(meshcoreNodes.sourceId, sourceId))
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
      // Merge, don't clobber (#3504). Callers (persistContact, the telemetry
      // config route) pass `field: value ?? null` for fields they didn't
      // observe this time. A bare `.set({ ...node })` would write those nulls
      // over a previously-stored name/position/etc. Drop null/undefined incoming
      // fields so drizzle only updates columns the caller actually provided a
      // value for; the stored value is preserved otherwise. (`false`/`0`/`''`
      // are kept — only null/undefined means "not observed".)
      //
      // Exception: outPath/pathLen are explicitly clearable via null — a null
      // there means the route was reset (CMD_RESET_PATH), not "unobserved"
      // (see CLEARABLE_VIA_NULL at module scope).
      const updateSet: Record<string, unknown> = { sourceId, updatedAt: now };
      for (const [k, v] of Object.entries(node)) {
        if (v !== null && v !== undefined) {
          updateSet[k] = v;
        } else if (v === null && CLEARABLE_VIA_NULL.has(k)) {
          updateSet[k] = null;
        }
        // else: preserve the existing stored value (don't write the field)
      }
      await this.db
        .update(meshcoreNodes)
        .set(updateSet)
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
   * Set the server-side favorite flag for a (sourceId, publicKey) node
   * (migration 094). MeshCore firmware has no native favorite concept, so
   * this only ever touches local state — there is no device round-trip.
   *
   * Inserts a stub row if one doesn't yet exist, because the user may
   * favorite a node that has only been seen in-memory (the same situation
   * `setNodeTelemetryConfig` handles). Idempotent on the (publicKey,
   * sourceId) pair.
   */
  async setNodeFavorite(
    sourceId: string,
    publicKey: string,
    isFavorite: boolean,
  ): Promise<void> {
    if (!sourceId) {
      throw new Error('MeshCoreRepository.setNodeFavorite requires a sourceId');
    }
    const now = this.now();
    const { meshcoreNodes } = this.tables;
    const existing = await this.getNodeByPublicKeyAndSource(publicKey, sourceId);

    if (existing) {
      await this.db
        .update(meshcoreNodes)
        .set({ isFavorite, updatedAt: now })
        .where(and(eq(meshcoreNodes.publicKey, publicKey), eq(meshcoreNodes.sourceId, sourceId)));
      return;
    }

    await this.db.insert(meshcoreNodes).values({
      publicKey,
      sourceId,
      isFavorite,
      createdAt: now,
      updatedAt: now,
    });
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

  /**
   * Return every node in a source whose last-reported battery voltage is below
   * `thresholdMv`. MeshCore devices report battery as a voltage (millivolts)
   * rather than a 0-100 percentage, so this is the MeshCore analogue of the
   * Meshtastic `getLowBatteryMonitoredNodes` percentage query. Nodes with a
   * null or non-positive batteryMv (no telemetry yet / externally powered) are
   * excluded so they never trigger a spurious alert.
   *
   * See https://github.com/Yeraze/meshmonitor/issues/3331
   */
  async getLowVoltageNodes(sourceId: string, thresholdMv: number): Promise<DbMeshCoreNode[]> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .where(and(
        eq(meshcoreNodes.sourceId, sourceId),
        gte(meshcoreNodes.batteryMv, 1),
        lt(meshcoreNodes.batteryMv, thresholdMv),
      ));
    return this.normalizeBigInts(result) as unknown as DbMeshCoreNode[];
  }

  /**
   * Return every node in a source whose `lastHeard` is older than `cutoffMs`.
   * This is the MeshCore analogue of the Meshtastic
   * `nodes.getInactiveMonitoredNodes` query used by the inactive-node
   * notification service. NOTE: MeshCore `lastHeard` is stored in
   * **milliseconds** (it is set from `Date.now()` via contact.lastSeen),
   * unlike the Meshtastic `nodes.lastHeard` which is in seconds — so callers
   * must pass a millisecond cutoff. Nodes that have never been heard
   * (lastHeard null) are excluded so they can't trigger a spurious alert.
   *
   * See https://github.com/Yeraze/meshmonitor/issues/3331
   */
  async getInactiveMeshcoreNodes(sourceId: string, cutoffMs: number): Promise<DbMeshCoreNode[]> {
    const { meshcoreNodes } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreNodes)
      .where(and(
        eq(meshcoreNodes.sourceId, sourceId),
        isNotNull(meshcoreNodes.lastHeard),
        lt(meshcoreNodes.lastHeard, cutoffMs),
      ));
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
   * Get messages for a specific MeshCore channel index, scoped to a source.
   *
   * Channel traffic is index-keyed on the wire, so the manager synthesises
   * `fromPublicKey = 'channel-${idx}'` on receive and `toPublicKey =
   * 'channel-${idx}'` on local send. For channel 0 only, pre-phase-2 outbound
   * rows were stored with a null recipient and a real-pubkey sender, so we also
   * include any broadcast row (no recipient) whose sender isn't a synthesised
   * `channel-N` key — mirroring the client-side filter in MeshCoreChannelsView.
   *
   * Unlike {@link getRecentMessages} (a single global tail slice shared by every
   * channel and DM), this returns each channel's own backlog independently, so a
   * busy channel can't evict another channel's history from the visible window.
   */
  async getChannelMessages(
    channelIdx: number,
    limit: number = 100,
    sourceId?: string,
  ): Promise<DbMeshCoreMessage[]> {
    const { meshcoreMessages } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreMessages)
      .where(this.channelWhereClause(channelIdx, sourceId))
      .orderBy(desc(meshcoreMessages.timestamp))
      .limit(limit);
    return this.normalizeBigInts(result) as unknown as DbMeshCoreMessage[];
  }

  /**
   * Total message count per channel index for a source, e.g. for the channel
   * list's "N messages" badge. Returns a map keyed by channel index; indices
   * with no messages are omitted. Uses the same channel-scoping rules as
   * {@link getChannelMessages}.
   */
  async getChannelMessageCounts(
    channelIndices: number[],
    sourceId?: string,
  ): Promise<Record<number, number>> {
    const { meshcoreMessages } = this.tables;
    const entries = await Promise.all(
      channelIndices.map(async (idx) => {
        const result = await this.db
          .select({ count: sql<number>`COUNT(*)` })
          .from(meshcoreMessages)
          .where(this.channelWhereClause(idx, sourceId));
        return [idx, Number(result[0]?.count ?? 0)] as const;
      }),
    );
    const counts: Record<number, number> = {};
    for (const [idx, count] of entries) counts[idx] = count;
    return counts;
  }

  /**
   * Build the WHERE clause that matches a single MeshCore channel index,
   * optionally scoped to a source. Shared by the per-channel message and count
   * queries so they stay in lockstep (incl. the channel-0 legacy null-recipient
   * rule that mirrors the client-side filter in MeshCoreChannelsView).
   */
  private channelWhereClause(channelIdx: number, sourceId?: string): SQL | undefined {
    const { meshcoreMessages } = this.tables;
    const key = `channel-${channelIdx}`;
    const channelMatch =
      channelIdx === 0
        ? or(
            eq(meshcoreMessages.fromPublicKey, key),
            eq(meshcoreMessages.toPublicKey, key),
            and(
              isNull(meshcoreMessages.toPublicKey),
              sql`${meshcoreMessages.fromPublicKey} NOT LIKE 'channel-%'`,
            ),
          )
        : or(
            eq(meshcoreMessages.fromPublicKey, key),
            eq(meshcoreMessages.toPublicKey, key),
          );
    return sourceId
      ? and(eq(meshcoreMessages.sourceId, sourceId), channelMatch)
      : channelMatch;
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

  // ============ Heard-Repeater Methods (#3700) ============

  /**
   * Record (or refresh) a repeater that re-flooded an outgoing channel message
   * (self-echo correlation, #3700). Dedups on (sourceId, messageId,
   * repeaterHash); on a repeat echo we keep the best (max) SNR and fill in a
   * `repeaterName` if one becomes known. Returns the merged record so the caller
   * can broadcast the current heard-by state.
   *
   * `sourceId` is required — every row is per-source scoped.
   */
  async recordHeardRepeater(
    record: {
      sourceId: string;
      messageId: string;
      repeaterHash: string;
      repeaterName?: string | null;
      snr?: number | null;
      heardAt: number;
    },
  ): Promise<DbMeshCoreHeardRepeater> {
    if (!record.sourceId) {
      throw new Error('MeshCoreRepository.recordHeardRepeater requires a sourceId');
    }
    const { meshcoreHeardRepeaters } = this.tables;
    const now = this.now();

    const existingRows = await this.db
      .select()
      .from(meshcoreHeardRepeaters)
      .where(
        and(
          eq(meshcoreHeardRepeaters.sourceId, record.sourceId),
          eq(meshcoreHeardRepeaters.messageId, record.messageId),
          eq(meshcoreHeardRepeaters.repeaterHash, record.repeaterHash),
        ),
      )
      .limit(1);
    const existing = existingRows[0]
      ? (this.normalizeBigInts(existingRows[0]) as unknown as DbMeshCoreHeardRepeater)
      : undefined;

    if (existing) {
      const mergedSnr = maxNullable(existing.snr ?? null, record.snr ?? null);
      const mergedName = record.repeaterName ?? existing.repeaterName ?? null;
      await this.db
        .update(meshcoreHeardRepeaters)
        .set({ snr: mergedSnr, repeaterName: mergedName, heardAt: record.heardAt })
        .where(
          and(
            eq(meshcoreHeardRepeaters.sourceId, record.sourceId),
            eq(meshcoreHeardRepeaters.messageId, record.messageId),
            eq(meshcoreHeardRepeaters.repeaterHash, record.repeaterHash),
          ),
        );
      return { ...existing, snr: mergedSnr, repeaterName: mergedName, heardAt: record.heardAt };
    }

    await this.db.insert(meshcoreHeardRepeaters).values({
      sourceId: record.sourceId,
      messageId: record.messageId,
      repeaterHash: record.repeaterHash,
      repeaterName: record.repeaterName ?? null,
      snr: record.snr ?? null,
      heardAt: record.heardAt,
      createdAt: now,
    });
    return {
      sourceId: record.sourceId,
      messageId: record.messageId,
      repeaterHash: record.repeaterHash,
      repeaterName: record.repeaterName ?? null,
      snr: record.snr ?? null,
      heardAt: record.heardAt,
      createdAt: now,
    };
  }

  /**
   * Fetch all heard-repeater rows for a single message (per-source scoped),
   * newest first. Used to broadcast the current heard-by set after each echo.
   */
  async getHeardRepeatersForMessage(
    messageId: string,
    sourceId: string,
  ): Promise<DbMeshCoreHeardRepeater[]> {
    const { meshcoreHeardRepeaters } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreHeardRepeaters)
      .where(
        and(
          eq(meshcoreHeardRepeaters.sourceId, sourceId),
          eq(meshcoreHeardRepeaters.messageId, messageId),
        ),
      )
      .orderBy(desc(meshcoreHeardRepeaters.snr));
    return this.normalizeBigInts(result) as unknown as DbMeshCoreHeardRepeater[];
  }

  /**
   * Fetch heard-repeater rows for many messages at once (per-source scoped),
   * grouped by messageId — used to enrich a channel message list in one query.
   */
  async getHeardRepeatersForMessages(
    messageIds: string[],
    sourceId: string,
  ): Promise<Record<string, DbMeshCoreHeardRepeater[]>> {
    if (messageIds.length === 0) return {};
    const { meshcoreHeardRepeaters } = this.tables;
    const result = await this.db
      .select()
      .from(meshcoreHeardRepeaters)
      .where(
        and(
          eq(meshcoreHeardRepeaters.sourceId, sourceId),
          inArray(meshcoreHeardRepeaters.messageId, messageIds),
        ),
      )
      .orderBy(desc(meshcoreHeardRepeaters.snr));
    const rows = this.normalizeBigInts(result) as unknown as DbMeshCoreHeardRepeater[];
    const grouped: Record<string, DbMeshCoreHeardRepeater[]> = {};
    for (const row of rows) {
      (grouped[row.messageId] ??= []).push(row);
    }
    return grouped;
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

  // ============ Packet-log Methods ============

  /**
   * Build the WHERE clause shared by packet-log query and count.
   */
  private buildPacketConditions(query: MeshCorePacketQuery): SQL[] {
    const { meshcorePacketLog } = this.tables;
    const conditions: SQL[] = [];
    if (query.sourceId) {
      conditions.push(eq(meshcorePacketLog.sourceId, query.sourceId));
    }
    if (typeof query.payloadType === 'number') {
      conditions.push(eq(meshcorePacketLog.payloadType, query.payloadType));
    }
    if (typeof query.routeType === 'number') {
      conditions.push(eq(meshcorePacketLog.routeType, query.routeType));
    }
    if (typeof query.since === 'number') {
      conditions.push(gte(meshcorePacketLog.timestamp, query.since));
    }
    if (typeof query.untilTs === 'number' && typeof query.untilId === 'number') {
      const keyset = or(
        lt(meshcorePacketLog.timestamp, query.untilTs),
        and(eq(meshcorePacketLog.timestamp, query.untilTs), lt(meshcorePacketLog.id, query.untilId))
      );
      if (keyset) conditions.push(keyset);
    }
    return conditions;
  }

  /**
   * Insert an OTA packet-log row. `sourceId` is required so every row is
   * stamped with its owning source.
   */
  async insertPacket(packet: DbMeshCorePacket): Promise<void> {
    if (!packet.sourceId) {
      throw new Error('MeshCoreRepository.insertPacket requires a sourceId');
    }
    const { meshcorePacketLog } = this.tables;
    await this.db.insert(meshcorePacketLog).values(packet);
  }

  /**
   * Query packet-log rows newest-first with optional filters and pagination.
   */
  async getPackets(query: MeshCorePacketQuery = {}): Promise<DbMeshCorePacket[]> {
    const { meshcorePacketLog } = this.tables;
    const conditions = this.buildPacketConditions(query);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const result = await this.db
      .select()
      .from(meshcorePacketLog)
      .where(whereClause)
      .orderBy(desc(meshcorePacketLog.timestamp), desc(meshcorePacketLog.id))
      .limit(query.limit ?? 100)
      .offset(query.offset ?? 0);
    return this.normalizeBigInts(result) as unknown as DbMeshCorePacket[];
  }

  /**
   * Count packet-log rows matching the given filters (no pagination).
   */
  async getPacketCount(query: MeshCorePacketQuery = {}): Promise<number> {
    const { meshcorePacketLog } = this.tables;
    const conditions = this.buildPacketConditions(query);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const result = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(meshcorePacketLog)
      .where(whereClause);
    return Number(result[0]?.count ?? 0);
  }

  /**
   * Delete packets older than a timestamp (ms). Returns rows removed.
   */
  async deletePacketsOlderThan(timestamp: number, sourceId?: string): Promise<number> {
    const { meshcorePacketLog } = this.tables;
    const conditions: SQL[] = [lt(meshcorePacketLog.timestamp, timestamp)];
    if (sourceId) {
      conditions.push(eq(meshcorePacketLog.sourceId, sourceId));
    }
    const before = await this.getPacketCount({ sourceId });
    await this.db.delete(meshcorePacketLog).where(and(...conditions));
    const after = await this.getPacketCount({ sourceId });
    return Math.max(0, before - after);
  }

  /**
   * Trim a source's packet log down to its newest `maxCount` rows.
   * Returns the number of rows removed.
   */
  async trimPacketsToCount(sourceId: string, maxCount: number): Promise<number> {
    if (!sourceId || maxCount <= 0) return 0;
    const { meshcorePacketLog } = this.tables;
    const total = await this.getPacketCount({ sourceId });
    if (total <= maxCount) return 0;

    // Find the cutoff id: keep the newest `maxCount` rows, delete the rest.
    const survivors = await this.db
      .select({ id: meshcorePacketLog.id })
      .from(meshcorePacketLog)
      .where(eq(meshcorePacketLog.sourceId, sourceId))
      .orderBy(desc(meshcorePacketLog.timestamp), desc(meshcorePacketLog.id))
      .limit(maxCount);
    if (survivors.length === 0) return 0;
    const oldestKeptId = Number(survivors[survivors.length - 1].id);

    await this.db
      .delete(meshcorePacketLog)
      .where(and(eq(meshcorePacketLog.sourceId, sourceId), lt(meshcorePacketLog.id, oldestKeptId)));
    return total - survivors.length;
  }

  /**
   * Distinct source ids currently present in the packet log (for per-source
   * retention trimming).
   */
  async getPacketLogSourceIds(): Promise<string[]> {
    const { meshcorePacketLog } = this.tables;
    const rows = await this.db
      .selectDistinct({ sourceId: meshcorePacketLog.sourceId })
      .from(meshcorePacketLog);
    return rows.map((r: { sourceId: string }) => r.sourceId).filter(Boolean);
  }

  /**
   * Delete all packet-log rows, optionally scoped to one source.
   * Returns the number of rows removed.
   */
  async deleteAllPackets(sourceId?: string): Promise<number> {
    const { meshcorePacketLog } = this.tables;
    const count = await this.getPacketCount({ sourceId });
    if (sourceId) {
      await this.db.delete(meshcorePacketLog).where(eq(meshcorePacketLog.sourceId, sourceId));
    } else {
      await this.db.delete(meshcorePacketLog);
    }
    return count;
  }
}
