/**
 * Automation Variables Repository (#3653, §5.2)
 *
 * User-defined variables for the Automation Engine:
 *  - definitions (`automation_variables`, global) — name/type/scope/readonly/config
 *  - per-scope values (`automation_variable_values`) — keyed by (variableId, scopeKey),
 *    with `expiresAt` powering the `flag` auto-clear (anti-spam).
 *
 * The repository is intentionally TYPE-AGNOSTIC: it stores/returns raw encoded
 * string values and an optional expiry. Type encoding/decoding and flag-duration
 * computation live in the engine, which knows each variable's `type`/`config`.
 * The one generic semantic the repo applies is the flag TTL: an expired value is
 * treated as absent.
 *
 * Supports SQLite, PostgreSQL, and MySQL through Drizzle ORM.
 */
import { randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export type VariableType = 'string' | 'integer' | 'float' | 'boolean' | 'flag';
export type VariableScope = 'global' | 'source' | 'node' | 'sourceNode';

export interface AutomationVariableRecord {
  id: string;
  name: string;
  description: string | null;
  type: VariableType;
  scope: VariableScope;
  /** true = user-set constant (thresholds); automations may read but not write. */
  readonly: boolean;
  /** JSON: { flagDurationSeconds?, defaultValue? } */
  config: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateVariableInput {
  name: string;
  description?: string | null;
  type: VariableType;
  scope: VariableScope;
  readonly?: boolean;
  config?: string;
}

export interface UpdateVariableInput {
  name?: string;
  description?: string | null;
  type?: VariableType;
  scope?: VariableScope;
  readonly?: boolean;
  config?: string;
}

export interface AutomationVariableValueRecord {
  id: string;
  variableId: string;
  scopeKey: string;
  value: string | null;
  /** Flag auto-clear timestamp (ms). null = never expires. */
  expiresAt: number | null;
  updatedAt: number;
}

export class AutomationVariablesRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  /**
   * Build the value-store key for a scope from runtime context.
   *  global     → ''
   *  source     → sourceId
   *  node       → nodeNum
   *  sourceNode → `${sourceId}:${nodeNum}`
   * Returns null when required context is missing (e.g. a node-scoped variable
   * with no node in context) so callers can skip rather than mis-key.
   */
  static buildScopeKey(
    scope: VariableScope,
    ctx: { sourceId?: string | null; nodeNum?: number | null },
  ): string | null {
    switch (scope) {
      case 'global':
        return '';
      case 'source':
        return ctx.sourceId ? String(ctx.sourceId) : null;
      case 'node':
        return ctx.nodeNum == null ? null : String(ctx.nodeNum);
      case 'sourceNode':
        if (!ctx.sourceId || ctx.nodeNum == null) return null;
        return `${ctx.sourceId}:${ctx.nodeNum}`;
      default:
        return null;
    }
  }

  private defRow(row: any): AutomationVariableRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      type: row.type as VariableType,
      scope: row.scope as VariableScope,
      readonly: Boolean(row.readonly),
      config: row.config,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  private valRow(row: any): AutomationVariableValueRecord {
    return {
      id: row.id,
      variableId: row.variableId,
      scopeKey: row.scopeKey,
      value: row.value ?? null,
      expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
      updatedAt: Number(row.updatedAt),
    };
  }

  // ─── definitions ──────────────────────────────────────────────────────────

  async listVariables(): Promise<AutomationVariableRecord[]> {
    const { automationVariables } = this.tables;
    const rows = await this.db.select().from(automationVariables);
    return rows.map((r: any) => this.defRow(r));
  }

  async getVariable(id: string): Promise<AutomationVariableRecord | null> {
    const { automationVariables } = this.tables;
    const rows = await this.db.select().from(automationVariables).where(eq(automationVariables.id, id)).limit(1);
    return rows.length > 0 ? this.defRow(rows[0]) : null;
  }

  async getVariableByName(name: string): Promise<AutomationVariableRecord | null> {
    const { automationVariables } = this.tables;
    const rows = await this.db.select().from(automationVariables).where(eq(automationVariables.name, name)).limit(1);
    return rows.length > 0 ? this.defRow(rows[0]) : null;
  }

  async createVariable(input: CreateVariableInput): Promise<AutomationVariableRecord> {
    const { automationVariables } = this.tables;
    const now = this.now();
    const id = randomUUID();
    await this.db.insert(automationVariables).values({
      id,
      name: input.name,
      description: input.description ?? null,
      type: input.type,
      scope: input.scope,
      readonly: input.readonly ?? false,
      config: input.config ?? '{}',
      createdAt: now,
      updatedAt: now,
    });
    return (await this.getVariable(id))!;
  }

  async updateVariable(id: string, patch: UpdateVariableInput): Promise<AutomationVariableRecord | null> {
    const { automationVariables } = this.tables;
    const set: Record<string, unknown> = { updatedAt: this.now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.scope !== undefined) set.scope = patch.scope;
    if (patch.readonly !== undefined) set.readonly = patch.readonly;
    if (patch.config !== undefined) set.config = patch.config;
    await this.db.update(automationVariables).set(set).where(eq(automationVariables.id, id));
    return this.getVariable(id);
  }

  /** Deletes the definition and all of its stored values. Returns true if removed. */
  async deleteVariable(id: string): Promise<boolean> {
    const { automationVariables, automationVariableValues } = this.tables;
    await this.db.delete(automationVariableValues).where(eq(automationVariableValues.variableId, id));
    const result = await this.executeRun(
      (this.db as any).delete(automationVariables).where(eq(automationVariables.id, id)),
    );
    return this.getAffectedRows(result) > 0;
  }

  // ─── values ────────────────────────────────────────────────────────────────

  /** Raw stored value (ignores expiry). */
  async getRawValue(variableId: string, scopeKey: string): Promise<AutomationVariableValueRecord | null> {
    const { automationVariableValues } = this.tables;
    const rows = await this.db
      .select()
      .from(automationVariableValues)
      .where(and(eq(automationVariableValues.variableId, variableId), eq(automationVariableValues.scopeKey, scopeKey)))
      .limit(1);
    return rows.length > 0 ? this.valRow(rows[0]) : null;
  }

  /**
   * Effective value with flag TTL applied: an expired row reads as absent (null),
   * matching the "flag auto-clears after duration" semantic. `now` is injectable
   * for testing.
   */
  async getEffectiveValue(variableId: string, scopeKey: string, now: number = this.now()): Promise<string | null> {
    const row = await this.getRawValue(variableId, scopeKey);
    if (!row) return null;
    if (row.expiresAt != null && now >= row.expiresAt) return null;
    return row.value;
  }

  /** Upsert a value (and optional expiry) for (variableId, scopeKey). */
  async setValue(variableId: string, scopeKey: string, value: string | null, expiresAt: number | null = null): Promise<void> {
    const { automationVariableValues } = this.tables;
    const now = this.now();
    await this.upsert(
      automationVariableValues,
      { id: randomUUID(), variableId, scopeKey, value, expiresAt, updatedAt: now },
      [automationVariableValues.variableId, automationVariableValues.scopeKey],
      { value, expiresAt, updatedAt: now },
    );
  }

  /** Remove a single scoped value (e.g. clear a flag). */
  async clearValue(variableId: string, scopeKey: string): Promise<void> {
    const { automationVariableValues } = this.tables;
    await this.db
      .delete(automationVariableValues)
      .where(and(eq(automationVariableValues.variableId, variableId), eq(automationVariableValues.scopeKey, scopeKey)));
  }

  /** Sweep: delete all values whose flag TTL has elapsed. Returns rows removed. */
  async pruneExpired(now: number = this.now()): Promise<number> {
    const { automationVariableValues } = this.tables;
    const rows = await this.db.select().from(automationVariableValues);
    let removed = 0;
    for (const r of rows) {
      const rec = this.valRow(r);
      if (rec.expiresAt != null && now >= rec.expiresAt) {
        await this.db.delete(automationVariableValues).where(eq(automationVariableValues.id, rec.id));
        removed++;
      }
    }
    return removed;
  }
}
