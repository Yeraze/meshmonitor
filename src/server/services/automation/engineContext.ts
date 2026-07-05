/**
 * Engine evaluation context + async field/path resolution (#3653).
 *
 * The `EngineEvalContext` is the `Ctx` threaded through the graph evaluator hooks.
 * It bundles the trigger fields (§5.1), the variable resolver (§5.2), a node-data
 * provider (for hydrating the subject node + its latest telemetry during condition
 * evaluation), the variable-scope context, and the run clock.
 *
 * Condition "fields" can reference: the trigger event (`hops`, `text`, …),
 * `node.*` (hydrated subject node incl. calculated `ageMinutes`/`roleName`), and
 * `telemetry.*` (latest reading per metric for the subject node).
 */
import { type TriggerContext, resolveTriggerPath } from './triggerContext.js';
import type { VariableResolver, VarContext } from './variableResolver.js';
import { interpolate, extractPaths, type InterpolationValue } from './interpolate.js';

/** Subset of a node record used for condition fields. */
export interface NodeFacts {
  nodeNum: number;
  nodeId?: string;
  longName?: string;
  shortName?: string;
  role?: number;
  hwModel?: number;
  hopsAway?: number;
  lastHeard?: number;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  batteryLevel?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  snr?: number;
  isFavorite?: boolean;
}

/** Hydrates the subject node + latest telemetry during evaluation. Injected for testability. */
export interface NodeDataProvider {
  getNode(sourceId: string | null, nodeNum: number): Promise<NodeFacts | null>;
  getTelemetry(sourceId: string | null, nodeNum: number, telemetryType: string): Promise<number | null>;
  /**
   * Resolve a source's channel slot index to its channel name, for
   * `trigger.message` channel-by-name matching. Optional — providers that don't
   * implement it disable name matching (the filter then never matches a name).
   */
  getChannelName?(sourceId: string | null, channelIndex: number): Promise<string | null>;
  /**
   * All channels for a source as {slot, name, psk, role}, for resolving a
   * unified channel (by name) to its local slot when sending. Optional.
   */
  getChannels?(sourceId: string | null): Promise<Array<{ id: number; name: string; psk?: string | null; role?: number | null }>>;
  /**
   * Coarse protocol of a source ('meshtastic' | 'meshcore' | 'other'), so a
   * unified channel only sends to sources of its own protocol. Optional.
   */
  getSourceProtocol?(sourceId: string | null): Promise<string | null>;
  /**
   * Own/local node number for a Meshtastic source — used to drop self-originated
   * events (messages/telemetry/node updates our own node produced) so automations
   * never fire on MeshMonitor's own traffic (#3914). Optional; absent → no drop.
   */
  getLocalNodeNum?(sourceId: string | null): Promise<number | null>;
  /**
   * Own/local node public key for a MeshCore source — the self signal for MeshCore
   * received messages (#3914). Optional; absent → no drop.
   */
  getSelfPublicKey?(sourceId: string | null): Promise<string | null>;
}

export interface EngineEvalContext {
  trigger: TriggerContext;
  vars: VariableResolver;
  data: NodeDataProvider;
  varCtx: VarContext;
  now: number;
  /** internal memo for the hydrated subject node (do not set directly). */
  __nodeP?: Promise<NodeFacts | null>;
}

/** Meshtastic Config.DeviceConfig.Role names by enum value. */
export const ROLE_NAMES = [
  'CLIENT', 'CLIENT_MUTE', 'ROUTER', 'ROUTER_CLIENT', 'REPEATER', 'TRACKER',
  'SENSOR', 'TAK', 'CLIENT_HIDDEN', 'LOST_AND_FOUND', 'TAK_TRACKER', 'ROUTER_LATE',
];

export function varContextFromTrigger(trigger: TriggerContext): VarContext {
  return { sourceId: trigger.sourceId, nodeNum: trigger.subjectNodeNum };
}

/** Hydrate (once) the trigger's subject node. Null when there is no subject node. */
export function getSubjectNode(ctx: EngineEvalContext): Promise<NodeFacts | null> {
  if (ctx.__nodeP === undefined) {
    const nn = ctx.trigger.subjectNodeNum;
    ctx.__nodeP = nn == null ? Promise.resolve(null) : ctx.data.getNode(ctx.trigger.sourceId, nn);
  }
  return ctx.__nodeP;
}

