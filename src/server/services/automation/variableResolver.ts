/**
 * Variable resolver (#3653, §5.2).
 *
 * Composes AutomationVariablesRepository + variableCodec + scope-key binding into
 * the typed read/write API the engine uses. Resolves a variable by name, keys it
 * from the runtime context (the trigger's subject node / source unless an explicit
 * reference is given), applies the flag TTL, and falls back to the configured
 * default when no value is stored.
 */
import type { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { AutomationVariablesRepository as VarsRepo } from '../../../db/repositories/automationVariables.js';
import {
  parseVarConfig,
  encodeValue,
  decodeValue,
  flagExpiry,
  type DecodedValue,
} from './variableCodec.js';

export interface VarContext {
  sourceId?: string | null;
  nodeNum?: number | null;
}

export interface SetResult {
  ok: boolean;
  error?: string;
}

export class VariableResolver {
  constructor(private readonly repo: AutomationVariablesRepository) {}

  /**
   * Read a variable by name in the given context. Returns the decoded value, the
   * configured default when nothing is stored, or null. Unknown variables and
   * un-resolvable scopes both return null.
   */
  async getValue(name: string, ctx: VarContext, now: number = Date.now()): Promise<DecodedValue> {
    const def = await this.repo.getVariableByName(name);
    if (!def) return null;
    const scopeKey = VarsRepo.buildScopeKey(def.scope, ctx);
    const cfg = parseVarConfig(def.config);

    if (scopeKey !== null) {
      const raw = await this.repo.getEffectiveValue(def.id, scopeKey, now);
      if (raw !== null) return decodeValue(def.type, raw);
    }
    // fall back to the configured default (typed through the codec)
    if (cfg.defaultValue !== undefined) {
      const enc = encodeValue(def.type, cfg.defaultValue);
      return enc === null ? null : decodeValue(def.type, enc);
    }
    return null;
  }

  /**
   * Write a variable. Rejects readonly constants and values that can't be
   * represented as the variable's type. For flags, a truthy value arms the flag
   * (with its TTL) and a falsy value clears it.
   */
  async setValue(name: string, value: unknown, ctx: VarContext, now: number = Date.now()): Promise<SetResult> {
    const def = await this.repo.getVariableByName(name);
    if (!def) return { ok: false, error: `unknown variable "${name}"` };
    if (def.readonly) return { ok: false, error: `variable "${name}" is readonly` };
    const scopeKey = VarsRepo.buildScopeKey(def.scope, ctx);
    if (scopeKey === null) return { ok: false, error: `missing scope context for "${name}" (${def.scope})` };

    if (def.type === 'flag') {
      const enc = encodeValue('flag', value === undefined ? true : value);
      if (enc !== 'true') {
        await this.repo.clearValue(def.id, scopeKey);
        return { ok: true };
      }
      const expiry = flagExpiry(parseVarConfig(def.config), now);
      await this.repo.setValue(def.id, scopeKey, 'true', expiry);
      return { ok: true };
    }

    const enc = encodeValue(def.type, value);
    if (enc === null) return { ok: false, error: `value not representable as ${def.type}` };
    await this.repo.setValue(def.id, scopeKey, enc, null);
    return { ok: true };
  }

  /** Arm a flag (truthy) in the given context. */
  async setFlag(name: string, ctx: VarContext, now: number = Date.now()): Promise<SetResult> {
    return this.setValue(name, true, ctx, now);
  }

  /** Clear a flag/value in the given context. */
  async clearFlag(name: string, ctx: VarContext): Promise<SetResult> {
    const def = await this.repo.getVariableByName(name);
    if (!def) return { ok: false, error: `unknown variable "${name}"` };
    if (def.readonly) return { ok: false, error: `variable "${name}" is readonly` };
    const scopeKey = VarsRepo.buildScopeKey(def.scope, ctx);
    if (scopeKey === null) return { ok: false, error: `missing scope context for "${name}"` };
    await this.repo.clearValue(def.id, scopeKey);
    return { ok: true };
  }

  /**
   * Increment a numeric (integer/float) variable by `delta`, seeding from the
   * default or 0. Rejects non-numeric variable types and readonly constants.
   */
  async increment(name: string, delta: number, ctx: VarContext, now: number = Date.now()): Promise<SetResult> {
    const def = await this.repo.getVariableByName(name);
    if (!def) return { ok: false, error: `unknown variable "${name}"` };
    if (def.type !== 'integer' && def.type !== 'float') {
      return { ok: false, error: `cannot increment a ${def.type} variable` };
    }
    const current = await this.getValue(name, ctx, now);
    const base = typeof current === 'number' ? current : 0;
    return this.setValue(name, base + delta, ctx, now);
  }
}
