/**
 * Trigger context extraction (#3653, §5.1).
 *
 * Pure helpers that turn a mesh event payload into the `trigger.*` field map the
 * conditions/interpolation read, plus the tight pre-filter matcher used by the
 * engine to fast-fail before heavier evaluation. Node/telemetry hydration of the
 * full DbNode happens in the engine; here we expose what the payload carries.
 */
import type { DbMessage } from '../../../services/database.js';
import type { TriggerType } from '../../../types/automation.js';

/** Meshtastic broadcast address (0xFFFFFFFF); also defined inline in the manager. */
export const BROADCAST_ADDR = 0xffffffff;

export interface TriggerContext {
  triggerType: TriggerType;
  sourceId: string | null;
  /** Subject node for node/sourceNode variable scope binding (sender / telemetry / updated node). */
  subjectNodeNum: number | null;
  timestamp: number;
  /** `trigger.*` values, keyed WITHOUT the `trigger.` prefix. */
  fields: Record<string, unknown>;
}

/** Derived hop count: hopStart − hopLimit when both present (0 ⇒ direct/zero-hop). */
export function deriveHops(msg: Pick<DbMessage, 'hopStart' | 'hopLimit'>): number | undefined {
  if (typeof msg.hopStart === 'number' && typeof msg.hopLimit === 'number') {
    return msg.hopStart - msg.hopLimit;
  }
  return undefined;
}

/** Build the trigger context for a `message:new` event. */
export function buildMessageContext(msg: DbMessage, sourceId: string | null, timestamp: number): TriggerContext {
  const to = Number(msg.toNodeNum);
  // Message ids are `${sourceId}_${fromNum}_${packetId}` (load-bearing format);
  // the trailing segment is the Meshtastic packet id used as a tapback replyId.
  const parsedPacketId = Number(String(msg.id).split('_').pop());
  const fields: Record<string, unknown> = {
    from: Number(msg.fromNodeNum),
    fromId: msg.fromNodeId,
    to,
    toId: msg.toNodeId,
    text: msg.text,
    channel: msg.channel,
    portnum: msg.portnum,
    packetId: Number.isFinite(parsedPacketId) ? parsedPacketId : undefined,
    hops: deriveHops(msg),
    hopStart: msg.hopStart,
    hopLimit: msg.hopLimit,
    isDM: to !== BROADCAST_ADDR,
    isBroadcast: to === BROADCAST_ADDR,
    wantAck: msg.wantAck,
    replyId: msg.replyId,
    emoji: msg.emoji,
    snr: msg.rxSnr,
    rssi: msg.rxRssi,
    viaMqtt: msg.viaMqtt,
    decryptedBy: msg.decryptedBy,
    sourceId,
    timestamp,
  };
  return {
    triggerType: 'trigger.message',
    sourceId,
    subjectNodeNum: Number(msg.fromNodeNum),
    timestamp,
    fields,
  };
}

/** Build the trigger context for a node discovered/updated event. */
export function buildNodeContext(
  triggerType: 'trigger.nodeDiscovered' | 'trigger.nodeUpdated',
  nodeNum: number,
  changedKeys: string[],
  sourceId: string | null,
  timestamp: number,
): TriggerContext {
  return {
    triggerType,
    sourceId,
    subjectNodeNum: Number(nodeNum),
    timestamp,
    fields: {
      nodeNum: Number(nodeNum),
      changed: changedKeys,
      sourceId,
      timestamp,
    },
  };
}

/** Build the trigger context for a single telemetry reading (engine fans the batch out). */
export function buildTelemetryContext(
  nodeNum: number,
  telemetryType: string,
  value: number,
  unit: string | undefined,
  sourceId: string | null,
  timestamp: number,
): TriggerContext {
  return {
    triggerType: 'trigger.telemetry',
    sourceId,
    subjectNodeNum: Number(nodeNum),
    timestamp,
    fields: { nodeNum: Number(nodeNum), telemetryType, value, unit, sourceId, timestamp },
  };
}

/** Build the trigger context for a geofence crossing. Subject node = the moving node. */
export function buildGeofenceContext(
  nodeNum: number,
  event: 'enter' | 'exit' | 'dwell',
  latitude: number,
  longitude: number,
  distanceKm: number,
  sourceId: string | null,
  timestamp: number,
): TriggerContext {
  return {
    triggerType: 'trigger.geofence',
    sourceId,
    subjectNodeNum: Number(nodeNum),
    timestamp,
    fields: { event, nodeNum: Number(nodeNum), latitude, longitude, distanceKm, sourceId, timestamp },
  };
}

/** Build the trigger context for a system event (bootup / source connect/disconnect). */
export function buildSystemContext(
  event: 'bootup' | 'source-connected' | 'source-disconnected',
  sourceId: string | null,
  nodeNum: number | null,
  reason: string | undefined,
  timestamp: number,
): TriggerContext {
  return {
    triggerType: 'trigger.system',
    sourceId,
    subjectNodeNum: nodeNum == null ? null : Number(nodeNum),
    timestamp,
    fields: { event, sourceId, nodeNum: nodeNum == null ? null : Number(nodeNum), reason, timestamp },
  };
}

/**
 * Tight pre-filter for `trigger.message`: cheap checks the engine runs before any
 * graph evaluation. Unset params don't constrain. Returns true on match.
 */
export function messageMatchesFilter(msg: DbMessage, params: Record<string, unknown> = {}): boolean {
  if (params.portnum != null && Number(msg.portnum) !== Number(params.portnum)) return false;
  if (params.from != null && Number(msg.fromNodeNum) !== Number(params.from)) return false;
  if (params.to != null && Number(msg.toNodeNum) !== Number(params.to)) return false;
  if (params.channel != null && Number(msg.channel) !== Number(params.channel)) return false;
  const text = msg.text ?? '';
  if (typeof params.textContains === 'string' && params.textContains.length > 0) {
    if (!text.toLowerCase().includes(params.textContains.toLowerCase())) return false;
  }
  if (typeof params.regex === 'string' && params.regex.length > 0) {
    let re: RegExp;
    try {
      re = new RegExp(params.regex);
    } catch {
      return false; // an invalid regex never matches
    }
    if (!re.test(text)) return false;
  }
  return true;
}

/**
 * Resolve a `{{ trigger.* }}` / system path against a context. Returns undefined
 * for unknown paths (interpolation renders those empty).
 */
export function resolveTriggerPath(ctx: TriggerContext, path: string, now: number): string | number | boolean | null | undefined {
  if (path === 'NOW') return now;
  if (path === 'trigger.sourceId') return ctx.sourceId ?? undefined;
  if (path === 'trigger.timestamp') return ctx.timestamp;
  if (path.startsWith('trigger.')) {
    const key = path.slice('trigger.'.length);
    const v = ctx.fields[key];
    return v == null ? undefined : (v as string | number | boolean);
  }
  return undefined;
}
