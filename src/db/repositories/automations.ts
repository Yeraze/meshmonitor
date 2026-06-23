/**
 * Automations Repository (#3653)
 *
 * CRUD for the global Automation Engine definitions (`automations`) and the
 * execution log / stateful run store (`automation_runs`).
 *
 * `automations` is GLOBAL — no sourceId scoping (a deliberate exception to the
 * per-source invariant; scoping happens via a `condition.sourceFilter` block
 * inside the workflow config, not at the row level).
 *
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { randomUUID } from 'crypto';
import { eq, desc, and } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface AutomationRecord {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** JSON string of the trigger/condition/action graph ({ version, nodes[], edges[] }). */
  config: string;
  createdByUserId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAutomationInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  config: string;
  createdByUserId?: number | null;
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  config?: string;
}

export type AutomationRunStatus = 'pending' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  sourceId: string | null;
  status: AutomationRunStatus;
  /** JSON string of persisted variables + reached nodes + pending waits (Phase 1b). */
  state: string | null;
  /** JSON snapshot of the event payload that fired this run. */
  triggerEvent: string | null;
  /** JSON ordered step results. */
  log: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface CreateAutomationRunInput {
  automationId: string;
  sourceId?: string | null;
  status: AutomationRunStatus;
  state?: string | null;
  triggerEvent?: string | null;
  log?: string | null;
}

/**
 * Repository for Automation Engine operations.
 */
export class AutomationsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private rowToRecord(row: any): AutomationRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      enabled: Boolean(row.enabled),
      config: row.config,
      createdByUserId: row.createdByUserId == null ? null : Number(row.createdByUserId),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private runRowToRecord(row: any): AutomationRunRecord {
    return {
      id: row.id,
      automationId: row.automationId,
      sourceId: row.sourceId ?? null,
      status: row.status as AutomationRunStatus,
      state: row.state ?? null,
      triggerEvent: row.triggerEvent ?? null,
      log: row.log ?? null,
      startedAt: Number(row.startedAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  // ─── automations CRUD ───────────────────────────────────────────────────

  async listAutomations(): Promise<AutomationRecord[]> {
    const { automations } = this.tables;
    const rows = await this.db.select().from(automations).orderBy(desc(automations.updatedAt));
    return rows.map((r: any) => this.rowToRecord(r));
  }

  /** Only enabled automations — used by the engine on load. */
  async listEnabledAutomations(): Promise<AutomationRecord[]> {
    const { automations } = this.tables;
    const rows = await this.db.select().from(automations).where(eq(automations.enabled, true));
    return rows.map((r: any) => this.rowToRecord(r));
  }

  async getAutomation(id: string): Promise<AutomationRecord | null> {
    const { automations } = this.tables;
    const rows = await this.db.select().from(automations).where(eq(automations.id, id)).limit(1);
    return rows.length > 0 ? this.rowToRecord(rows[0]) : null;
  }

  async createAutomation(input: CreateAutomationInput): Promise<AutomationRecord> {
    const { automations } = this.tables;
    const now = this.now();
    const id = randomUUID();
    await this.db.insert(automations).values({
      id,
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled ?? false,
      config: input.config,
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return (await this.getAutomation(id))!;
  }

  /** Returns the updated record, or null if no row matched. */
  async updateAutomation(id: string, patch: UpdateAutomationInput): Promise<AutomationRecord | null> {
    const { automations } = this.tables;
    const set: Record<string, unknown> = { updatedAt: this.now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.config !== undefined) set.config = patch.config;

    await this.db.update(automations).set(set).where(eq(automations.id, id));
    return this.getAutomation(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const { automations } = this.tables;
    await this.db
      .update(automations)
      .set({ enabled, updatedAt: this.now() })
      .where(eq(automations.id, id));
  }

  /** Returns true if a row was deleted. Also clears the automation's run history. */
  async deleteAutomation(id: string): Promise<boolean> {
    const { automations, automationRuns } = this.tables;
    await this.db.delete(automationRuns).where(eq(automationRuns.automationId, id));
    const result = await this.executeRun(
      (this.db as any).delete(automations).where(eq(automations.id, id)),
    );
    return this.getAffectedRows(result) > 0;
  }

  // ─── automation_runs ─────────────────────────────────────────────────────

  async createRun(input: CreateAutomationRunInput): Promise<AutomationRunRecord> {
    const { automationRuns } = this.tables;
    const now = this.now();
    const id = randomUUID();
    await this.db.insert(automationRuns).values({
      id,
      automationId: input.automationId,
      sourceId: input.sourceId ?? null,
      status: input.status,
      state: input.state ?? null,
      triggerEvent: input.triggerEvent ?? null,
      log: input.log ?? null,
      startedAt: now,
      updatedAt: now,
    });
    return (await this.getRun(id))!;
  }

  async getRun(id: string): Promise<AutomationRunRecord | null> {
    const { automationRuns } = this.tables;
    const rows = await this.db.select().from(automationRuns).where(eq(automationRuns.id, id)).limit(1);
    return rows.length > 0 ? this.runRowToRecord(rows[0]) : null;
  }

  async updateRun(
    id: string,
    patch: Partial<Pick<AutomationRunRecord, 'status' | 'state' | 'log' | 'sourceId'>>,
  ): Promise<void> {
    const { automationRuns } = this.tables;
    const set: Record<string, unknown> = { updatedAt: this.now() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.state !== undefined) set.state = patch.state;
    if (patch.log !== undefined) set.log = patch.log;
    if (patch.sourceId !== undefined) set.sourceId = patch.sourceId;
    await this.db.update(automationRuns).set(set).where(eq(automationRuns.id, id));
  }

  /** Most-recent-first run log for one automation. */
  async listRuns(automationId: string, limit = 50): Promise<AutomationRunRecord[]> {
    const { automationRuns } = this.tables;
    const rows = await this.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.automationId, automationId))
      .orderBy(desc(automationRuns.startedAt))
      .limit(limit);
    return rows.map((r: any) => this.runRowToRecord(r));
  }

  /** All runs in a given status (Phase 1b: rehydrate `waiting` runs on boot). */
  async listRunsByStatus(status: AutomationRunStatus): Promise<AutomationRunRecord[]> {
    const { automationRuns } = this.tables;
    const rows = await this.db
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.status, status));
    return rows.map((r: any) => this.runRowToRecord(r));
  }

  /** Cancel all non-terminal runs for an automation (Phase 1b: on edit/disable). */
  async cancelActiveRuns(automationId: string): Promise<void> {
    const { automationRuns } = this.tables;
    for (const status of ['pending', 'waiting'] as AutomationRunStatus[]) {
      await this.db
        .update(automationRuns)
        .set({ status: 'cancelled', updatedAt: this.now() })
        .where(and(eq(automationRuns.automationId, automationId), eq(automationRuns.status, status)));
    }
  }
}
