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
import { hopCountEmoji, hopOrMqttEmoji } from '../../../utils/hopEmoji.js';
import { autoAckIsZeroHop } from '../../utils/autoAckDecision.js';

/** Meshtastic broadcast address (0xFFFFFFFF); also defined inline in the manager. */
export const BROADCAST_ADDR = 0xffffffff;

export interface TriggerContext {
  triggerType: TriggerType;
  sourceId: string | null;
  /** Subject node for node/sourceNode variable scope binding (sender / telemetry / updated node). */
  subjectNodeNum: number | null;
  /**
   * Protocol-agnostic subject identity, for cooldown scoping (#4340 Phase 2).
   *
   * `undefined` (the default, and what every Meshtastic builder leaves it as)
   * means "derive it from subjectNodeNum". Set EXPLICITLY only where the
   * subject has an identity that is not a Meshtastic node number — today that
   * is only MeshCore, whose senders are pubkey strings. An explicit `null`
   * means "this event has no stable per-subject identity at all".
   *
   * Deliberately NOT reused for variable scoping or node hydration: both call
   * getNode(sourceId, nodeNum) / buildScopeKey with a NUMBER and must keep
   * doing so. This field is cooldown-only.
   */
  subjectNodeKey?: string | null;
  timestamp: number;
  /** `trigger.*` values, keyed WITHOUT the `trigger.` prefix. */
  fields: Record<string, unknown>;
}

/**
 * The subject's cooldown identity, or null when the event has none.
 * Explicit `subjectNodeKey` wins; otherwise derive from `subjectNodeNum`.
 */
