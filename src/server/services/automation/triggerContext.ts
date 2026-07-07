/**
 * Trigger context extraction (#3653, §5.1).
 *
 * Pure helpers that turn a mesh event payload into the `trigger.*` field map the
 * conditions/interpolation read, plus the tight pre-filter matcher used by the
 * engine to fast-fail before heavier evaluation. Node/telemetry hydration of the
 * full DbNode happens in the engine; here we expose what the payload carries.
 */
import type { DbMessage } from '../../../services/database.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import type { TriggerType } from '../../../types/automation.js';
import { compileUserRegex } from '../../../utils/safeRegex.js';

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

/**
 * Optional pre-resolved labels the caller (engine service) looks up from the DB
 * and threads into the builder, so the pure builder stays DB-free. Populate the
 * universal `fromName` / `channelName` / `senderLabel` tokens (#3978).
 */
export interface MessageContextLabels {
  /** Sender's display name (long name → short name). The builder falls back to `fromId`. */
  fromName?: string | null;
  /** The message's channel slot name for its source. Ignored for DMs. */
  channelName?: string | null;
}

/** Build the trigger context for a `message:new` event. */
export function buildMessageContext(
  msg: DbMessage,
  sourceId: string | null,
  timestamp: number,
  labels?: MessageContextLabels,
): TriggerContext {
  const to = Number(msg.toNodeNum);
  // Message ids are `${sourceId}_${fromNum}_${packetId}` (load-bearing format);
  // the trailing segment is the Meshtastic packet id used as a tapback replyId.
  const parsedPacketId = Number(String(msg.id).split('_').pop());
  const isDM = to !== BROADCAST_ADDR;
  const isBroadcast = to === BROADCAST_ADDR;
  const fromId = msg.fromNodeId != null ? String(msg.fromNodeId) : undefined;
  // Universal, cross-protocol tokens (#3978). `fromName` is the sender's display
  // name degrading long → short → id; `channelName` is the channel's name (no
  // meaningful channel label on a DM); `senderLabel` is the "just works" label
  // for addressing a reply, preferring the name, then the channel, then the id.
  const fromName = (labels?.fromName && String(labels.fromName).trim()) || fromId;
  const channelName = isDM ? undefined : (labels?.channelName ?? undefined);
  const senderLabel = fromName || channelName || fromId;
  const fields: Record<string, unknown> = {
    from: Number(msg.fromNodeNum),
    fromId: msg.fromNodeId,
    fromName,
    to,
    toId: msg.toNodeId,
    text: msg.text,
    channel: msg.channel,
    channelName,
    senderLabel,
    portnum: msg.portnum,
    packetId: Number.isFinite(parsedPacketId) ? parsedPacketId : undefined,
    hops: deriveHops(msg),
    hopStart: msg.hopStart,
    hopLimit: msg.hopLimit,
    isDM,
    isChannel: isBroadcast,
    isBroadcast,
    wantAck: msg.wantAck,
    replyId: msg.replyId,
    emoji: msg.emoji,
    snr: msg.rxSnr,
    rssi: msg.rxRssi,
    viaMqtt: msg.viaMqtt,
    decryptedBy: msg.decryptedBy,
    protocol: 'meshtastic',
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

/**
 * A received MeshCore channel message carries no sender pubkey on the wire, so
 * the manager stores the channel slot in `fromPublicKey` as `channel-<idx>`
 * (see `MeshCoreManager.channelPublicKey`). Parse that back to the slot index;
 * returns undefined for DMs/room posts (a real/author pubkey, not a channel).
 */
export function parseMeshCoreChannelIdx(fromPublicKey: string | undefined): number | undefined {
  const m = /^channel-(\d+)$/.exec(fromPublicKey ?? '');
  return m ? Number(m[1]) : undefined;
}

/**
 * Build the trigger context for a MeshCore `meshcore:message` event (#3833).
 *
 * MeshCore identity is a public-key string — there is no Meshtastic `nodeNum`,
 * `portnum`, or numeric packet id — so this is a parallel builder to
 * {@link buildMessageContext} rather than a coercion into `DbMessage` (which
 * would corrupt the `Number()`-based matcher). `triggerType` stays
 * `'trigger.message'` so the SAME message automations fire on both protocols.
 */
export function buildMeshCoreMessageContext(
  msg: MeshCoreMessage,
  sourceId: string | null,
  timestamp: number,
  labels?: { channelName?: string | null },
): TriggerContext {
  const channelIdx = parseMeshCoreChannelIdx(msg.fromPublicKey);
  const isChannel = channelIdx !== undefined;
  const isRoom = msg.messageType === 'room_post';
  // DM = addressed to us (recipient pubkey set) and not a channel/room post.
  const isDM = !isChannel && !isRoom && msg.toPublicKey != null;
  const scopeCode = msg.scopeCode ?? undefined;
  const fromName = msg.fromName ?? undefined;
  const fromId = msg.fromPublicKey != null ? String(msg.fromPublicKey) : undefined;
  // channelName is only meaningful for a channel post; DMs/room posts have none.
  const channelName = isChannel ? (labels?.channelName ?? undefined) : undefined;
  // Universal "just works" reply label (#3978): the sender's name if we have one
  // (channel posts may carry no name prefix), else the channel name, else the raw
  // id (a pubkey for DMs/rooms, or the synthetic `channel-<idx>` key).
  const senderLabel = fromName || channelName || fromId;
  const fields: Record<string, unknown> = {
    // MeshCore senders are pubkey strings; channel messages have no per-sender
    // pubkey, so `from` is the synthetic `channel-<idx>` key. `fromName` carries
    // the display name a channel sender prefixed onto the body, when present.
    from: msg.fromPublicKey,
    fromId: msg.fromPublicKey,
    fromName,
    channelName,
    senderLabel,
    to: msg.toPublicKey,
    toId: msg.toPublicKey,
    text: msg.text,
    channel: channelIdx,
    isDM,
    isChannel,
    isBroadcast: isChannel,
    hops: msg.hopCount ?? undefined,
    snr: msg.snr,
    rssi: msg.rssi,
    // MeshCore scope/region (#3833). `scopeCode` 0 = explicitly unscoped, null/
    // absent = no scope info; `scopeName` = resolved region name (null when
    // unscoped or scoped-but-unknown). Powers the "respond on trigger scope" mode.
    scopeCode,
    scopeName: msg.scopeName ?? undefined,
    scoped: scopeCode != null && scopeCode !== 0,
    protocol: 'meshcore',
    sourceId,
    timestamp,
  };
  return {
    triggerType: 'trigger.message',
    sourceId,
    // No Meshtastic-style numeric node → no node.* hydration for MeshCore messages.
    subjectNodeNum: null,
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

/** System events the engine can raise (param `event` on a `trigger.system` block). */
export type SystemEvent = 'bootup' | 'source-connected' | 'source-disconnected' | 'upgrade-available';

/**
 * Build the trigger context for a system event. `extra` carries event-specific
 * fields (e.g. upgrade-available → latestVersion / currentVersion / releaseUrl)
 * that conditions and {{ trigger.* }} interpolation can read.
 */
export function buildSystemContext(
  event: SystemEvent,
  sourceId: string | null,
  nodeNum: number | null,
  reason: string | undefined,
  timestamp: number,
  extra?: Record<string, unknown>,
): TriggerContext {
  return {
    triggerType: 'trigger.system',
    sourceId,
    subjectNodeNum: nodeNum == null ? null : Number(nodeNum),
    timestamp,
    fields: { event, sourceId, nodeNum: nodeNum == null ? null : Number(nodeNum), reason, timestamp, ...extra },
  };
}

/** Context for a `trigger.schedule` cron tick — no mesh payload, no subject node. */
export function buildScheduleContext(sourceId: string | null, timestamp: number): TriggerContext {
  return {
    triggerType: 'trigger.schedule',
    sourceId,
    subjectNodeNum: null,
    timestamp,
    fields: { sourceId, timestamp },
  };
}

/**
 * Tight pre-filter for `trigger.message`: cheap checks the engine runs before any
 * graph evaluation. Unset params don't constrain. Returns true on match.
 */
/**
 * @param channelName Pre-resolved name of `msg.channel` for its source (the engine
 *   resolves the per-source slot→name once before filtering). Required for the
 *   `params.channelName` check to match; when absent, a channelName filter fails.
 */
export function messageMatchesFilter(msg: DbMessage, params: Record<string, unknown> = {}, channelName?: string | null): boolean {
  if (params.portnum != null && Number(msg.portnum) !== Number(params.portnum)) return false;
  if (params.from != null && Number(msg.fromNodeNum) !== Number(params.from)) return false;
  if (params.to != null && Number(msg.toNodeNum) !== Number(params.to)) return false;
  if (params.channel != null && Number(msg.channel) !== Number(params.channel)) return false;
  // Channel-by-name: portable across sources where the channel sits in a
  // different slot. Case-insensitive; a non-resolving channel never matches.
  if (typeof params.channelName === 'string' && params.channelName.length > 0) {
    if (!channelName || channelName.toLowerCase() !== params.channelName.toLowerCase()) return false;
  }
  const text = msg.text ?? '';
  if (typeof params.textContains === 'string' && params.textContains.length > 0) {
    if (!text.toLowerCase().includes(params.textContains.toLowerCase())) return false;
  }
  if (typeof params.regex === 'string' && params.regex.length > 0) {
    let re: RegExp;
    try {
      // RE2 (linear-time) — immune to ReDoS from user-supplied patterns.
      re = compileUserRegex(params.regex);
    } catch {
      return false; // an invalid/unsupported regex never matches
    }
    if (!re.test(text)) return false;
  }
  return true;
}

/**
 * Pre-filter for MeshCore `trigger.message` events — the MeshCore analogue of
 * {@link messageMatchesFilter}. Honors only cross-protocol params (text/regex/
 * channel/channelName). Meshtastic-only params (`from`/`to`/`portnum`) express
 * node-number intent that can't match a MeshCore pubkey sender, so their
 * presence forces a non-match (a "from node #N" rule never fires on MeshCore).
 *
 * @param channelName Pre-resolved name of the message's channel slot for its
 *   source (same contract as {@link messageMatchesFilter}).
 */
export function meshCoreMessageMatchesFilter(
  msg: MeshCoreMessage,
  params: Record<string, unknown> = {},
  channelName?: string | null,
): boolean {
  if (params.portnum != null || params.from != null || params.to != null) return false;
  const channelIdx = parseMeshCoreChannelIdx(msg.fromPublicKey);
  if (params.channel != null && Number(channelIdx) !== Number(params.channel)) return false;
  if (typeof params.channelName === 'string' && params.channelName.length > 0) {
    if (!channelName || channelName.toLowerCase() !== params.channelName.toLowerCase()) return false;
  }
  const text = msg.text ?? '';
  if (typeof params.textContains === 'string' && params.textContains.length > 0) {
    if (!text.toLowerCase().includes(params.textContains.toLowerCase())) return false;
  }
  if (typeof params.regex === 'string' && params.regex.length > 0) {
    let re: RegExp;
    try {
      re = compileUserRegex(params.regex);
    } catch {
      return false;
    }
    if (!re.test(text)) return false;
  }
  return true;
}

/**
 * Live-trace ("view logs") helper — explains WHY a Meshtastic message did not
 * match a rule's trigger filter. Mirrors {@link messageMatchesFilter}'s checks
 * but returns the first failing constraint as a human string (or undefined when
 * it actually matches). Trace-only: invoked solely on a miss while a rule is
 * being traced, so the hot matcher stays untouched.
 */
export function describeMessageFilterMiss(
  msg: DbMessage,
  params: Record<string, unknown> = {},
  channelName?: string | null,
): string | undefined {
  if (params.portnum != null && Number(msg.portnum) !== Number(params.portnum)) return `portnum ${msg.portnum} ≠ ${params.portnum}`;
  if (params.from != null && Number(msg.fromNodeNum) !== Number(params.from)) return `sender #${msg.fromNodeNum} ≠ from #${params.from}`;
  if (params.to != null && Number(msg.toNodeNum) !== Number(params.to)) return `recipient #${msg.toNodeNum} ≠ to #${params.to}`;
  if (params.channel != null && Number(msg.channel) !== Number(params.channel)) return `channel ${msg.channel} ≠ ${params.channel}`;
  if (typeof params.channelName === 'string' && params.channelName.length > 0) {
    if (!channelName || channelName.toLowerCase() !== params.channelName.toLowerCase()) return `channel name "${channelName ?? '(unresolved)'}" ≠ "${params.channelName}"`;
  }
  const text = msg.text ?? '';
  if (typeof params.textContains === 'string' && params.textContains.length > 0) {
    if (!text.toLowerCase().includes(params.textContains.toLowerCase())) return `text does not contain "${params.textContains}"`;
  }
  if (typeof params.regex === 'string' && params.regex.length > 0) {
    try {
      if (!compileUserRegex(params.regex).test(text)) return `text does not match /${params.regex}/`;
    } catch {
      return `invalid regex /${params.regex}/`;
    }
  }
  return undefined; // actually matched (caller shouldn't have asked)
}

/** Live-trace miss explainer for MeshCore messages — mirror of {@link meshCoreMessageMatchesFilter}. */
export function describeMeshCoreFilterMiss(
  msg: MeshCoreMessage,
  params: Record<string, unknown> = {},
  channelName?: string | null,
): string | undefined {
  if (params.portnum != null || params.from != null || params.to != null) {
    return 'rule uses Meshtastic-only filters (from/to/portnum) — never matches MeshCore';
  }
  const channelIdx = parseMeshCoreChannelIdx(msg.fromPublicKey);
  if (params.channel != null && Number(channelIdx) !== Number(params.channel)) return `channel ${channelIdx ?? '(DM)'} ≠ ${params.channel}`;
  if (typeof params.channelName === 'string' && params.channelName.length > 0) {
    if (!channelName || channelName.toLowerCase() !== params.channelName.toLowerCase()) return `channel name "${channelName ?? '(unresolved)'}" ≠ "${params.channelName}"`;
  }
  const text = msg.text ?? '';
  if (typeof params.textContains === 'string' && params.textContains.length > 0) {
    if (!text.toLowerCase().includes(params.textContains.toLowerCase())) return `text does not contain "${params.textContains}"`;
  }
  if (typeof params.regex === 'string' && params.regex.length > 0) {
    try {
      if (!compileUserRegex(params.regex).test(text)) return `text does not match /${params.regex}/`;
    } catch {
      return `invalid regex /${params.regex}/`;
    }
  }
  return undefined;
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
