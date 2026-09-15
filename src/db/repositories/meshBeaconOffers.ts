/**
 * MeshBeacon Offers Repository (#4723)
 *
 * Persists received MeshBeacon offers (firmware 2.8+) so an invitation card has
 * something to render and a dismissal has somewhere to live. Supports SQLite,
 * PostgreSQL and MySQL through Drizzle ORM.
 *
 * **Scoping model.** PER-SOURCE, keyed on composite `(sourceId, nodeNum)` — one
 * live offer per beaconing node per source, mirroring `atak_contacts`. The same
 * physical node heard through two sources produces two rows, because accepting
 * an offer is a per-source device action.
 *
 * **State table, not a log.** A rebroadcast upserts in place: `firstSeenAt` is
 * preserved, `lastSeenAt` advances. The table is therefore bounded by beaconing
 * neighbours rather than by uptime, which is why it needs no retention sweep.
 */
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase, SourceScope } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface MeshBeaconOfferRow {
  sourceId: string;
  nodeNum: number;
  message: string | null;
  offerChannelName: string | null;
  /** Base64 PSK — SECRET. Strip with `toPublicOffer` before serializing. */
  offerChannelPsk: string | null;
  offerRegion: number | null;
  offerPreset: number | null;
  hasOffer: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  dismissedAt: number | null;
  /**
   * ms epoch of a permanent mute (#5232); null = not muted.
   *
   * `dismissedAt` lapses when the advertised network changes — deliberately,
   * so a re-keyed channel reads as a new invitation. `mutedAt` does not: a
   * neighbour that keeps re-targeting its beacon would otherwise keep coming
   * back no matter how often it was dismissed.
   */
  mutedAt: number | null;
}

/** A row safe to send to a client: identical minus the channel key. */
export type PublicMeshBeaconOffer = Omit<MeshBeaconOfferRow, 'offerChannelPsk'> & {
  /** Whether a key came with the offer, without revealing it. */
  hasChannelKey: boolean;
};

/**
 * Drop the PSK from a row.
 *
 * Written as an explicit field-by-field construction rather than
 * `const { offerChannelPsk, ...rest } = row` so that a column added to the
 * table later cannot silently ride along into an API response.
 */
export function toPublicOffer(row: MeshBeaconOfferRow): PublicMeshBeaconOffer {
  return {
    sourceId: row.sourceId,
    nodeNum: row.nodeNum,
    message: row.message,
    offerChannelName: row.offerChannelName,
    offerRegion: row.offerRegion,
    offerPreset: row.offerPreset,
    hasOffer: row.hasOffer,
    hasChannelKey: Boolean(row.offerChannelPsk),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    dismissedAt: row.dismissedAt,
    mutedAt: row.mutedAt,
  };
}

/** The advertised half of a beacon — what actually constitutes "an offer". */
export interface BeaconOfferInput {
  message: string | null;
  offerChannelName: string | null;
  offerChannelPsk: string | null;
  offerRegion: number | null;
  offerPreset: number | null;
}

/**
 * Does this beacon advertise a joinable network?
 *
 * Region uses truthiness and preset uses `!= null`, which looks inconsistent
 * and is deliberate: `RegionCode.UNSET` is 0 and `offer_region` is a plain
 * proto3 enum field (no explicit presence), so a zero region means "none
 * offered". `offer_preset` is declared `optional`, so preset 0 (LONG_FAST) is a
 * real offer that truthiness would erase.
 *
 * Ingestion already normalizes region 0 to null, so this is belt-and-braces —
 * but the function is exported and reusable, and a caller that hands it a raw
 * decoded beacon should still get the right answer.
 */
export function computeHasOffer(offer: BeaconOfferInput): boolean {
  return Boolean(offer.offerChannelName)
    || Boolean(offer.offerRegion)
    || offer.offerPreset != null;
}

/**
 * True when two offers advertise a DIFFERENT network.
 *
 * Deliberately ignores `message`: a node re-wording its beacon text is still
 * the same invitation, and treating it as new would resurrect a dismissal on a
 * cosmetic edit — precisely the nagging this table exists to prevent.
 *
 * The PSK *is* compared: the same channel name re-keyed is a different network,
 * and a user who declined the old one has not seen the new one.
 */
