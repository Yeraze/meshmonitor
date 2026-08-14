/**
 * Reticulum Repository (epic #3960, Phase 1a WP1)
 *
 * Handles persistence of Reticulum destinations (announced destination
 * hashes) and interfaces (RNS interface inventory snapshot). Supports
 * SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 *
 * **Scoping model.** Both `reticulum_destinations` and `reticulum_interfaces`
 * are PER-SOURCE. `reticulum_destinations` is keyed on composite
 * `(sourceId, destinationHash)`; `reticulum_interfaces` on composite
 * `(sourceId, interfaceName)` — mirroring the ATAK-contacts / MeshCore-nodes
 * per-source composite-unique model. Every method below is `sourceId`-scoped
 * via `withSourceScope` (fail-closed on a missing/empty sourceId).
 *
 * See `docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md` §3.1/§3.2 for
 * the full column rationale (rssi/snr/quality included, position/telemetry
 * and LoRa-parameter columns excluded — those are Phase 3).
 */
import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase, SourceScope } from './base.js';
import { DatabaseType } from '../types.js';
import { SettingsRepository } from './settings.js';
import { logger } from '../../utils/logger.js';
import type {
  ReticulumMessageState,
  ReticulumMessageMethod,
} from '../../types/reticulum.js';

export type { ReticulumMessageState, ReticulumMessageMethod };

/** Setting key (see `src/server/constants/settings.ts` VALID_SETTINGS_KEYS). */
const RETICULUM_DESTINATIONS_MAX_SETTING_KEY = 'reticulum_destinations_max';
/** Default cap on `reticulum_destinations` rows per source (attach spec §11 risk 4). */
export const DEFAULT_RETICULUM_DESTINATIONS_MAX = 2000;

export interface ReticulumDestinationRow {
  id?: number;
  sourceId: string;
  destinationHash: string;
  identityHash: string | null;
  appName: string | null;
  aspects: string | null;
  displayName: string | null;
  appDataB64: string | null;
  hops: number | null;
  nextHopInterface: string | null;
  rssi: number | null;
  snr: number | null;
  quality: number | null;
  announceCount: number;
  firstSeen: number;
  lastSeen: number;
  lastAnnounceAt: number | null;
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
  /** Latest Sideband SID_LOCATION sample (migration 144). Latest-only, no history. */
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  speed: number | null;
  bearing: number | null;
  accuracy: number | null;
  /** ms epoch of the latest position sample; null when never observed. */
  positionUpdatedAt: number | null;
}

/**
 * A position patch for {@link ReticulumRepository.updateDestinationPosition}.
 * `latitude`/`longitude` are required (a position sample without coordinates
 * isn't a position); the rest are optional Sideband `Location.pack` fields —
 * `undefined` means "not carried by this sample" and is stored as `null`
 * (unlike {@link UpsertDestinationInput}, this is a full overwrite of the
 * position fields per sample, not a merge — each sample is a fresh GPS fix,
 * not an incremental update).
 */
export interface UpdateDestinationPositionInput {
  destinationHash: string;
  latitude: number;
  longitude: number;
  altitude?: number | null;
  speed?: number | null;
  bearing?: number | null;
  accuracy?: number | null;
  /** ms epoch of this sample; defaults to `Date.now()`. */
  positionUpdatedAt?: number;
}

/**
 * Fields the bridge supplies on each `announce` event. `undefined` means
 * "not observed this announce" (preserve the stored value on an update);
 * pass `null` explicitly to clear a field.
 */
export interface UpsertDestinationInput {
  destinationHash: string;
  identityHash?: string | null;
  appName?: string | null;
  aspects?: string | null;
  displayName?: string | null;
  appDataB64?: string | null;
  hops?: number | null;
  nextHopInterface?: string | null;
  rssi?: number | null;
  snr?: number | null;
  quality?: number | null;
  /** ms epoch of this announce; defaults to `Date.now()`. */
  announceAt?: number;
}

export interface ListDestinationsOptions {
  favoriteOnly?: boolean;
  appName?: string;
  limit?: number;
}

export interface ReticulumInterfaceRow {
  id?: number;
  sourceId: string;
  interfaceName: string;
  interfaceType: string | null;
  interfaceHash: string | null;
  mode: string | null;
  status: string;
  online: boolean;
  bitrate: number | null;
  txBytes: number;
  rxBytes: number;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
  /** Own-mode RNode radio config (migration 145). Null for attach/tcp_peer sources. */
  frequency: number | null;
  bandwidth: number | null;
  spreadingFactor: number | null;
  codingRate: number | null;
  txPower: number | null;
  stAlock: number | null;
  ltAlock: number | null;
  radioState: boolean | null;
  /** Loose JSON text — read-only RNode board/firmware info (R2). */
  deviceInfoJson: string | null;
}

