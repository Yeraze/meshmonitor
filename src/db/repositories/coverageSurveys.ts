/**
 * Repository for `coverage_surveys` — saved Coverage Report surveys
 * (epic #5277, Phase 4b WP1).
 *
 * GLOBAL table (no `sourceId` scoping) — see the schema file header and
 * COVERAGE_P4_SPEC.md §2b.1 for why. `listSurveys` returns every row; the
 * route layer (WP2) applies the sender-visibility gate per caller.
 *
 * `id` is a UUID (`crypto.randomUUID()`), generated here on `createSurvey` —
 * never a serial PK (see migration 173's header for the PG sequence /
 * `onConflictDoNothing()` trap this avoids).
 *
 * `getExemptionWindows` feeds `CoverageReceptionsRepository.purgeOlderThan`'s
 * exemption seam (P1's single purge seam, reused rather than duplicated).
 * This repository stays independent of that one — no import either
 * direction — the two are wired together only by `coverageRetentionService`.
 */
import { randomUUID } from 'crypto';
import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';
import { effectiveSurveyEndAt, COVERAGE_SURVEY_LIVE_MAX_MS } from '../../utils/coverage.js';

export interface DbCoverageSurvey {
  id: string;
  name: string;
  /** `!xxxxxxxx` or a lowercased 64-hex MeshCore public key. */
  senderId: string;
  /** Unix ms. */
  startAt: number;
  /** Unix ms; null while live. */
  endAt: number | null;
  /** Encoded receiver-filter wire string; null = every receiver. View preference only. */
  receivers: string | null;
  /** Configured broadcast interval for gap detection, seconds. */
  intervalSec: number | null;
  notes: string | null;
  /** users.id; null if created by an admin script. No FK. */
  createdBy: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCoverageSurveyParams {
  name: string;
  senderId: string;
  /** Unix ms. */
  startAt: number;
  /** Unix ms; omit/null for a live survey. */
  endAt?: number | null;
  receivers?: string | null;
  intervalSec?: number | null;
  notes?: string | null;
  createdBy?: number | null;
}

export interface UpdateCoverageSurveyPatch {
  name?: string;
  notes?: string | null;
  intervalSec?: number | null;
  receivers?: string | null;
  /** Used by the "stop" action to close out a live survey. */
  endAt?: number | null;
}

/** A survey's effective retention-exemption window (`purgeOlderThan`'s seam). */
export interface CoverageSurveyExemptionWindow {
  senderId: string;
  startAt: number;
  endAt: number;
}

export class CoverageSurveysRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private mapRow(row: any): DbCoverageSurvey { // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
    return {
      id: row.id,
      name: row.name,
      senderId: row.senderId,
      startAt: Number(row.startAt),
      endAt: row.endAt == null ? null : Number(row.endAt),
      receivers: row.receivers ?? null,
      intervalSec: row.intervalSec == null ? null : Number(row.intervalSec),
      notes: row.notes ?? null,
      createdBy: row.createdBy == null ? null : Number(row.createdBy),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  async createSurvey(p: CreateCoverageSurveyParams): Promise<DbCoverageSurvey> {
    const { coverageSurveys } = this.tables;
    const now = this.now();
    const id = randomUUID();

    await this.db.insert(coverageSurveys).values({
      id,
      name: p.name,
      senderId: p.senderId,
      startAt: p.startAt,
      endAt: p.endAt ?? null,
      receivers: p.receivers ?? null,
      intervalSec: p.intervalSec ?? null,
      notes: p.notes ?? null,
      createdBy: p.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return (await this.getSurvey(id))!;
  }

  async getSurvey(id: string): Promise<DbCoverageSurvey | null> {
    const { coverageSurveys } = this.tables;
    const rows = await this.db.select().from(coverageSurveys).where(eq(coverageSurveys.id, id)).limit(1);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  /** Every survey, newest `startAt` first. The route layer filters by visibility. */
  async listSurveys(): Promise<DbCoverageSurvey[]> {
    const { coverageSurveys } = this.tables;
    const rows = await this.db.select().from(coverageSurveys).orderBy(desc(coverageSurveys.startAt));
    return (rows as any[]).map((r) => this.mapRow(r)); // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect union
  }

  /**
   * Patch mutable fields. Never `senderId`/`startAt` (make a new survey
   * instead) — `endAt` is included only for the "stop" action. Returns
   * whether a row matched; `false` if `id` doesn't exist.
   */
  async updateSurvey(id: string, patch: UpdateCoverageSurveyPatch): Promise<boolean> {
    const { coverageSurveys } = this.tables;
    const set: Record<string, unknown> = { updatedAt: this.now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.intervalSec !== undefined) set.intervalSec = patch.intervalSec;
    if (patch.receivers !== undefined) set.receivers = patch.receivers;
    if (patch.endAt !== undefined) set.endAt = patch.endAt;

    const result = await this.db.update(coverageSurveys).set(set).where(eq(coverageSurveys.id, id));
    return this.getAffectedRows(result) > 0;
  }

  /** Row only — receptions inside the survey's window fall to the next retention sweep (U6). */
  async deleteSurvey(id: string): Promise<boolean> {
    const { coverageSurveys } = this.tables;
    const result = await this.db.delete(coverageSurveys).where(eq(coverageSurveys.id, id));
    return this.getAffectedRows(result) > 0;
  }

  /** Total survey count, for `COVERAGE_SURVEY_MAX_TOTAL`. */
  async countSurveys(): Promise<number> {
    const { coverageSurveys } = this.tables;
    const rows = await this.db.select({ c: count() }).from(coverageSurveys);
    return Number((rows as any[])[0]?.c ?? 0); // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
  }

  /** Per-creator survey count, for `COVERAGE_SURVEY_MAX_PER_USER`. */
  async countSurveysByUser(userId: number): Promise<number> {
    const { coverageSurveys } = this.tables;
    const rows = await this.db
      .select({ c: count() })
      .from(coverageSurveys)
      .where(eq(coverageSurveys.createdBy, userId));
    return Number((rows as any[])[0]?.c ?? 0); // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
  }

  /**
   * The sender's currently-live survey, if any: `endAt IS NULL` and not yet
   * past the live cap (`startAt + COVERAGE_SURVEY_LIVE_MAX_MS > nowMs`) — a
   * survey whose live window has lapsed but was never explicitly stopped no
   * longer blocks starting a new one (read-time lazy end, A10). At most one
   * row is expected to match; returns the newest if more than one somehow
   * does.
   */
  async getLiveSurveyForSender(senderId: string, nowMs: number): Promise<DbCoverageSurvey | null> {
    const { coverageSurveys } = this.tables;
    const cutoff = nowMs - COVERAGE_SURVEY_LIVE_MAX_MS;
    const rows = await this.db
      .select()
      .from(coverageSurveys)
      .where(and(
        eq(coverageSurveys.senderId, senderId),
        isNull(coverageSurveys.endAt),
        gt(coverageSurveys.startAt, cutoff),
      ))
      .orderBy(desc(coverageSurveys.startAt))
      .limit(1);
    return rows.length > 0 ? this.mapRow(rows[0]) : null;
  }

  /**
   * One retention-exemption window per survey, with the effective end
   * already resolved (`effectiveSurveyEndAt`) — a still-live survey's window
   * runs to `nowMs`, capped at `startAt + COVERAGE_SURVEY_LIVE_MAX_MS`. Feeds
   * `CoverageReceptionsRepository.purgeOlderThan`'s exemption seam. Every
   * survey contributes a window regardless of age — an old survey's rows
   * would otherwise already be outside the retention cutoff and need their
   * own exemption.
   */
  async getExemptionWindows(nowMs: number): Promise<CoverageSurveyExemptionWindow[]> {
    const { coverageSurveys } = this.tables;
    const rows = await this.db
      .select({
        senderId: coverageSurveys.senderId,
        startAt: coverageSurveys.startAt,
        endAt: coverageSurveys.endAt,
      })
      .from(coverageSurveys);

    return (rows as any[]).map((r) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- Drizzle cross-dialect row shape
      const startAt = Number(r.startAt);
      const endAt = r.endAt == null ? null : Number(r.endAt);
      return {
        senderId: r.senderId,
        startAt,
        endAt: effectiveSurveyEndAt({ startAt, endAt }, nowMs),
      };
    });
  }
}
