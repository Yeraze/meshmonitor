/**
 * In-memory fake of `CoverageSurveysRepository` (#5277 Coverage Report epic,
 * Phase 4b WP2 test support).
 *
 * WP1 (schema, migration 173, the real repository, and
 * `databaseService.coverageSurveys`) is being built in a separate worktree in
 * parallel and does not exist in this one. Per the WP2 task brief: route
 * tests can't `vi.mock` a module that doesn't exist, so this fake is assigned
 * directly onto the live `databaseService` singleton
 * (`(databaseService as any).coverageSurveys = createFakeCoverageSurveysRepo()`)
 * inside each route test's `beforeEach`, alongside the REAL
 * `createRouteTestApp()` harness (real session/auth/permissions, real `nodes`
 * / `meshcore` tables) — only the survey table itself is faked.
 *
 * Implements the exact method surface spec'd in
 * `COVERAGE_P4_SPEC.md` §2b.4:
 *   createSurvey / getSurvey / listSurveys / updateSurvey / deleteSurvey /
 *   countSurveys / countSurveysByUser / getLiveSurveyForSender /
 *   getExemptionWindows
 *
 * Once WP1 merges, the orchestrator can either keep this fake (it satisfies
 * the same contract) or convert these tests to the real repository —
 * swapping it out should not require changing any assertion, only the
 * `beforeEach` wiring.
 */
import { COVERAGE_SURVEY_LIVE_MAX_MS } from '../../utils/coverage.js';

export interface FakeDbCoverageSurvey {
  id: string;
  name: string;
  senderId: string;
  startAt: number;
  endAt: number | null;
  receivers: string | null;
  intervalSec: number | null;
  notes: string | null;
  createdBy: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface FakeCreateSurveyParams {
  name: string;
  senderId: string;
  startAt: number;
  endAt: number | null;
  receivers: string | null;
  intervalSec: number | null;
  notes: string | null;
  createdBy: number | null;
}

export interface FakeUpdateSurveyPatch {
  name?: string;
  notes?: string | null;
  intervalSec?: number | null;
  receivers?: string | null;
  endAt?: number | null;
}

export interface FakeCoverageSurveysRepo {
  createSurvey(p: FakeCreateSurveyParams): Promise<FakeDbCoverageSurvey>;
  getSurvey(id: string): Promise<FakeDbCoverageSurvey | null>;
  listSurveys(): Promise<FakeDbCoverageSurvey[]>;
  updateSurvey(id: string, patch: FakeUpdateSurveyPatch): Promise<boolean>;
  deleteSurvey(id: string): Promise<boolean>;
  countSurveys(): Promise<number>;
  countSurveysByUser(userId: number): Promise<number>;
  getLiveSurveyForSender(senderId: string, nowMs: number): Promise<FakeDbCoverageSurvey | null>;
  getExemptionWindows(nowMs: number): Promise<Array<{ senderId: string; startAt: number; endAt: number }>>;
  /** Test-only inspection escape hatch — not part of the real repository's interface. */
  _rows: Map<string, FakeDbCoverageSurvey>;
}

let counter = 0;

/** Deterministic, collision-free id generator — avoids pulling in `crypto.randomUUID` just for tests. */
function fakeId(): string {
  counter += 1;
  return `fake-survey-${counter}`;
}

export function createFakeCoverageSurveysRepo(): FakeCoverageSurveysRepo {
  const rows = new Map<string, FakeDbCoverageSurvey>();

  return {
    _rows: rows,

    async createSurvey(p: FakeCreateSurveyParams): Promise<FakeDbCoverageSurvey> {
      const now = Date.now();
      const row: FakeDbCoverageSurvey = { id: fakeId(), createdAt: now, updatedAt: now, ...p };
      rows.set(row.id, row);
      return { ...row };
    },

    async getSurvey(id: string): Promise<FakeDbCoverageSurvey | null> {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },

    async listSurveys(): Promise<FakeDbCoverageSurvey[]> {
      return Array.from(rows.values())
        .sort((a, b) => b.startAt - a.startAt)
        .map((r) => ({ ...r }));
    },

    async updateSurvey(id: string, patch: FakeUpdateSurveyPatch): Promise<boolean> {
      const row = rows.get(id);
      if (!row) return false;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.notes !== undefined) row.notes = patch.notes;
      if (patch.intervalSec !== undefined) row.intervalSec = patch.intervalSec;
      if (patch.receivers !== undefined) row.receivers = patch.receivers;
      if (patch.endAt !== undefined) row.endAt = patch.endAt;
      row.updatedAt = Date.now();
      return true;
    },

    async deleteSurvey(id: string): Promise<boolean> {
      return rows.delete(id);
    },

    async countSurveys(): Promise<number> {
      return rows.size;
    },

    async countSurveysByUser(userId: number): Promise<number> {
      return Array.from(rows.values()).filter((r) => r.createdBy === userId).length;
    },

    async getLiveSurveyForSender(senderId: string, nowMs: number): Promise<FakeDbCoverageSurvey | null> {
      for (const r of rows.values()) {
        if (r.senderId === senderId && r.endAt === null && nowMs < r.startAt + COVERAGE_SURVEY_LIVE_MAX_MS) {
          return { ...r };
        }
      }
      return null;
    },

    async getExemptionWindows(nowMs: number): Promise<Array<{ senderId: string; startAt: number; endAt: number }>> {
      return Array.from(rows.values()).map((r) => ({
        senderId: r.senderId,
        startAt: r.startAt,
        endAt: r.endAt ?? Math.min(nowMs, r.startAt + COVERAGE_SURVEY_LIVE_MAX_MS),
      }));
    },
  };
}