/** The radio-config + device-info subset of {@link ReticulumInterfaceRow} (migration 145). */
export interface ReticulumInterfaceRadioConfig {
  frequency: number | null;
  bandwidth: number | null;
  spreadingFactor: number | null;
  codingRate: number | null;
  txPower: number | null;
  stAlock: number | null;
  ltAlock: number | null;
  radioState: boolean | null;
  deviceInfoJson: string | null;
}

/**
 * A partial radio-config patch for {@link ReticulumRepository.setInterfaceRadioConfig}.
 * `undefined` means "leave the stored value alone" (partial update, e.g. the
 * bridge's `set_radio_config` command only touched a subset of params);
 * pass `null` explicitly to clear a field.
 */
export interface UpdateInterfaceRadioConfigInput {
  frequency?: number | null;
  bandwidth?: number | null;
  spreadingFactor?: number | null;
  codingRate?: number | null;
  txPower?: number | null;
  stAlock?: number | null;
  ltAlock?: number | null;
  radioState?: boolean | null;
  deviceInfoJson?: string | null;
}

/** Fields the bridge supplies on each `interface_stats` poll (a full snapshot). */
export interface UpsertInterfaceInput {
  interfaceName: string;
  interfaceType?: string | null;
  interfaceHash?: string | null;
  mode?: string | null;
  status: string;
  online: boolean;
  bitrate?: number | null;
  txBytes: number;
  rxBytes: number;
  /** ms epoch of this poll; defaults to `Date.now()`. */
  lastSeenAt?: number;
}

export interface ReticulumMessageRow {
  id: string;
  sourceId: string;
  fromHash: string;
  toHash: string;
  title: string | null;
  content: string | null;
  timestamp: number;
  receivedAt: number | null;
  createdAt: number;
  state: ReticulumMessageState;
  method: ReticulumMessageMethod | null;
  signatureValidated: boolean;
  ratcheted: boolean;
  fields: string | null;
  replyToHash: string | null;
  threadHash: string | null;
  rssi: number | null;
  snr: number | null;
  quality: number | null;
}

/**
 * Fields needed to insert-or-update a message row. `id` is the caller-computed
 * composite key `${sourceId}_${lxmHashHex}` (the `messages.id` row-id
 * convention) — for an optimistic outbound send before the LXM hash is known,
 * callers pass a temporary id and reconcile it via {@link ReticulumRepository.renameMessageId}
 * once the bridge assigns the real hash.
 */
export interface UpsertMessageInput {
  id: string;
  fromHash: string;
  toHash: string;
  title?: string | null;
  content?: string | null;
  timestamp: number;
  receivedAt?: number | null;
  state: ReticulumMessageState;
  method?: ReticulumMessageMethod | null;
  signatureValidated?: boolean;
  ratcheted?: boolean;
  /** JSON text — replies/reactions/thread markers + attachment metadata. */
  fields?: string | null;
  replyToHash?: string | null;
  threadHash?: string | null;
  rssi?: number | null;
  snr?: number | null;
  quality?: number | null;
}

export interface ListMessagesOptions {
  /** Return only messages strictly older than this ms-epoch timestamp (pagination cursor). */
  before?: number;
  /** Default 50. */
  limit?: number;
}

/** One conversation's latest-message summary, as returned by {@link ReticulumRepository.listConversations}. */
export interface ReticulumConversationSummary {
  peerHash: string;
  lastMessage: ReticulumMessageRow;
  messageCount: number;
}

// ============ Path Table Row (Phase 4 WP1) ============

export interface ReticulumPathRow {
  id?: number;
  sourceId: string;
  destinationHash: string;
  viaHash: string | null;
  hops: number | null;
  interfaceName: string | null;
  /** ms epoch; from the wire `expires` seconds * 1000. Null when the bridge omits an expiry. */
  expiresAt: number | null;
  /** ms epoch, set on write — the age source for this row. */
  updatedAt: number;
}

/**
 * A single path-table entry as reported by the bridge's `path_table` event.
 * `replacePaths` snapshot-replaces the whole table for a source each poll, so
 * there is no separate merge/partial-update semantic here (unlike
 * {@link UpsertDestinationInput}/{@link UpsertInterfaceInput}) — every field
 * the caller doesn't pass is stored as `null`.
 */
export interface UpsertPathInput {
  destinationHash: string;
  viaHash?: string | null;
  hops?: number | null;
  interfaceName?: string | null;
  expiresAt?: number | null;
  /** ms epoch of this poll; defaults to `Date.now()`. */
  updatedAt?: number;
}

/** Terminal-or-in-flight states used when `selfHash` isn't given to {@link ReticulumRepository.listConversations} — see that method's doc. */
const OUTBOUND_MESSAGE_STATES: ReadonlySet<ReticulumMessageState> = new Set([
  'draft',
  'outbound',
  'sending',
  'sent',
  'failed',
]);

/**
 * Repository for Reticulum operations. All lookup/mutation methods are
 * scoped to a `sourceId`.
 */
