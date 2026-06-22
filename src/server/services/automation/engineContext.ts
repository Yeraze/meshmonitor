/**
 * Engine evaluation context + async path resolution (#3653).
 *
 * The `EngineEvalContext` is the `Ctx` threaded through the graph evaluator hooks
 * (condition/action/setVar). It bundles the trigger fields (§5.1), the variable
 * resolver (§5.2), the derived variable-scope context, and the run clock.
 *
 * `{{ }}` interpolation resolves three namespaces — `trigger.*`/system vars (sync)
 * and `var.*` (async DB read) — so templating is async here: we pre-resolve every
 * referenced path, then run the sync interpolate() over the resolved map.
 */
import { type TriggerContext, resolveTriggerPath } from './triggerContext.js';
import type { VariableResolver, VarContext } from './variableResolver.js';
import { interpolate, extractPaths, type InterpolationValue } from './interpolate.js';

export interface EngineEvalContext {
  trigger: TriggerContext;
  vars: VariableResolver;
  varCtx: VarContext;
  now: number;
}

/** Build the variable-scope context (subject node + source) from the trigger. */
export function varContextFromTrigger(trigger: TriggerContext): VarContext {
  return { sourceId: trigger.sourceId, nodeNum: trigger.subjectNodeNum };
}

/** Resolve a single `{{ }}` path: `var.` (async) or `trigger.`/system (sync). */
export async function resolvePath(ctx: EngineEvalContext, path: string): Promise<InterpolationValue> {
  if (path.startsWith('var.')) {
    const v = await ctx.vars.getValue(path.slice('var.'.length), ctx.varCtx, ctx.now);
    return v ?? undefined;
  }
  return resolveTriggerPath(ctx.trigger, path, ctx.now);
}

/** Interpolate a template, pre-resolving all referenced paths (incl. async var.*). */
export async function interpolateAsync(template: string, ctx: EngineEvalContext): Promise<string> {
  if (typeof template !== 'string' || template.indexOf('{{') === -1) return template;
  const paths = extractPaths(template);
  const resolved = new Map<string, InterpolationValue>();
  for (const p of paths) {
    resolved.set(p, await resolvePath(ctx, p));
  }
  return interpolate(template, (p) => resolved.get(p));
}

/**
 * Resolve a condition/action operand that may be a literal or a `{{ }}` template.
 * Templates are interpolated (async) to a string; literals pass through.
 */
export async function resolveOperand(ctx: EngineEvalContext, raw: unknown): Promise<unknown> {
  if (typeof raw === 'string' && raw.indexOf('{{') !== -1) {
    return interpolateAsync(raw, ctx);
  }
  return raw;
}

/** Resolve a condition "field" reference to its value from the trigger fields. */
export function resolveField(ctx: EngineEvalContext, field: string): unknown {
  if (field.startsWith('trigger.')) {
    return ctx.trigger.fields[field.slice('trigger.'.length)];
  }
  return ctx.trigger.fields[field];
}
