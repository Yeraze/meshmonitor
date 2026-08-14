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
import { and, desc, eq, isNull } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase, SourceScope } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface MeshBeaconOfferRow {
  sourceId: string;
  nodeNum: number;
  message: string | null;
  offerChannelName: string | null;
  offerRegion: number | null;
  offerPreset: number | null;
  hasOffer: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  dismissedAt: number | null;
}

/** The advertised half of a beacon — what actually constitutes "an offer". */
export interface BeaconOfferInput {
  message: string | null;
  offerChannelName: string | null;
  offerRegion: number | null;
  offerPreset: number | null;
}

/**
 * True when two offers advertise a DIFFERENT network.
 *
 * Deliberately ignores `message`: a node re-wording its beacon text is still
 * the same invitation, and treating it as new would resurrect a dismissal on a
 * cosmetic edit — precisely the nagging this table exists to prevent.
 */
export function offerContentChanged(a: BeaconOfferInput, b: BeaconOfferInput): boolean {
  return a.offerChannelName !== b.offerChannelName
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
   */
  async recordBeacon(
    sourceId: string,
    nodeNum: number,
    offer: BeaconOfferInput,
    now: number,
  ): Promise<void> {
    const { meshBeaconOffers } = this.tables;
    const existing = await this.getOffer(sourceId, nodeNum);
    const hasOffer = Boolean(offer.offerChannelName || offer.offerRegion != null || offer.offerPreset != null);

    const row: MeshBeaconOfferRow = {
      sourceId,
      nodeNum,
      ...offer,
      hasOffer,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      dismissedAt: existing && !offerContentChanged(existing, offer) ? existing.dismissedAt : null,
    };

    await this.upsert(
      meshBeaconOffers,
      row,
      [meshBeaconOffers.sourceId, meshBeaconOffers.nodeNum],
      {
        message: row.message,
        offerChannelName: row.offerChannelName,
        offerRegion: row.offerRegion,
        offerPreset: row.offerPreset,
        hasOffer: row.hasOffer,
        lastSeenAt: row.lastSeenAt,
        dismissedAt: row.dismissedAt,
        // firstSeenAt intentionally omitted — preserved from the original insert.
      },
    );

    logger.debug(`Recorded MeshBeacon offer from node ${nodeNum} on source ${sourceId}`);
  }

  /**
   * Offers still awaiting a decision, newest first. This is what the invitation
   * card renders, so dismissed rows are excluded rather than filtered client-side.
   */
  async listPending(sourceId: SourceScope): Promise<MeshBeaconOfferRow[]> {
    const { meshBeaconOffers } = this.tables;
    const rows = await this.db
      .select()
      .from(meshBeaconOffers)
      .where(and(this.withSourceScope(meshBeaconOffers, sourceId), isNull(meshBeaconOffers.dismissedAt)))
      .orderBy(desc(meshBeaconOffers.lastSeenAt));
    return this.normalizeBigInts(rows) as MeshBeaconOfferRow[];
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

  /** Drop every offer for a source — used when a source is deleted. */
  async deleteForSource(sourceId: string): Promise<number> {
    const { meshBeaconOffers } = this.tables;
    const result = await this.db
      .delete(meshBeaconOffers)
      .where(eq(meshBeaconOffers.sourceId, sourceId));
    return this.getAffectedRows(result);
  }
}