export function subjectKeyOf(ctx: TriggerContext): string | null {
  if (ctx.subjectNodeKey !== undefined) return ctx.subjectNodeKey;
  return ctx.subjectNodeNum == null ? null : String(ctx.subjectNodeNum);
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
  /**
   * True when the message was ingested through an MQTT source (`mqtt_broker` /
   * `mqtt_bridge`) rather than over our own RF link (#4594). Resolved by the
   * engine from `NodeDataProvider.getSourceType`, since the pure builder has no
   * DB access. Absent/false → today's hop-count behaviour.
   */
  viaMqttSource?: boolean;
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
  const hops = deriveHops(msg);
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
    hops,
    // #4340: hopCountEmoji clamps a negative hop count to 0 (*️⃣), but `hops`
    // above is deriveHops' raw (possibly negative, on a malformed hopStart <
    // hopLimit packet) value — deliberately NOT aligned. Changing deriveHops to
    // guard against this would silently alter every existing condition.numeric
    // on field `hops`, so the divergence is documented here instead.
    // #4594: an MQTT source overrides the hop glyph entirely with #️⃣ — the
    // message never crossed our RF link, so its hop count describes the bridging
    // node's path, not ours. Keyed on the SOURCE TYPE, never on `msg.viaMqtt`:
    // the per-packet flag is routinely true on an ordinary meshtastic_tcp source
    // (an MQTT gateway node rebroadcast the packet onto RF, and we did receive it
    // over RF), so keying on it would silently change the glyph existing
    // automations already emit. Keyed this way, the new glyph is unreachable for
    // every source type that can fire an automation today.
    hopEmoji: hopOrMqttEmoji(hops, labels?.viaMqttSource),
    /**
     * True when the message arrived through an MQTT source. Exposed as its own
     * token so a rule can branch on transport without string-matching hopEmoji.
     */
    viaMqttSource: labels?.viaMqttSource === true,
    hopStart: msg.hopStart,
    hopLimit: msg.hopLimit,
    // #4340 Phase 4. AutoAck floors a missing/malformed hop count to 0 and treats it
    // as ZeroHop (meshtasticManager.ts:10170-10178). `hops` above deliberately keeps
    // deriveHops' raw value (undefined / possibly negative) — see the Phase 1 note.
    // `zeroHop` is the AutoAck-faithful, TOTAL 1/0 form: it is never NaN, so a rule
    // can branch on it inside a flat AND-chain instead of needing condition ports.
    zeroHop: autoAckIsZeroHop(typeof hops === 'number' && hops > 0 ? hops : 0, msg.viaMqtt) ? 1 : 0,
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
    protocolShort: 'MT',
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
  const hops = msg.hopCount ?? undefined;
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
    hops,
    // #4340: same shared table as the Meshtastic context; MeshCore has no
    // tapback concept, but the token is usable in action.sendMessage bodies.
    // #4594: MeshCore sources are never `mqtt_broker`/`mqtt_bridge`, so the MQTT
    // glyph is unreachable here — `hopCountEmoji` directly, and the companion
    // token is a constant false so it is never undefined on a message trigger.
    hopEmoji: hopCountEmoji(hops),
    viaMqttSource: false,
    // #4340 Phase 4: same derivation as buildMessageContext. MeshCore messages
    // carry no viaMqtt concept — `undefined` reads as not-MQTT, never NaN.
    zeroHop: autoAckIsZeroHop(typeof hops === 'number' && hops > 0 ? hops : 0, undefined) ? 1 : 0,
    snr: msg.snr,
    rssi: msg.rssi,
    // MeshCore scope/region (#3833). `scopeCode` 0 = explicitly unscoped, null/
    // absent = no scope info; `scopeName` = resolved region name (null when
    // unscoped or scoped-but-unknown). Powers the "respond on trigger scope" mode.
    scopeCode,
    scopeName: msg.scopeName ?? undefined,
    scoped: scopeCode != null && scopeCode !== 0,
    protocol: 'meshcore',
    protocolShort: 'MC',
    sourceId,
    timestamp,
  };
  return {
    triggerType: 'trigger.message',
    sourceId,
    // No Meshtastic-style numeric node → no node.* hydration for MeshCore messages.
    subjectNodeNum: null,
    // #4340 Phase 2: MeshCore has no node numbers, so per-node cooldown keys off
    // the sender pubkey instead — the same identity meshcoreManager's own auto-ack
    // cooldown uses (meshcoreManager.ts:6909). A DM/room post carries the real
    // sender key. A CHANNEL post does not: `fromPublicKey` is the synthetic
    // `channel-<idx>` slot key SHARED by every sender on that channel (see
    // parseMeshCoreChannelIdx above), so keying by it would look per-node while
    // actually being per-channel. Null there, which degrades to the automation-wide
    // key rather than lying.
    subjectNodeKey: isChannel ? null : (msg.fromPublicKey ?? null),
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

/**
 * Build the trigger context for a received MeshBeacon (firmware 2.8+, #3854).
 * Subject node = the beaconing node. The offer fields describe a mesh the
 * beacon advertises; they are absent when the beacon carries text only.
 */
export function buildMeshBeaconContext(
  nodeNum: number,
  message: string,
  offer: { channelName?: string; region?: number; preset?: number },
  sourceId: string | null,
  timestamp: number,
): TriggerContext {
  return {
    triggerType: 'trigger.meshBeacon',
    sourceId,
    subjectNodeNum: Number(nodeNum),
    timestamp,
    fields: {
      nodeNum: Number(nodeNum),
      message,
      offerChannelName: offer.channelName,
      offerRegion: offer.region,
      offerPreset: offer.preset,
      // Convenience flag so a rule can select "beacons advertising a network"
      // without string-comparing an optional field.
      hasOffer: Boolean(offer.channelName || offer.region || offer.preset !== undefined),
      sourceId,
      timestamp,
    },
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

/** Build the trigger context when a watched node flips stationary → mobile. */
export function buildBecameMobileContext(
  nodeNum: number,
  latitude: number | undefined,
  longitude: number | undefined,
  previousMobile: number,
  mobile: number,
  sourceId: string | null,
  timestamp: number,
): TriggerContext {
  return {
    triggerType: 'trigger.becameMobile',
    sourceId,
    subjectNodeNum: Number(nodeNum),
    timestamp,
    fields: {
      nodeNum: Number(nodeNum),
      latitude,
      longitude,
      previousMobile,
      mobile,
      sourceId,
      timestamp,
    },
  };
}

/** Build the trigger context when a watched node exceeds its home-distance threshold. */
export function buildLeftHomeContext(
  nodeNum: number,
  latitude: number,
  longitude: number,
  homeLat: number,
  homeLon: number,
  distanceMeters: number,
  thresholdMeters: number,
  sourceId: string | null,
  timestamp: number,
): TriggerContext {
  return {
    triggerType: 'trigger.leftHome',
    sourceId,
    subjectNodeNum: Number(nodeNum),
    timestamp,
    fields: {
      nodeNum: Number(nodeNum),
      latitude,
      longitude,
      homeLat,
      homeLon,
      distanceMeters,
      thresholdMeters,
      sourceId,
      timestamp,
    },
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
 * Extract the channel names a `trigger.message` filter targets via the multi-select
 * `channels` field (#3974). Entries are `{ name, protocol? }` — the same shape the
 * builder's `channelMulti` renderer emits and `action.sendMessage` resolves. Matching
 * is name-based (protocol is a UI hint only). An empty string is a legitimate,
 * meaningful entry here — it's how the "(Primary)" checkbox represents a source's
 * unnamed slot-0 channel (#4507) — so it is kept, not dropped; only entries that
 * aren't a `{ name: string }` object are excluded.
 */
export function messageFilterChannelNames(params: Record<string, unknown> = {}): string[] {
  if (!Array.isArray(params.channels)) return [];
  return (params.channels as unknown[])
    .map((c) => (c && typeof c === 'object' && typeof (c as Record<string, unknown>).name === 'string'
      ? ((c as Record<string, unknown>).name as string)
      : null))
    .filter((n): n is string => n !== null);
}

/**
 * True when a `trigger.message` params object constrains by channel name — either the
 * legacy scalar `channelName` or the multi-select `channels` array (#3974). The engine
 * uses this to decide whether it must resolve the per-source slot→name before filtering.
 */
export function messageFilterUsesChannelName(params: Record<string, unknown> = {}): boolean {
  if (typeof params.channelName === 'string' && params.channelName.length > 0) return true;
  return messageFilterChannelNames(params).length > 0;
}

/**
 * @param channelName Pre-resolved name of `msg.channel` for its source (the engine
 *   resolves the per-source slot→name once before filtering). Required for the
 *   `params.channelName`/`params.channels` checks to match; when absent, a name
 *   filter fails.
 */
export function messageMatchesFilter(msg: DbMessage, params: Record<string, unknown> = {}, channelName?: string | null): boolean {
  if (params.portnum != null && Number(msg.portnum) !== Number(params.portnum)) return false;
  if (params.from != null && Number(msg.fromNodeNum) !== Number(params.from)) return false;
  if (params.to != null && Number(msg.toNodeNum) !== Number(params.to)) return false;
  // Multi-channel OR-list (#3974) takes precedence over the legacy scalar
  // channel/channelName fields: fire if the resolved name matches ANY entry.
  // A resolved name of '' (Primary's unnamed slot-0) is a legitimate match
  // target (#4507) — only an unresolved (null/undefined) name never matches.
  const channelNames = messageFilterChannelNames(params);
  if (channelNames.length > 0) {
    if (channelName == null) return false;
    const resolved = channelName.toLowerCase();
    if (!channelNames.some((n) => n.toLowerCase() === resolved)) return false;
  } else {
    if (params.channel != null && Number(msg.channel) !== Number(params.channel)) return false;
    // Channel-by-name: portable across sources where the channel sits in a
    // different slot. Case-insensitive; a non-resolving channel never matches.
    if (typeof params.channelName === 'string' && params.channelName.length > 0) {
      if (!channelName || channelName.toLowerCase() !== params.channelName.toLowerCase()) return false;
    }
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
  const channelNames = messageFilterChannelNames(params);
  if (channelNames.length > 0) {
    if (channelName == null) return false;
    const resolved = channelName.toLowerCase();
    if (!channelNames.some((n) => n.toLowerCase() === resolved)) return false;
  } else {
    if (params.channel != null && Number(channelIdx) !== Number(params.channel)) return false;
    if (typeof params.channelName === 'string' && params.channelName.length > 0) {
      if (!channelName || channelName.toLowerCase() !== params.channelName.toLowerCase()) return false;
    }
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
  const channelNames = messageFilterChannelNames(params);
  if (channelNames.length > 0) {
    const resolved = channelName == null ? null : channelName.toLowerCase();
    if (resolved == null || !channelNames.some((n) => n.toLowerCase() === resolved)) {
      return `channel name "${channelName ?? '(unresolved)'}" not in [${channelNames.join(', ')}]`;
    }
  } else {
    if (params.channel != null && Number(msg.channel) !== Number(params.channel)) return `channel ${msg.channel} ≠ ${params.channel}`;
    if (typeof params.channelName === 'string' && params.channelName.length > 0) {
      if (!channelName || channelName.toLowerCase() !== params.channelName.toLowerCase()) return `channel name "${channelName ?? '(unresolved)'}" ≠ "${params.channelName}"`;
    }
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
  const channelNames = messageFilterChannelNames(params);
  if (channelNames.length > 0) {
    const resolved = channelName == null ? null : channelName.toLowerCase();
    if (resolved == null || !channelNames.some((n) => n.toLowerCase() === resolved)) {
      return `channel name "${channelName ?? '(unresolved)'}" not in [${channelNames.join(', ')}]`;
    }
  } else {
    if (params.channel != null && Number(channelIdx) !== Number(params.channel)) return `channel ${channelIdx ?? '(DM)'} ≠ ${params.channel}`;
    if (typeof params.channelName === 'string' && params.channelName.length > 0) {
      if (!channelName || channelName.toLowerCase() !== params.channelName.toLowerCase()) return `channel name "${channelName ?? '(unresolved)'}" ≠ "${params.channelName}"`;
    }
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