/** Resolve a single `{{ }}` path: `var.` (async) or `trigger.`/system (sync). */
/**
 * Resolve a `var.NAME` or nested `var.NAME.a.b` reference. Splits on the FIRST
 * dot: NAME is the variable (names contain no dots), the remainder is a path
 * into its value (e.g. a JSON-typed variable holding a script result). Returns
 * the traversed value, or undefined if the variable or any path segment is
 * missing / not an object.
 */
export async function resolveVarValue(
  vars: VariableResolver,
  fullName: string,
  varCtx: VarContext,
  now: number,
): Promise<unknown> {
  const dot = fullName.indexOf('.');
  const name = dot === -1 ? fullName : fullName.slice(0, dot);
  const segments = dot === -1 ? [] : fullName.slice(dot + 1).split('.').filter(Boolean);
  let value: unknown = await vars.getValue(name, varCtx, now);
  for (const seg of segments) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[seg];
  }
  return value;
}

export async function resolvePath(ctx: EngineEvalContext, path: string): Promise<InterpolationValue> {
  if (path.startsWith('var.')) {
    const v = await resolveVarValue(ctx.vars, path.slice('var.'.length), ctx.varCtx, ctx.now);
    if (v == null) return undefined;
    // Render objects/arrays as JSON so {{ var.obj }} shows the blob; scalars pass through.
    return typeof v === 'object' ? JSON.stringify(v) : (v as InterpolationValue);
  }
  return resolveTriggerPath(ctx.trigger, path, ctx.now);
}

export async function interpolateAsync(
  template: string,
  ctx: EngineEvalContext,
  opts?: { varsOnly?: boolean },
): Promise<string> {
  if (typeof template !== 'string' || template.indexOf('{{') === -1) return template;
  const paths = extractPaths(template);
  const resolved = new Map<string, InterpolationValue>();
  for (const p of paths) {
    // `varsOnly` (used for sensitive fields like Apprise URLs) permits only
    // `var.*` — never mesh-controlled `trigger.*`, which would let an inbound
    // message inject an arbitrary notification target.
    if (opts?.varsOnly && !p.startsWith('var.')) { resolved.set(p, undefined); continue; }
    resolved.set(p, await resolvePath(ctx, p));
  }
  return interpolate(template, (p) => resolved.get(p));
}

export async function resolveOperand(ctx: EngineEvalContext, raw: unknown): Promise<unknown> {
  if (typeof raw === 'string' && raw.indexOf('{{') !== -1) return interpolateAsync(raw, ctx);
  return raw;
}

/**
 * Resolve a condition "field" to its value. Namespaces:
 *  - `node.<prop>`     hydrated subject node (+ calculated `ageMinutes`, `roleName`)
 *  - `telemetry.<type>` latest telemetry reading of that metric for the subject node
 *  - anything else     the trigger event field (hops, text, value, …)
 */
export async function resolveFieldValue(ctx: EngineEvalContext, field: string): Promise<unknown> {
  if (!field) return undefined;

  if (field.startsWith('node.')) {
    const node = await getSubjectNode(ctx);
    if (!node) return undefined;
    const prop = field.slice('node.'.length);
    if (prop === 'ageMinutes') {
      if (node.lastHeard == null) return undefined;
      const lastMs = node.lastHeard > 1e12 ? node.lastHeard : node.lastHeard * 1000; // tolerate s or ms
      return Math.max(0, Math.round((ctx.now - lastMs) / 60000));
    }
    if (prop === 'roleName') return node.role == null ? undefined : (ROLE_NAMES[node.role] ?? String(node.role));
    return (node as unknown as Record<string, unknown>)[prop];
  }

  if (field.startsWith('telemetry.')) {
    if (ctx.trigger.subjectNodeNum == null) return undefined;
    return ctx.data.getTelemetry(ctx.trigger.sourceId, ctx.trigger.subjectNodeNum, field.slice('telemetry.'.length));
  }

  if (field.startsWith('trigger.')) return ctx.trigger.fields[field.slice('trigger.'.length)];
  return ctx.trigger.fields[field];
}
