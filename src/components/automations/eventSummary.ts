/**
 * Shared, human-readable summary of a trigger's captured event payload — the
 * `ctx.fields` bag the engine persists on every run as `automation_runs.triggerEvent`
 * and streams live over `automation:trace`.
 *
 * Used by both the live trace panel and the persisted run log (#4711) so the two
 * never drift in how "which message set this off" reads.
 *
 * Deliberately **field-driven, not trigger-type-driven**: a run row records the
 * payload but not the trigger type, and an automation's trigger can be edited
 * after the fact, so deriving the shape from the rule's current config would
 * mislabel history. The field bags are distinctive enough to tell apart on their
 * own (see `triggerContext.ts` for every builder).
 */

/** A node id long enough to be a MeshCore pubkey is elided rather than wrapped. */
const MAX_NODE_LABEL = 24;

export interface EventSummary {
  /** Who the event is about — display name preferred over a raw id/nodeNum. */
  node?: string;
  /** Where it arrived: the channel's name, else `ch N`, else `DM`. */
  channel?: string;
  /** The body text, when the trigger carries one (message, beacon). */
  text?: string;
  /** Trigger-specific extra: telemetry reading, geofence crossing, system event. */
  detail?: string;
}

/** Non-empty trimmed string, or undefined. Numbers/booleans stringify. */
function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function elide(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Sender/subject label. `fromName` already degrades long → short → id upstream;
 * MeshCore falls back to a 64-char pubkey, so the raw id is elided.
 */
function nodeLabel(e: Record<string, unknown>): string | undefined {
  const named = str(e.fromName) ?? str(e.fromId) ?? str(e.from);
  if (named) return elide(named, MAX_NODE_LABEL);
  const nodeNum = str(e.nodeNum);
  return nodeNum ? `node ${nodeNum}` : undefined;
}

/**
 * Channel label. A DM has no meaningful channel, and MeshCore DMs/room posts
 * carry no channel index at all, so both collapse to `DM`.
 */
function channelLabel(e: Record<string, unknown>): string | undefined {
  if (e.isDM === true) return 'DM';
  return str(e.channelName) ?? (e.channel != null ? `ch ${str(e.channel)}` : undefined);
}

/**
 * The one trigger-specific line, keyed off marker fields unique to each builder:
 * `telemetryType` (telemetry), `distanceMeters` (leftHome), `previousMobile`
 * (becameMobile), `changed` (node discovered/updated), `event` (geofence + system).
 */
function detailLabel(e: Record<string, unknown>): string | undefined {
  if (e.telemetryType != null || e.value != null) {
    const unit = str(e.unit);
    return `${str(e.telemetryType) ?? '?'} = ${str(e.value) ?? '?'}${unit ? ` ${unit}` : ''}`;
  }
  if (typeof e.distanceMeters === 'number') {
    return `left home · ${Math.round(e.distanceMeters)}m`;
  }
  if (e.previousMobile != null || e.mobile != null) {
    return 'became mobile';
  }
  if (Array.isArray(e.changed)) {
    return e.changed.length > 0 ? `changed: ${e.changed.join(', ')}` : 'no fields changed';
  }
  // Geofence crossings ('enter'/'exit'/'dwell') and system events ('bootup', …)
  // both key on `event`; a system event may add a `reason`.
  const event = str(e.event);
  if (event) {
    const reason = str(e.reason);
    return reason ? `${event} — ${reason}` : event;
  }
  // A beacon advertising a mesh, when it carried no message text of its own.
  const offer = str(e.offerChannelName);
  return offer ? `offers ${offer}` : undefined;
}

/** Break a captured trigger payload into the parts worth showing a human. */
export function summarizeTriggerEvent(event: Record<string, unknown> | null | undefined): EventSummary {
  if (!event || typeof event !== 'object') return {};
  return {
    node: nodeLabel(event),
    channel: channelLabel(event),
    // `message` is the MeshBeacon body; `text` is a message body.
    text: str(event.text) ?? str(event.message),
    detail: detailLabel(event),
  };
}

/** Flatten a summary into the single line the live trace feed shows per entry. */
export function summaryLine(s: EventSummary): string {
  const bits: string[] = [];
  if (s.node) bits.push(`from ${s.node}`);
  if (s.channel) bits.push(s.channel);
  if (s.detail) bits.push(s.detail);
  if (s.text) bits.push(`"${s.text}"`);
  return bits.join(' · ') || '(no event payload)';
}

/**
 * Parse a persisted `triggerEvent` / `log` JSON column. Returns null for absent
 * or malformed JSON so callers can fall back to the raw string rather than
 * blanking a run row that is otherwise readable.
 */
export function parseJsonColumn<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? null : (parsed as T);
  } catch {
    return null;
  }
}
