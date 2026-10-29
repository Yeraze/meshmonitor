/**
 * Automation Fire State Repository
 *
 * Persists the Automation Engine's cooldown and rate-limit state in
 * `automation_fire_state`, so a restart or a disable/re-enable does not re-arm
 * a rule. GLOBAL (no sourceId), matching automations.
 */
import { and, eq, lt } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type AutomationFireStateKind = 'cooldown' | 'rate';

export interface AutomationFireStateRow {
  automationId: string;
  kind: AutomationFireStateKind;
  scopeKey: string;
  firedAt: number;
  /** Rate rows only: fire times (ms) still inside the window. */
  events: number[] | null;
}

/** Parse a stored `events` JSON array; anything malformed reads as empty. */
function parseEvents(raw: unknown): number[] | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

export class AutomationFireStateRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private get table() {
    return this.tables.automationFireState;
  }

  private rowToRecord(row: Record<string, unknown>): AutomationFireStateRow {
    return {
      automationId: String(row.automationId),
      kind: row.kind === 'rate' ? 'rate' : 'cooldown',
      scopeKey: String(row.scopeKey ?? ''),
      firedAt: Number(row.firedAt),
      events: parseEvents(row.events),
    };
  }

  /** Every stored row. The engine reads this on load() to restore its maps. */
  async listAll(): Promise<AutomationFireStateRow[]> {
    const rows = await this.db.select().from(this.table);
    return rows.map((row: Record<string, unknown>) => this.rowToRecord(row));
  }

  /** One automation's rows (runNow on a rule that is not loaded). */
  async listByAutomation(automationId: string): Promise<AutomationFireStateRow[]> {
    const t = this.table;
    const rows = await this.db.select().from(t).where(eq(t.automationId, automationId));
    return rows.map((row: Record<string, unknown>) => this.rowToRecord(row));
  }

  /** Record the last fire for one cooldown key. */
  async upsertCooldown(automationId: string, scopeKey: string, firedAt: number): Promise<void> {
    const t = this.table;
    await this.upsert(
      t,
      { automationId, kind: 'cooldown', scopeKey, firedAt, events: null },
      [t.automationId, t.kind, t.scopeKey],
      { firedAt },
    );
  }

  /** Replace an automation's rate-limit window with `events` (ms, oldest first). */
  async upsertRateEvents(automationId: string, events: number[]): Promise<void> {
    const t = this.table;
    if (events.length === 0) {
      await this.deleteKind(automationId, 'rate');
      return;
    }
    const firedAt = Math.max(...events);
    const json = JSON.stringify(events);
    await this.upsert(
      t,
      { automationId, kind: 'rate', scopeKey: '', firedAt, events: json },
      [t.automationId, t.kind, t.scopeKey],
      { firedAt, events: json },
    );
  }

  /** Delete one cooldown key. */
  async deleteCooldown(automationId: string, scopeKey: string): Promise<void> {
    const t = this.table;
    await this.db
      .delete(t)
      .where(and(eq(t.automationId, automationId), eq(t.kind, 'cooldown'), eq(t.scopeKey, scopeKey)));
  }

  /** Delete an automation's cooldown keys last fired before `cutoff` (ms). */
  async deleteCooldownsBefore(automationId: string, cutoff: number): Promise<void> {
    const t = this.table;
    await this.db
      .delete(t)
      .where(and(eq(t.automationId, automationId), eq(t.kind, 'cooldown'), lt(t.firedAt, cutoff)));
  }

  /** Delete all of one kind for an automation. */
  async deleteKind(automationId: string, kind: AutomationFireStateKind): Promise<void> {
    const t = this.table;
    await this.db.delete(t).where(and(eq(t.automationId, automationId), eq(t.kind, kind)));
  }

  /** Delete everything an automation owns (called when the rule is deleted). */
  async deleteByAutomation(automationId: string): Promise<void> {
    const t = this.table;
    await this.db.delete(t).where(eq(t.automationId, automationId));
  }
}
