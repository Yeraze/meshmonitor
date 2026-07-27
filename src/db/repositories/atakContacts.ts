/**
 * ATAK Contacts Repository
 *
 * Handles persistence of ATAK EUD (End User Device) contact state per
 * source, built from the PLI variant of a decoded TAKPacket (ATAK/CoT
 * Phase 2, issue #3691). Supports SQLite, PostgreSQL, and MySQL through
 * Drizzle ORM.
 *
 * **Scoping model.** The `atak_contacts` table is PER-SOURCE. Keyed on
 * composite `(uid, sourceId)` — mirroring the `ignored_nodes` per-source
 * composite-PK model. `uid` is `deviceCallsign` when present (the stable
 * ATAK EUD identifier), else `callsign`, else the carrying node fallback
 * `!<nodeNum hex>` — chosen and stamped by `atakContactService`, not this
 * repository. Each source has its own independent set of contact rows;
 * the same physical ATAK device relayed by two sources produces two rows.
 *
 * Unlike a reception log (mqtt_packet_log, packet_log), this is a
 * one-row-per-device state table: repeated PLI beacons from the same
 * device upsert the existing row in place, preserving `createdAt` while
 * advancing `lastSeen` and refreshing position/status fields.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase, SourceScope } from './base.js';
import { DatabaseType } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface AtakContactRow {
  uid: string;
  sourceId: string;
  nodeNum: number | null;
  callsign: string | null;
  deviceCallsign: string | null;
  team: number | null;
  role: number | null;
  battery: number | null;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  speed: number | null;
  course: number | null;
  lastSeen: number;
  createdAt: number;
}

/**
 * Repository for ATAK contact operations. All lookup/mutation methods are
 * scoped to a `sourceId`, matching the per-source composite PK.
 */
export class AtakContactsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Upsert a contact row on `(uid, sourceId)`. On conflict, `createdAt` is
   * NOT overwritten — the caller-supplied value on the insert path is only
   * used for the first-seen row; every subsequent PLI beacon advances
   * `lastSeen` and refreshes position/status without disturbing the
   * original `createdAt`.
   */
  async upsertContact(row: AtakContactRow): Promise<void> {
    const { atakContacts } = this.tables;
    const updateSet = {
      nodeNum: row.nodeNum,
      callsign: row.callsign,
      deviceCallsign: row.deviceCallsign,
      team: row.team,
      role: row.role,
      battery: row.battery,
      latitude: row.latitude,
      longitude: row.longitude,
      altitude: row.altitude,
      speed: row.speed,
      course: row.course,
      lastSeen: row.lastSeen,
      // createdAt intentionally omitted — preserved from the original insert.
    };

    await this.upsert(
      atakContacts,
      row,
      [atakContacts.uid, atakContacts.sourceId],
      updateSet,
    );

    logger.debug(`Upserted ATAK contact ${row.uid} for source ${row.sourceId}`);
  }

  /**
   * Get all contacts for a source, newest-`lastSeen`-first. Used by the
   * `/api/sources/:id/atak/contacts` route. Pass the `ALL_SOURCES` sentinel
   * (from `./base.js`) for an intentional cross-source read — e.g. the
   * ATAK/CoT Phase 3 feed server, which needs every source's contacts in one
   * query (mirrors `nodes.getAllNodes(ALL_SOURCES)`).
   */
  async getContacts(sourceId: SourceScope): Promise<AtakContactRow[]> {
    const { atakContacts } = this.tables;
    const rows = await this.db
      .select()
      .from(atakContacts)
      .where(this.withSourceScope(atakContacts, sourceId))
      .orderBy(desc(atakContacts.lastSeen));
    return this.normalizeBigInts(rows) as AtakContactRow[];
  }

  /**
   * Retention sweep — deletes contact rows across ALL sources whose
   * `lastSeen` is older than `cutoffMs`. Used by the cleanup scheduler
   * (fixed 24h retention window; see atakContactService).
   * Returns the number of rows deleted.
   */
  async deleteContactsOlderThan(cutoffMs: number): Promise<number> {
    const { atakContacts } = this.tables;
    const result = await this.db
      .delete(atakContacts)
      .where(lt(atakContacts.lastSeen, cutoffMs));
    const deleted = this.getAffectedRows(result);
    if (deleted > 0) {
      logger.debug(`Deleted ${deleted} stale ATAK contact row(s) older than ${new Date(cutoffMs).toISOString()}`);
    }
    return deleted;
  }

  /**
   * Delete all contact rows for a single source. Used by the source-delete
   * handler (`DELETE /api/sources/:id`) so a deleted source's ATAK contacts
   * don't linger. Returns the number of rows deleted.
   */
  async deleteContactsForSource(sourceId: string): Promise<number> {
    const { atakContacts } = this.tables;
    const result = await this.db
      .delete(atakContacts)
      .where(this.withSourceScope(atakContacts, sourceId));
    const deleted = this.getAffectedRows(result);
    logger.debug(`Deleted ${deleted} ATAK contact row(s) for source ${sourceId}`);
    return deleted;
  }

  /**
   * Distinct sourceIds present in the table. Used for per-source retention
   * loops / diagnostics if needed.
   */
  async getContactSourceIds(): Promise<string[]> {
    const { atakContacts } = this.tables;
    const rows = await this.db
      .selectDistinct({ sourceId: atakContacts.sourceId })
      .from(atakContacts);
    return (rows as Array<{ sourceId: string }>).map((r) => r.sourceId);
  }

  /**
   * Check whether a specific (uid, sourceId) row exists. Convenience helper
   * for tests / diagnostics.
   */
  async hasContact(uid: string, sourceId: string): Promise<boolean> {
    const { atakContacts } = this.tables;
    const rows = await this.db
      .select({ uid: atakContacts.uid })
      .from(atakContacts)
      .where(and(eq(atakContacts.uid, uid), this.withSourceScope(atakContacts, sourceId)));
    return rows.length > 0;
  }
}