export class ReticulumRepository extends BaseRepository {
  private readonly settingsRepo: SettingsRepository;

  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
    this.settingsRepo = new SettingsRepository(db, dbType);
  }

  // ============ Destination Operations ============

  /**
   * Upsert a destination row on `(sourceId, destinationHash)`. On insert,
   * seeds `announceCount = 1` and `firstSeen = lastSeen = lastAnnounceAt =
   * announceAt`. On update, merges — only fields the caller actually passed
   * (not `undefined`) overwrite the stored value — and bumps `announceCount`,
   * `lastSeen`, `lastAnnounceAt`. The whole insert-or-update is one atomic
   * statement (see {@link upsertDestinationAtomic}) — no check-then-act read,
   * so two concurrent announces for the same destination can't race each
   * other into a duplicate-insert crash or a lost update (PR review finding
   * 1). Only a genuine insert can grow the table, so the retention prune
   * (see {@link pruneDestinations}) runs only on that path, not on every
   * repeat announce (PR review finding 2).
   */
  async upsertDestination(sourceId: string, dest: UpsertDestinationInput): Promise<void> {
    if (!sourceId) {
      throw new Error('ReticulumRepository.upsertDestination requires a sourceId');
    }
    const { reticulumDestinations } = this.tables;
    const now = this.now();
    const announceAt = dest.announceAt ?? now;

    const insertValues = {
      sourceId,
      destinationHash: dest.destinationHash,
      identityHash: dest.identityHash ?? null,
      appName: dest.appName ?? null,
      aspects: dest.aspects ?? null,
      displayName: dest.displayName ?? null,
      appDataB64: dest.appDataB64 ?? null,
      hops: dest.hops ?? null,
      nextHopInterface: dest.nextHopInterface ?? null,
      rssi: dest.rssi ?? null,
      snr: dest.snr ?? null,
      quality: dest.quality ?? null,
      announceCount: 1,
      firstSeen: announceAt,
      lastSeen: announceAt,
      lastAnnounceAt: announceAt,
      isFavorite: false,
      createdAt: now,
      updatedAt: now,
    };

    // On conflict: only overwrite the optional fields this announce actually
    // carried (undefined = "not observed" -> preserve the stored value, same
    // merge semantics as before). announceCount is bumped with a SQL
    // expression (not read-then-write) so two concurrent announces can't
    // lose an increment.
    const updateSet: Record<string, unknown> = {
      lastSeen: announceAt,
      lastAnnounceAt: announceAt,
      announceCount: sql`${reticulumDestinations.announceCount} + 1`,
      updatedAt: now,
    };
    if (dest.identityHash !== undefined) updateSet.identityHash = dest.identityHash;
    if (dest.appName !== undefined) updateSet.appName = dest.appName;
    if (dest.aspects !== undefined) updateSet.aspects = dest.aspects;
    if (dest.displayName !== undefined) updateSet.displayName = dest.displayName;
    if (dest.appDataB64 !== undefined) updateSet.appDataB64 = dest.appDataB64;
    if (dest.hops !== undefined) updateSet.hops = dest.hops;
    if (dest.nextHopInterface !== undefined) updateSet.nextHopInterface = dest.nextHopInterface;
    if (dest.rssi !== undefined) updateSet.rssi = dest.rssi;
    if (dest.snr !== undefined) updateSet.snr = dest.snr;
    if (dest.quality !== undefined) updateSet.quality = dest.quality;

    const inserted = await this.upsertDestinationAtomic(reticulumDestinations, insertValues, updateSet);
    if (inserted) {
      await this.pruneDestinations(sourceId);
    }
  }

  /**
   * Atomic insert-or-update for a single destination row, keyed on the
   * `(sourceId, destinationHash)` unique index (migration 140). Single
   * statement — `onConflictDoUpdate` (SQLite/PostgreSQL) / `onDuplicateKeyUpdate`
   * (MySQL) — mirrors the dialect branch already used by `BaseRepository.upsert`
   * and `notifications.ts`'s onConflictDoUpdate/onDuplicateKeyUpdate split.
   *
   * Returns whether this call performed the INSERT (vs. hitting the conflict
   * path and updating):
   *  - SQLite/PostgreSQL: `RETURNING announceCount` — a fresh insert always
   *    seeds `announceCount = 1`; any other value can only come from the
   *    update path (the row already existed with `announceCount >= 1`). This
   *    avoids any dialect-specific "was this xmax/insert-id" trickery.
   *  - MySQL: `INSERT ... ON DUPLICATE KEY UPDATE` reports `affectedRows`
   *    as `1` for a fresh insert and `2` for an update that changed a column
   *    (documented MySQL behavior). `updateSet` always changes `updatedAt`/
   *    `lastSeen`, so a real update here never reports `0`.
   */
  private async upsertDestinationAtomic(
    table: any, // eslint-disable-line @typescript-eslint/no-explicit-any -- ActiveSchema tables are `any` by design (see activeSchema.ts)
    values: Record<string, unknown>,
    updateSet: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.isMySQL()) {
      const result = await this.getMysqlDb()
        .insert(table)
        .values(values)
        .onDuplicateKeyUpdate({ set: updateSet });
      return this.getAffectedRows(result) === 1;
    }

    const rows = await this.db
      .insert(table)
      .values(values)
      .onConflictDoUpdate({
        target: [table.sourceId, table.destinationHash],
        set: updateSet,
      })
      .returning({ announceCount: table.announceCount });
    return rows[0]?.announceCount === 1;
  }

  /**
   * List destinations for a source (or `ALL_SOURCES`), newest-`lastSeen`-first.
   */
  async listDestinations(
    sourceId: SourceScope,
    opts: ListDestinationsOptions = {},
  ): Promise<ReticulumDestinationRow[]> {
    const { reticulumDestinations } = this.tables;
    const conditions = [this.withSourceScope(reticulumDestinations, sourceId)]
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (opts.favoriteOnly) conditions.push(eq(reticulumDestinations.isFavorite, true));
    if (opts.appName !== undefined) conditions.push(eq(reticulumDestinations.appName, opts.appName));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const base = this.db
      .select()
      .from(reticulumDestinations)
      .where(whereClause)
      .orderBy(desc(reticulumDestinations.lastSeen));
    const rows = await (opts.limit ? base.limit(opts.limit) : base);
    return this.normalizeBigInts(rows) as unknown as ReticulumDestinationRow[];
  }

  /**
   * Count destination rows for a source (or `ALL_SOURCES`) without loading
   * full rows — for lightweight status/inventory endpoints (e.g. `GET
   * /status`) that only need a count, not the row payload.
   */
  async countDestinations(sourceId: SourceScope): Promise<number> {
    const { reticulumDestinations } = this.tables;
    const rows = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(reticulumDestinations)
      .where(this.withSourceScope(reticulumDestinations, sourceId));
    return Number(rows[0]?.count ?? 0);
  }

  /** Get a single destination row scoped by `(sourceId, destinationHash)`. */
  async getDestination(sourceId: string, destinationHash: string): Promise<ReticulumDestinationRow | null> {
    const { reticulumDestinations } = this.tables;
    const rows = await this.db
      .select()
      .from(reticulumDestinations)
      .where(and(
        this.withSourceScope(reticulumDestinations, sourceId),
        eq(reticulumDestinations.destinationHash, destinationHash),
      ))
      .limit(1);
    return rows[0] ? (this.normalizeBigInts(rows[0]) as unknown as ReticulumDestinationRow) : null;
  }

  /** Set (or clear) the server-side favorite flag for a destination. UPDATE-only. */
  async setDestinationFavorite(sourceId: string, destinationHash: string, favorite: boolean): Promise<void> {
    if (!sourceId) {
      throw new Error('ReticulumRepository.setDestinationFavorite requires a sourceId');
    }
    const { reticulumDestinations } = this.tables;
    const now = this.now();
    await this.db
      .update(reticulumDestinations)
      .set({ isFavorite: favorite, updatedAt: now })
      .where(and(
        this.withSourceScope(reticulumDestinations, sourceId),
        eq(reticulumDestinations.destinationHash, destinationHash),
      ));
  }

  /**
   * Overwrite a destination's position with a fresh Sideband `SID_LOCATION`
   * sample. UPDATE-only (mirrors {@link setDestinationFavorite}) — a position
   * sample only ever arrives for a destination this source already knows
   * about (it rides an LXMF message routed to/from that destination, which
   * itself requires an announce having been observed first). LATEST-ONLY: no
   * history is kept, so every call fully overwrites the six position columns
   * (+ `positionUpdatedAt`) rather than merging (see
   * {@link UpdateDestinationPositionInput}).
   */
  async updateDestinationPosition(sourceId: string, input: UpdateDestinationPositionInput): Promise<void> {
    if (!sourceId) {
      throw new Error('ReticulumRepository.updateDestinationPosition requires a sourceId');
    }
    const { reticulumDestinations } = this.tables;
    const positionUpdatedAt = input.positionUpdatedAt ?? this.now();

    await this.db
      .update(reticulumDestinations)
      .set({
        latitude: input.latitude,
        longitude: input.longitude,
        altitude: input.altitude ?? null,
        speed: input.speed ?? null,
        bearing: input.bearing ?? null,
        accuracy: input.accuracy ?? null,
        positionUpdatedAt,
        updatedAt: this.now(),
      })
      .where(and(
        this.withSourceScope(reticulumDestinations, sourceId),
        eq(reticulumDestinations.destinationHash, input.destinationHash),
      ));
  }

  /**
   * List destinations for a source (or `ALL_SOURCES`) that currently carry a
   * position sample (`latitude`/`longitude` both non-null), newest
   * `positionUpdatedAt` first. Backs the Reticulum map view (WP5) — Reticulum
   * position is peer-shared per-source and LATEST-ONLY (no history table, no
   * `estimated_positions` batch job; see build spec §3).
   */
  async getDestinationsWithPosition(sourceId: SourceScope): Promise<ReticulumDestinationRow[]> {
    const { reticulumDestinations } = this.tables;
    const conditions = [
      this.withSourceScope(reticulumDestinations, sourceId),
      isNotNull(reticulumDestinations.latitude),
      isNotNull(reticulumDestinations.longitude),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const rows = await this.db
      .select()
      .from(reticulumDestinations)
      .where(and(...conditions))
      .orderBy(desc(reticulumDestinations.positionUpdatedAt));
    return this.normalizeBigInts(rows) as unknown as ReticulumDestinationRow[];
  }

  /** Read `reticulum_destinations_max`, falling back to the default when unset/invalid. */
  private async getDestinationsMax(): Promise<number> {
    const raw = await this.settingsRepo.getSetting(RETICULUM_DESTINATIONS_MAX_SETTING_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETICULUM_DESTINATIONS_MAX;
  }

  /**
   * Prune the oldest-by-`lastSeen` non-favorite destination rows for a source
   * once its row count exceeds the configured cap (`reticulum_destinations_max`,
   * default 2000). Favorites are never eviction candidates — they persist
   * beyond the cap for as long as they exist (attach spec §11 risk 4). A
   * source whose non-favorite backlog can't cover the whole excess (e.g.
   * mostly favorites) simply stays over the cap rather than deleting
   * favorites.
   */
  private async pruneDestinations(sourceId: string): Promise<void> {
    const { reticulumDestinations } = this.tables;
    const max = await this.getDestinationsMax();

    const countRows = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(reticulumDestinations)
      .where(eq(reticulumDestinations.sourceId, sourceId));
    const total = Number(countRows[0]?.count ?? 0);
    if (total <= max) return;

    const excess = total - max;
    const candidates = await this.db
      .select({ id: reticulumDestinations.id })
      .from(reticulumDestinations)
      .where(and(
        eq(reticulumDestinations.sourceId, sourceId),
        eq(reticulumDestinations.isFavorite, false),
      ))
      .orderBy(asc(reticulumDestinations.lastSeen))
      .limit(excess);

    if (candidates.length === 0) return;

    const ids = (candidates as Array<{ id: number }>).map((c) => c.id);
    await this.db
      .delete(reticulumDestinations)
      .where(and(eq(reticulumDestinations.sourceId, sourceId), inArray(reticulumDestinations.id, ids)));
    logger.debug(`ReticulumRepository: pruned ${ids.length} destination row(s) for source ${sourceId} (cap ${max})`);
  }

  // ============ Interface Operations ============

  /**
   * Upsert an interface row on `(sourceId, interfaceName)`. Each poll is a
   * full snapshot, so — unlike {@link upsertDestination} — every field is
   * overwritten on conflict; `createdAt` is preserved from the original
   * insert.
   */
  async upsertInterface(sourceId: string, iface: UpsertInterfaceInput): Promise<void> {
    if (!sourceId) {
      throw new Error('ReticulumRepository.upsertInterface requires a sourceId');
    }
    const { reticulumInterfaces } = this.tables;
    const now = this.now();
    const lastSeenAt = iface.lastSeenAt ?? now;

    const values = {
      sourceId,
      interfaceName: iface.interfaceName,
      interfaceType: iface.interfaceType ?? null,
      interfaceHash: iface.interfaceHash ?? null,
      mode: iface.mode ?? null,
      status: iface.status,
      online: iface.online,
      bitrate: iface.bitrate ?? null,
      txBytes: iface.txBytes,
      rxBytes: iface.rxBytes,
      lastSeenAt,
      createdAt: now,
      updatedAt: now,
    };
    const updateSet = {
      interfaceType: values.interfaceType,
      interfaceHash: values.interfaceHash,
      mode: values.mode,
      status: values.status,
      online: values.online,
      bitrate: values.bitrate,
      txBytes: values.txBytes,
      rxBytes: values.rxBytes,
      lastSeenAt: values.lastSeenAt,
      updatedAt: now,
      // createdAt intentionally omitted — preserved from the original insert.
    };

    await this.upsert(
      reticulumInterfaces,
      values,
      [reticulumInterfaces.sourceId, reticulumInterfaces.interfaceName],
      updateSet,
    );
  }

  /** List all interfaces for a source (or `ALL_SOURCES`), ordered by name. */
  async listInterfaces(sourceId: SourceScope): Promise<ReticulumInterfaceRow[]> {
    const { reticulumInterfaces } = this.tables;
    const rows = await this.db
      .select()
      .from(reticulumInterfaces)
      .where(this.withSourceScope(reticulumInterfaces, sourceId))
      .orderBy(reticulumInterfaces.interfaceName);
    return this.normalizeBigInts(rows) as unknown as ReticulumInterfaceRow[];
  }

  /**
   * Count interface rows for a source (or `ALL_SOURCES`) without loading
   * full rows — see {@link countDestinations}.
   */
  async countInterfaces(sourceId: SourceScope): Promise<number> {
    const { reticulumInterfaces } = this.tables;
    const rows = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(reticulumInterfaces)
      .where(this.withSourceScope(reticulumInterfaces, sourceId));
    return Number(rows[0]?.count ?? 0);
  }

  /** Get a single interface row scoped by `(sourceId, interfaceName)`. */
  async getInterface(sourceId: string, interfaceName: string): Promise<ReticulumInterfaceRow | null> {
    const { reticulumInterfaces } = this.tables;
    const rows = await this.db
      .select()
      .from(reticulumInterfaces)
      .where(and(
        this.withSourceScope(reticulumInterfaces, sourceId),
        eq(reticulumInterfaces.interfaceName, interfaceName),
      ))
      .limit(1);
    return rows[0] ? (this.normalizeBigInts(rows[0]) as unknown as ReticulumInterfaceRow) : null;
  }

  /**
   * Get the radio-config + device-info subset of an interface row, scoped by
   * `(sourceId, interfaceName)` (migration 145). Every field is null for an
   * attach/tcp_peer source — own mode is the only mode that ever writes them
   * (see {@link setInterfaceRadioConfig}).
   */
  async getInterfaceRadioConfig(
    sourceId: string,
    interfaceName: string,
  ): Promise<ReticulumInterfaceRadioConfig | null> {
    const { reticulumInterfaces } = this.tables;
    const rows = await this.db
      .select({
        frequency: reticulumInterfaces.frequency,
        bandwidth: reticulumInterfaces.bandwidth,
        spreadingFactor: reticulumInterfaces.spreadingFactor,
        codingRate: reticulumInterfaces.codingRate,
        txPower: reticulumInterfaces.txPower,
        stAlock: reticulumInterfaces.stAlock,
        ltAlock: reticulumInterfaces.ltAlock,
        radioState: reticulumInterfaces.radioState,
        deviceInfoJson: reticulumInterfaces.deviceInfoJson,
      })
      .from(reticulumInterfaces)
      .where(and(
        this.withSourceScope(reticulumInterfaces, sourceId),
        eq(reticulumInterfaces.interfaceName, interfaceName),
      ))
      .limit(1);
    return rows[0] ? (this.normalizeBigInts(rows[0]) as unknown as ReticulumInterfaceRadioConfig) : null;
  }

  /**
   * Patch an interface's own-mode radio config / device info, scoped by
   * `(sourceId, interfaceName)` (migration 145). UPDATE-only (mirrors
   * {@link setDestinationFavorite}) — a radio-config/device-info write only
   * ever targets an interface row the poller has already created via
   * {@link upsertInterface}. Partial: only fields the caller actually passed
   * (not `undefined`) overwrite the stored value, matching
   * {@link UpdateInterfaceRadioConfigInput}'s merge semantics.
   */
  async setInterfaceRadioConfig(
    sourceId: string,
    interfaceName: string,
    patch: UpdateInterfaceRadioConfigInput,
  ): Promise<void> {
    if (!sourceId) {
      throw new Error('ReticulumRepository.setInterfaceRadioConfig requires a sourceId');
    }
    const { reticulumInterfaces } = this.tables;
    const updateSet: Record<string, unknown> = { updatedAt: this.now() };
    if (patch.frequency !== undefined) updateSet.frequency = patch.frequency;
    if (patch.bandwidth !== undefined) updateSet.bandwidth = patch.bandwidth;
    if (patch.spreadingFactor !== undefined) updateSet.spreadingFactor = patch.spreadingFactor;
    if (patch.codingRate !== undefined) updateSet.codingRate = patch.codingRate;
    if (patch.txPower !== undefined) updateSet.txPower = patch.txPower;
    if (patch.stAlock !== undefined) updateSet.stAlock = patch.stAlock;
    if (patch.ltAlock !== undefined) updateSet.ltAlock = patch.ltAlock;
    if (patch.radioState !== undefined) updateSet.radioState = patch.radioState;
    if (patch.deviceInfoJson !== undefined) updateSet.deviceInfoJson = patch.deviceInfoJson;

    await this.db
      .update(reticulumInterfaces)
      .set(updateSet)
      .where(and(
        this.withSourceScope(reticulumInterfaces, sourceId),
        eq(reticulumInterfaces.interfaceName, interfaceName),
      ));
  }

  // ============ Message Operations (Phase 2 WP3) ============

  /**
   * Insert-or-update a message row on its `id` primary key. `createdAt` is
   * seeded on first insert and preserved on every subsequent update (a
   * conflicting upsert only happens for a row we already persisted — e.g. the
   * bridge re-delivers the same `lxmf_message` event, or an outbound send is
   * reconciled — never a brand-new logical message reusing an id).
   */
  async upsertMessage(sourceId: string, input: UpsertMessageInput): Promise<void> {
    if (!sourceId) {
      throw new Error('ReticulumRepository.upsertMessage requires a sourceId');
    }
    const { reticulumMessages } = this.tables;
    const now = this.now();

    const values = {
      id: input.id,
      sourceId,
      fromHash: input.fromHash,
      toHash: input.toHash,
      title: input.title ?? null,
      content: input.content ?? null,
      timestamp: input.timestamp,
      receivedAt: input.receivedAt ?? null,
      createdAt: now,
      state: input.state,
      method: input.method ?? null,
      signatureValidated: input.signatureValidated ?? false,
      ratcheted: input.ratcheted ?? false,
      fields: input.fields ?? null,
      replyToHash: input.replyToHash ?? null,
      threadHash: input.threadHash ?? null,
      rssi: input.rssi ?? null,
      snr: input.snr ?? null,
      quality: input.quality ?? null,
    };
    const updateSet: Record<string, unknown> = {
      fromHash: values.fromHash,
      toHash: values.toHash,
      title: values.title,
      content: values.content,
      timestamp: values.timestamp,
      receivedAt: values.receivedAt,
      // createdAt intentionally omitted — preserved from the original insert.
      state: values.state,
      method: values.method,
      signatureValidated: values.signatureValidated,
      ratcheted: values.ratcheted,
      fields: values.fields,
      replyToHash: values.replyToHash,
      threadHash: values.threadHash,
      rssi: values.rssi,
      snr: values.snr,
      quality: values.quality,
    };

    await this.upsert(reticulumMessages, values, [reticulumMessages.id], updateSet);
  }

  /**
   * Update a message's delivery state (and optionally its method) — driven by
   * `delivery_state` events. `opts.attempts` is accepted for signature parity
   * with the wire event but is NOT persisted: `reticulum_messages` (migration
   * 143) has no `attempts` column; the delivery-state event's attempt count is
   * transient UI-update data only (see `dataEventEmitter.emitReticulumDeliveryStateUpdated`).
   */
  async updateMessageState(
    sourceId: string,
    id: string,
    state: ReticulumMessageState,
    opts: { method?: ReticulumMessageMethod | null } = {},
  ): Promise<void> {
    if (!sourceId) {
      throw new Error('ReticulumRepository.updateMessageState requires a sourceId');
    }
    const { reticulumMessages } = this.tables;
    const updateSet: Record<string, unknown> = { state };
    if (opts.method !== undefined) updateSet.method = opts.method;

    await this.db
      .update(reticulumMessages)
      .set(updateSet)
      .where(and(this.withSourceScope(reticulumMessages, sourceId), eq(reticulumMessages.id, id)));
  }

  /**
   * Rename a message row's `id` (its primary key). Used by the outbound send
   * flow to reconcile an optimistically-persisted temporary id into the
   * authoritative `${sourceId}_${lxmHashHex}` id once the bridge assigns the
   * real LXM hash — see `ReticulumManager.sendMessage`.
   */
  async renameMessageId(sourceId: string, oldId: string, newId: string): Promise<void> {
    if (!sourceId) {
      throw new Error('ReticulumRepository.renameMessageId requires a sourceId');
    }
    const { reticulumMessages } = this.tables;
    await this.db
      .update(reticulumMessages)
      .set({ id: newId })
      .where(and(this.withSourceScope(reticulumMessages, sourceId), eq(reticulumMessages.id, oldId)));
  }

  /** Get a single message row scoped by `(sourceId, id)`. */
  async getMessage(sourceId: string, id: string): Promise<ReticulumMessageRow | null> {
    const { reticulumMessages } = this.tables;
    const rows = await this.db
      .select()
      .from(reticulumMessages)
      .where(and(this.withSourceScope(reticulumMessages, sourceId), eq(reticulumMessages.id, id)))
      .limit(1);
    return rows[0] ? (this.normalizeBigInts(rows[0]) as unknown as ReticulumMessageRow) : null;
  }

  /**
   * A conversation's messages (a specific peer hash), newest-first, with
   * optional `before` cursor pagination. `peerHash` matches either side of
   * the message (fromHash or toHash) — LXMF conversations are always exactly
   * two parties, so a peer hash unambiguously identifies the conversation
   * regardless of message direction.
   */
  async listMessages(
    sourceId: string,
    peerHash: string,
    opts: ListMessagesOptions = {},
  ): Promise<ReticulumMessageRow[]> {
    const { reticulumMessages } = this.tables;
    const conditions = [
      this.withSourceScope(reticulumMessages, sourceId),
      or(eq(reticulumMessages.fromHash, peerHash), eq(reticulumMessages.toHash, peerHash)),
    ];
    if (opts.before !== undefined) conditions.push(lt(reticulumMessages.timestamp, opts.before));

    const rows = await this.db
      .select()
      .from(reticulumMessages)
      .where(and(...conditions))
      .orderBy(desc(reticulumMessages.timestamp))
      .limit(opts.limit ?? 50);
    return this.normalizeBigInts(rows) as unknown as ReticulumMessageRow[];
  }

  /** A message thread (LXMF `fields.thread` marker), chronological (oldest first). */
  async listThread(sourceId: string, threadHash: string): Promise<ReticulumMessageRow[]> {
    const { reticulumMessages } = this.tables;
    const rows = await this.db
      .select()
      .from(reticulumMessages)
      .where(and(this.withSourceScope(reticulumMessages, sourceId), eq(reticulumMessages.threadHash, threadHash)))
      .orderBy(asc(reticulumMessages.timestamp));
    return this.normalizeBigInts(rows) as unknown as ReticulumMessageRow[];
  }

  /**
   * Grouped latest-per-peer conversation summary for a source, newest-first.
   *
   * `selfHash` (the source's own LXMF destination — `ReticulumManager.getOwnAddresses()`)
   * determines which side of each row is "the peer": when given, the peer is
   * whichever of `fromHash`/`toHash` is NOT `selfHash`. Callers that know their
   * own address (the manager, routes) should always pass it — without it, the
   * peer is inferred from `state` (an outbound-flavored state means WE sent
   * it, so the peer is `toHash`; otherwise the peer is `fromHash`), which is
   * ambiguous for a 'delivered' row that could be either an inbound receipt
   * or our own delivered send.
   *
   * Implemented as an in-process reduction over the most recent `scanLimit`
   * rows (default 1000) rather than a SQL "greatest-per-group" query — Drizzle
   * has no dialect-portable idiom for that, and LXMF message volume doesn't
   * warrant one. Rows are fetched newest-first, so the first occurrence per
   * peer is already the latest.
   */
  async listConversations(
    sourceId: string,
    selfHash?: string,
    scanLimit = 1000,
  ): Promise<ReticulumConversationSummary[]> {
    const { reticulumMessages } = this.tables;
    const rows = await this.db
      .select()
      .from(reticulumMessages)
      .where(this.withSourceScope(reticulumMessages, sourceId))
      .orderBy(desc(reticulumMessages.timestamp))
      .limit(scanLimit);
    const normalized = this.normalizeBigInts(rows) as unknown as ReticulumMessageRow[];

    const lowerSelf = selfHash?.toLowerCase();
    const peerOf = (row: ReticulumMessageRow): string => {
      if (lowerSelf) return row.fromHash.toLowerCase() === lowerSelf ? row.toHash : row.fromHash;
      return OUTBOUND_MESSAGE_STATES.has(row.state) ? row.toHash : row.fromHash;
    };

    const summaries = new Map<string, ReticulumConversationSummary>();
    for (const row of normalized) {
      const peerHash = peerOf(row);
      const existing = summaries.get(peerHash);
      if (existing) {
        existing.messageCount += 1;
      } else {
        summaries.set(peerHash, { peerHash, lastMessage: row, messageCount: 1 });
      }
    }
    return Array.from(summaries.values()).sort((a, b) => b.lastMessage.timestamp - a.lastMessage.timestamp);
  }

  // ============ Path Table Operations (Phase 4 WP1) ============

  /**
   * Replace the entire path table for a source with a fresh snapshot —
   * the bridge's `path_table` event always carries the whole table, not a
   * delta, so this deletes every existing row for `sourceId` and bulk-inserts
   * the new set in one pass (mirrors {@link pruneDestinations}'s delete
   * pattern, generalized to "delete all" rather than "delete oldest N").
   * `withSourceScope`'s fail-closed guard means an empty/missing `sourceId`
   * throws before either the delete or the insert runs, so this can never
   * touch another source's rows. An empty `paths` array still clears the
   * table for `sourceId` (the source now reports zero known paths) but skips
   * the insert.
   */
  async replacePaths(sourceId: string, paths: UpsertPathInput[]): Promise<void> {
    if (!sourceId) {
      throw new Error('ReticulumRepository.replacePaths requires a sourceId');
    }
    const { reticulumPaths } = this.tables;
    const now = this.now();

    await this.db
      .delete(reticulumPaths)
      .where(this.withSourceScope(reticulumPaths, sourceId));

    if (paths.length === 0) return;

    const values = paths.map((p) => ({
      sourceId,
      destinationHash: p.destinationHash,
      viaHash: p.viaHash ?? null,
      hops: p.hops ?? null,
      interfaceName: p.interfaceName ?? null,
      expiresAt: p.expiresAt ?? null,
      updatedAt: p.updatedAt ?? now,
    }));

    await this.db.insert(reticulumPaths).values(values);
  }

  /**
   * List path table rows for a source (or `ALL_SOURCES`), ordered by hops
   * (fewest first, nulls last) then destinationHash — mirrors the topology
   * view's "nearest first" reading order.
   */
  async listPaths(sourceId: SourceScope): Promise<ReticulumPathRow[]> {
    const { reticulumPaths } = this.tables;
    const rows = await this.db
      .select()
      .from(reticulumPaths)
      .where(this.withSourceScope(reticulumPaths, sourceId))
      .orderBy(
        sql`CASE WHEN ${reticulumPaths.hops} IS NULL THEN 1 ELSE 0 END`,
        asc(reticulumPaths.hops),
        asc(reticulumPaths.destinationHash),
      );
    return this.normalizeBigInts(rows) as unknown as ReticulumPathRow[];
  }
}
