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
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase, SourceScope } from './base.js';
import { DatabaseType } from '../types.js';
import { SettingsRepository } from './settings.js';
import { logger } from '../../utils/logger.js';

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
}
