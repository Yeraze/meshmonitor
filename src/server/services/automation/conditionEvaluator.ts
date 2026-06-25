/**
 * Condition evaluator (#3653, §5).
 *
 * Evaluates a single `condition.*` node against an EngineEvalContext → boolean.
 * Operands may be literals or `{{ }}` templates (resolved async, incl. var.*).
 * Unknown/missing data evaluates to false (a condition never throws).
 */
import type { AutomationNode, NumericOp } from '../../../types/automation.js';
import {
  type EngineEvalContext,
  resolveFieldValue,
  resolveOperand,
  resolveVarValue,
  getSubjectNode,
} from './engineContext.js';
import { haversineKm } from './geo.js';
import { compileUserRegex } from '../../../utils/safeRegex.js';

function numericCompare(op: string, a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  switch (op as NumericOp) {
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '==': return a === b;
    case '!=': return a !== b;
    default: return false;
  }
}

function stringCompare(op: string, a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  switch (op) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    case 'contains': return al.includes(bl);
    case 'notContains': return !al.includes(bl);
    case 'startsWith': return al.startsWith(bl);
    case 'endsWith': return al.endsWith(bl);
    case 'regex':
      // RE2 (linear-time) — immune to ReDoS from user-supplied patterns.
      try { return compileUserRegex(b).test(a); } catch { return false; }
    default: return false;
  }
}


function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function parseHHMM(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Evaluate a condition node → boolean. */
export async function evaluateCondition(node: AutomationNode, ctx: EngineEvalContext): Promise<boolean> {
  const p = (node.params ?? {}) as Record<string, unknown>;
  switch (node.type) {
    case 'condition.always':
      return true; // explicit pass-through — run the actions unconditionally

    case 'condition.sourceFilter': {
      const ids = Array.isArray(p.sourceIds) ? (p.sourceIds as unknown[]).map(String) : [];
      if (ids.length === 0) return true; // no constraint
      return ctx.trigger.sourceId != null && ids.includes(ctx.trigger.sourceId);
    }

    case 'condition.numeric': {
      const left = asNumber(await resolveFieldValue(ctx, String(p.field ?? '')));
      const right = asNumber(await resolveOperand(ctx, p.value));
      return numericCompare(String(p.op ?? ''), left, right);
    }

    case 'condition.string': {
      const left = String((await resolveFieldValue(ctx, String(p.field ?? ''))) ?? '');
      const right = String((await resolveOperand(ctx, p.value)) ?? '');
      return stringCompare(String(p.op ?? 'eq'), left, right);
    }

    case 'condition.variable': {
      const name = String(p.variable ?? '');
      if (!name) return false;
      // resolveVarValue supports nested access (var "data.status") for JSON vars;
      // a plain name behaves exactly like getValue.
      const value = await resolveVarValue(ctx.vars, name, ctx.varCtx, ctx.now);
      if (p.op == null) {
        // "is set / truthy": flag present, non-empty string, non-zero number, true
        if (value == null) return false;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        return String(value).length > 0;
      }
      const right = await resolveOperand(ctx, p.value);
      const rn = asNumber(right);
      const ln = asNumber(value);
      if (Number.isFinite(rn) && Number.isFinite(ln)) {
        return numericCompare(String(p.op), ln, rn);
      }
      return stringCompare(String(p.op), String(value ?? ''), String(right ?? ''));
    }

    case 'condition.distance': {
      // Distance from the subject node's position to a reference lat/lon.
      const node = await getSubjectNode(ctx);
      const lat = asNumber(node?.latitude ?? ctx.trigger.fields.latitude);
      const lon = asNumber(node?.longitude ?? ctx.trigger.fields.longitude);
      const refLat = asNumber(p.lat);
      const refLon = asNumber(p.lon);
      if (![lat, lon, refLat, refLon].every(Number.isFinite)) return false;
      const km = haversineKm(lat, lon, refLat, refLon);
      return numericCompare(String(p.op ?? '<'), km, asNumber(p.km));
    }

    case 'condition.timeRange': {
      const start = parseHHMM(p.start);
      const end = parseHHMM(p.end);
      if (start == null || end == null) return false;
      const d = new Date(ctx.now);
      if (Array.isArray(p.days) && p.days.length > 0) {
        if (!(p.days as unknown[]).map(Number).includes(d.getDay())) return false;
      }
      const cur = minutesOfDay(d);
      // same-day window vs overnight window (start > end)
      return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
    }

    case 'condition.logical': {
      const op = String(p.op ?? 'AND').toUpperCase();
      const subs = Array.isArray(p.conditions) ? (p.conditions as AutomationNode[]) : [];
      if (op === 'NOT') {
        if (subs.length === 0) return false;
        return !(await evaluateCondition(subs[0], ctx));
      }
      const results = await Promise.all(subs.map((s) => evaluateCondition(s, ctx)));
      if (op === 'OR') return results.some(Boolean);
      return results.every(Boolean); // AND (and default)
    }

    default:
      return false;
  }
}
