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
import { type TriggerContext, resolveTriggerPath, subjectKeyOf } from './triggerContext.js';
import type { VariableResolver, VarContext } from './variableResolver.js';
import { interpolate, extractPaths, type InterpolationValue } from './interpolate.js';
import type { CooldownScope } from '../../../types/automation.js';
import { isNodeComplete } from '../../../utils/nodeHelpers.js';

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
  /** MeshMonitor-computed mobility: 0 = stationary, 1 = mobile (>100 m history span). */
  mobile?: number;
}

/**
 * One node's staleness inputs, protocol-agnostic (#4558 Phase A). Emitted by
 * {@link NodeDataProvider.listNodesForStaleCheck} for the periodic
 * `trigger.nodeStale` / `trigger.nodeOnline` evaluation. `lastHeardMs` is
 * normalized to epoch MILLISECONDS regardless of protocol (Meshtastic stores
 * lastHeard in seconds, MeshCore in ms) so the engine compares one unit.
 */
export interface StaleCandidate {
  sourceId: string | null;
  /** Meshtastic node number; null for a MeshCore node. */
  nodeNum: number | null;
  /** MeshCore public key; null for a Meshtastic node. */
  publicKey: string | null;
  /** Epoch ms of last contact, or null if never heard (skipped by the checker). */
  lastHeardMs: number | null;
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
   * Current position of a waypoint, for a geofence anchored to one rather than
   * to a drawn region (#4722). Resolved on every geofence check so moving the
   * waypoint moves the fence with no edit to the automation.
   *
   * Returns null when the waypoint is gone — deleted, or belonging to a source
   * that no longer exists. Such a fence must fail CLOSED (never fire) rather
   * than fall back to some other region: silently fencing the wrong place is
   * worse than not firing, and the trace says which waypoint went missing.
   *
   * Optional — providers that don't implement it disable waypoint anchoring
   * entirely, which is the same fail-closed behaviour.
   */
  getWaypoint?(sourceId: string, waypointId: number): Promise<{ latitude: number; longitude: number } | null>;
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
   * Exact configured type of a source (`meshtastic_tcp` | `mqtt_broker` |
   * `mqtt_bridge` | `meshcore`), where `getSourceProtocol` only exposes the
   * coarse protocol family. Used to tell "arrived through an MQTT source" from
   * "arrived over our own RF link" when picking the hop/MQTT emoji (#4594).
   * Optional; absent → treated as not-MQTT, i.e. today's behaviour.
   */
  getSourceType?(sourceId: string | null): Promise<string | null>;
  /**
   * Own/local node number for a Meshtastic source — used to drop self-originated
   * events (messages/telemetry/node updates our own node produced) so automations
   * never fire on MeshMonitor's own traffic (#3914). Optional; absent → no drop.
   */
  getLocalNodeNum?(sourceId: string | null): Promise<number | null>;
  /**
   * True when a node number belongs to ANY source MeshMonitor owns. The
   * per-source `getLocalNodeNum` is null for a source with no local identity —
   * an `mqtt_bridge` — yet our own messages still arrive there, relayed to the
   * broker by third-party gateways. Without this the #3914 self-origin guard is
   * a no-op on bridges and an automation can answer its own reply forever
   * (#4593). Optional; absent → no extra drop.
   */
  isOwnNodeNum?(nodeNum: number): Promise<boolean>;
  /**
   * Own/local node public key for a MeshCore source — the self signal for MeshCore
   * received messages (#3914). Optional; absent → no drop.
   */
  getSelfPublicKey?(sourceId: string | null): Promise<string | null>;
  /** True when a MeshCore public key belongs to ANY MeshCore source MeshMonitor owns —
   *  cross-source fallback for the self-guard on multi-MC-source / bridge setups (#4577 P2). */
  isOwnPublicKey?(pubkey: string): Promise<boolean>;
  /**
   * Enumerate every tracked node with its last-heard time across ALL sources and
   * BOTH protocols, for the periodic staleness check (`trigger.nodeStale` /
   * `trigger.nodeOnline`, #4558 Phase A). Staleness is packet ABSENCE — there is
   * no event to react to — so the engine polls this on a timer instead. Optional;
   * absent → staleness checks are a no-op (e.g. unit tests that don't wire it).
   */
  listNodesForStaleCheck?(): Promise<StaleCandidate[]>;
  /**
   * Battery-level (%) history for a Meshtastic node since a cutoff, for the
   * periodic declining-battery check (`trigger.batteryTrend`, #4558 Phase E).
   * Reads the durable `batteryLevel` telemetry time-series — so the trend is
   * recomputed from the database each tick and a process restart never replays
   * an alert. `sinceMs` is an epoch-MILLISECONDS cutoff (telemetry timestamps
   * are epoch ms). Returns `{ timestamp, value }` samples in any order (the
   * engine picks the window's oldest and newest by timestamp). Optional; absent
   * → battery-trend checks are a no-op (e.g. unit tests that don't wire it).
   *
   * For MeshCore nodes use {@link getMeshCoreBatteryTrendSamples} instead — they
   * have no numeric node id and report battery in volts, not %.
   */
  getBatteryTrendSamples?(
    sourceId: string | null,
    nodeNum: number,
    sinceMs: number,
  ): Promise<Array<{ timestamp: number; value: number }>>;
  /**
   * Battery-VOLTAGE history for a MeshCore node since a cutoff, for the periodic
   * declining-battery check (`trigger.batteryTrend`, #4558 follow-up). The
   * MeshCore analogue of {@link getBatteryTrendSamples}: keyed by the node's
   * `publicKey` (MeshCore has no numeric node id) and returning VOLTS samples
   * (MeshCore reports no battery %). Reads the durable MeshCore battery telemetry
   * series (`mc_battery_volts`, falling back to `mc_status_battery_volts`) so the
   * trend is recomputed from the DB each tick and a restart never replays an
   * alert. `sinceMs` is an epoch-MILLISECONDS cutoff. Because the unit is volts,
   * the engine interprets the drop as a RELATIVE percentage decline against the
   * window's oldest sample so a single `minDropPercent` threshold still applies.
   * Optional; absent → MeshCore battery-trend checks are a no-op.
   */
  getMeshCoreBatteryTrendSamples?(
    sourceId: string | null,
    publicKey: string,
    sinceMs: number,
  ): Promise<Array<{ timestamp: number; value: number }>>;
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

/**
 * The three states of `node.completeness` (#4340 Phase 3).
 *
 *  - 'complete'    the subject node's row exists and isNodeComplete() passes
 *                  (real longName, a shortName, and an hwModel from NODEINFO).
 *  - 'incomplete'  the row exists but NODEINFO has not arrived.
 *  - 'unknown'     there is NO row for the subject, or the event has no subject
 *                  node at all (Schedule / System / MeshCore).
 *
 * The third state is the point. Auto-Acknowledge skips a sender only when the
 * row EXISTS and is incomplete (`if (fromNode && !isNodeComplete(fromNode))`,
 * meshtasticManager.ts:10084) — an unknown sender is NOT skipped. A boolean
 * field cannot express that: a missing row and an incomplete row both resolve
 * to a falsy/undefined value. So the AutoAck rule is
 * `node.completeness in (complete, unknown)`.
 */
export const NODE_COMPLETENESS = ['complete', 'incomplete', 'unknown'] as const;
export type NodeCompleteness = (typeof NODE_COMPLETENESS)[number];

export function varContextFromTrigger(trigger: TriggerContext): VarContext {
  return { sourceId: trigger.sourceId, nodeNum: trigger.subjectNodeNum };
}

/** Truncate a long subject id (a 64-char MeshCore pubkey) for trace/log copy. */
function shortSubject(id: string): string {
  return id.length > 16 ? `${id.slice(0, 12)}…` : id;
}

export interface CooldownKeyResolution {
  /** Map key. '' is the automation-wide key (also the degraded fallback). */
  key: string;
  /** Human phrase naming the key, for the cooldown trace reason. */
  label: string;
  /** True when the requested scope could not be honoured and we fell back. */
  degraded: boolean;
}

/**
 * Resolve a trigger context to its cooldown key under `scope` (#4340 Phase 2).
 *
 * Key shapes intentionally match AutomationVariablesRepository.buildScopeKey's
 * global/node/sourceNode shapes ('' / '<node>' / '<source>:<node>') — pinned by
 * a cross-check test — so cooldown keys and variable scope keys read alike.
 * It is NOT called directly: buildScopeKey's ctx.nodeNum is typed `number` and
 * widening it to accept a MeshCore pubkey string would silently let VARIABLE
 * scoping key off pubkeys too, a behaviour change we explicitly do not want.
 *
 * When the requested scope cannot be honoured (no subject node on a schedule /
 * system / MeshCore-channel event, or no sourceId under 'sourceNode'), this
 * degrades to the automation-wide key — today's exact behaviour — rather than
 * never firing or never cooling down. See COOLDOWN_SCOPES for why.
 */
export function cooldownKeyFor(scope: CooldownScope, trigger: TriggerContext): CooldownKeyResolution {
  if (scope === 'automation') return { key: '', label: 'automation-wide', degraded: false };
  const node = subjectKeyOf(trigger);
  if (node == null) {
    return { key: '', label: 'automation-wide (this event has no subject node)', degraded: true };
  }
  if (scope === 'node') return { key: node, label: `node ${shortSubject(node)}`, degraded: false };
  const src = trigger.sourceId;
  if (!src) {
    return { key: '', label: 'automation-wide (this event has no source)', degraded: true };
  }
  return { key: `${src}:${node}`, label: `source ${src} · node ${shortSubject(node)}`, degraded: false };
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
  // Same namespaces conditions use (`node.*` / `telemetry.*`) so message templates
  // can say {{ node.longName }} on becameMobile / leftHome / nodeUpdated / …
  if (path.startsWith('node.') || path.startsWith('telemetry.')) {
    const v = await resolveFieldValue(ctx, path);
    if (v == null) return undefined;
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
    const prop = field.slice('node.'.length);
    // #4340 Phase 3: resolved BEFORE the `!node` guard below, because "there is no
    // node row" is a meaningful VALUE here ('unknown'), not a missing field.
    if (prop === 'completeness') {
      return node ? (isNodeComplete(node) ? 'complete' : 'incomplete') : 'unknown';
    }
    if (!node) return undefined;
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