export function offerContentChanged(a: BeaconOfferInput, b: BeaconOfferInput): boolean {
  return a.offerChannelName !== b.offerChannelName
    || a.offerChannelPsk !== b.offerChannelPsk
    || a.offerRegion !== b.offerRegion
    || a.offerPreset !== b.offerPreset;
}

export class MeshBeaconOffersRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /** One offer row, or null. */
  async getOffer(sourceId: string, nodeNum: number): Promise<MeshBeaconOfferRow | null> {
    const { meshBeaconOffers } = this.tables;
    const rows = await this.db
      .select()
      .from(meshBeaconOffers)
      .where(and(eq(meshBeaconOffers.sourceId, sourceId), eq(meshBeaconOffers.nodeNum, nodeNum)))
      .limit(1);
    const normalized = this.normalizeBigInts(rows) as MeshBeaconOfferRow[];
    return normalized[0] ?? null;
  }

  /**
   * Record a received beacon, upserting on `(sourceId, nodeNum)`.
   *
   * `firstSeenAt` survives every rebroadcast. `dismissedAt` also survives —
   * that is the anti-nag guarantee — EXCEPT when the offer now advertises a
   * different network, which is a new invitation rather than a repeat of the
   * one already declined, so the card comes back.
   *
   * `mutedAt` survives BOTH (#5232). It is the answer to a sender whose offer
   * keeps changing: a dismissal that lapses on a re-key is correct behaviour
   * and still leaves no way to say "never again", which is what a mute is.
   */
  async recordBeacon(
    sourceId: string,
    nodeNum: number,
    offer: BeaconOfferInput,
    now: number,
  ): Promise<void> {
    const { meshBeaconOffers } = this.tables;
    const existing = await this.getOffer(sourceId, nodeNum);

    const row: MeshBeaconOfferRow = {
      sourceId,
      nodeNum,
      ...offer,
      hasOffer: computeHasOffer(offer),
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      dismissedAt: existing && !offerContentChanged(existing, offer) ? existing.dismissedAt : null,
      mutedAt: existing?.mutedAt ?? null,
    };

    await this.upsert(
      meshBeaconOffers,
      row,
      [meshBeaconOffers.sourceId, meshBeaconOffers.nodeNum],
      {
        message: row.message,
        offerChannelName: row.offerChannelName,
        offerChannelPsk: row.offerChannelPsk,
        offerRegion: row.offerRegion,
        offerPreset: row.offerPreset,
        hasOffer: row.hasOffer,
        lastSeenAt: row.lastSeenAt,
        dismissedAt: row.dismissedAt,
        // firstSeenAt and mutedAt intentionally omitted — both are preserved
        // from the existing row, and a rebroadcast must never lift a mute.
      },
    );

    logger.debug(`Recorded MeshBeacon offer from node ${nodeNum} on source ${sourceId}`);
  }

  /**
   * Offers still awaiting a decision, newest first. This is what the Beacons
   * button counts, so dismissed and muted rows are excluded here rather than
   * filtered client-side — the badge must match what opening it shows.
   */
  async listPending(sourceId: SourceScope): Promise<MeshBeaconOfferRow[]> {
    const { meshBeaconOffers } = this.tables;
    const rows = await this.db
      .select()
      .from(meshBeaconOffers)
      .where(this.pendingWhere(sourceId))
      .orderBy(desc(meshBeaconOffers.lastSeenAt));
    return this.normalizeBigInts(rows) as MeshBeaconOfferRow[];
  }

  /**
   * How many offers are awaiting a decision. Counted in SQL rather than by
   * measuring `listPending`, because the badge is polled and the list is not —
   * pulling every row (PSK included) to learn a single number is waste.
   */
  async countPending(sourceId: SourceScope): Promise<number> {
    const { meshBeaconOffers } = this.tables;
    const rows = await this.db
      .select({ n: count() })
      .from(meshBeaconOffers)
      .where(this.pendingWhere(sourceId));
    return Number((rows as Array<{ n: number | string }>)[0]?.n ?? 0);
  }

  /**
   * How many offers exist at all for the source, hidden ones included.
   *
   * Drives whether the Beacons button renders: a user who muted every beacon
   * still needs a route back to un-mute one, and a button that vanished at
   * `pending === 0` would take that away.
   */
  async countAll(sourceId: SourceScope): Promise<number> {
    const { meshBeaconOffers } = this.tables;
    const rows = await this.db
      .select({ n: count() })
      .from(meshBeaconOffers)
      .where(this.withSourceScope(meshBeaconOffers, sourceId));
    return Number((rows as Array<{ n: number | string }>)[0]?.n ?? 0);
  }

  /** The one definition of "pending", shared by the list and its count. */
  private pendingWhere(sourceId: SourceScope) {
    const { meshBeaconOffers } = this.tables;
    return and(
      this.withSourceScope(meshBeaconOffers, sourceId),
      isNull(meshBeaconOffers.dismissedAt),
      isNull(meshBeaconOffers.mutedAt),
    );
  }

  /** Every offer for a source, dismissed or not. */
  async listAll(sourceId: SourceScope): Promise<MeshBeaconOfferRow[]> {
    const { meshBeaconOffers } = this.tables;
    const rows = await this.db
      .select()
      .from(meshBeaconOffers)
      .where(this.withSourceScope(meshBeaconOffers, sourceId))
      .orderBy(desc(meshBeaconOffers.lastSeenAt));
    return this.normalizeBigInts(rows) as MeshBeaconOfferRow[];
  }

  /** Hide an offer until its advertised network changes. Returns rows affected. */
  async dismiss(sourceId: string, nodeNum: number, now: number): Promise<number> {
    const { meshBeaconOffers } = this.tables;
    const result = await this.db
      .update(meshBeaconOffers)
      .set({ dismissedAt: now })
      .where(and(eq(meshBeaconOffers.sourceId, sourceId), eq(meshBeaconOffers.nodeNum, nodeNum)));
    return this.getAffectedRows(result);
  }

  /** Undo a dismissal. Returns rows affected. */
  async restore(sourceId: string, nodeNum: number): Promise<number> {
    const { meshBeaconOffers } = this.tables;
    const result = await this.db
      .update(meshBeaconOffers)
      .set({ dismissedAt: null })
      .where(and(eq(meshBeaconOffers.sourceId, sourceId), eq(meshBeaconOffers.nodeNum, nodeNum)));
    return this.getAffectedRows(result);
  }

  /**
   * Silence a sender for good. Unlike `dismiss`, this survives the sender
   * changing what it advertises — that is the entire difference between the
   * two, and why muting is a separate action rather than a longer dismissal.
   * Returns rows affected.
   */
  async mute(sourceId: string, nodeNum: number, now: number): Promise<number> {
    const { meshBeaconOffers } = this.tables;
    const result = await this.db
      .update(meshBeaconOffers)
      .set({ mutedAt: now })
      .where(and(eq(meshBeaconOffers.sourceId, sourceId), eq(meshBeaconOffers.nodeNum, nodeNum)));
    return this.getAffectedRows(result);
  }

  /**
   * Undo a mute. Also clears any dismissal, so un-muting puts the offer back
   * in the pending list instead of leaving it hidden behind the other flag —
   * a user who un-mutes is asking to see it again, and having to then also
   * un-dismiss it would read as the button not working.
   * Returns rows affected.
   */
  async unmute(sourceId: string, nodeNum: number): Promise<number> {
    const { meshBeaconOffers } = this.tables;
    const result = await this.db
      .update(meshBeaconOffers)
      .set({ mutedAt: null, dismissedAt: null })
      .where(and(eq(meshBeaconOffers.sourceId, sourceId), eq(meshBeaconOffers.nodeNum, nodeNum)));
    return this.getAffectedRows(result);
  }

  /**
   * Distinct sourceIds present in the table. Mirrors
   * `AtakContactsRepository.getContactSourceIds` — used by the global
   * (source-less) purge branch, which has no single id to scope to.
   */
  async getOfferSourceIds(): Promise<string[]> {
    const { meshBeaconOffers } = this.tables;
    const rows = await this.db
      .selectDistinct({ sourceId: meshBeaconOffers.sourceId })
      .from(meshBeaconOffers);
    return (rows as Array<{ sourceId: string }>).map((r) => r.sourceId);
  }

  /** Drop every offer for a source — used when a source is purged or deleted. */
  async deleteForSource(sourceId: string): Promise<number> {
    const { meshBeaconOffers } = this.tables;
    const result = await this.db
      .delete(meshBeaconOffers)
      .where(eq(meshBeaconOffers.sourceId, sourceId));
    return this.getAffectedRows(result);
  }
}
