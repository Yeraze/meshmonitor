/**
 * Auto-Ack template (Automation Template Gallery, Phase 3 WP2).
 *
 * Reproduces the common "acknowledge direct, zero-hop text messages" pattern
 * as an installable automation: WHEN a text message arrives, IF it was heard
 * direct (0 hops, over RF — {@link https://…|`zeroHop`} is the same derived,
 * total field Auto-Acknowledge's own converter uses, see
 * `src/server/services/automation/autoAckConverter.ts`), THEN react/reply.
 *
 * Graph shape is built via the shared `compile()` (`../compile.ts`) rather
 * than hand-assembled nodes/edges — `compile()` is the project's only graph
 * emitter (see `autoAckConverter.ts`'s header comment) and its plain
 * AND-chain output carries no `port` fields, which keeps the installed
 * automation `decompile()`-able back into the friendly builder UI. An
 * unported edge leaving a condition node behaves as an implicit "true" gate
 * (`graphEvaluator.ts`'s `portSatisfied`), so this is also behaviourally
 * identical to an explicit `port: 'true'` edge — just editable afterwards.
 */
import { compile, type WorkflowForm, type FormBlock } from '../compile';
import type { AutomationTemplate, BuiltAutomation, ParamSpec } from './types';

type AckStyle = 'hop' | 'fixed' | 'text';

function normalizeAckStyle(v: unknown): AckStyle {
  return v === 'fixed' || v === 'text' ? v : 'hop';
}

/** `sourceMulti`/`sendSourceMulti` fields store a plain array of source ids. */
function asSourceIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** `channelMulti` fields store `{ name, protocol? }` objects (AutomationBuilder.tsx). */
function asChannelSelection(v: unknown): Array<{ name: string; protocol?: string }> {
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is { name: string; protocol?: string } =>
    !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).name === 'string');
}

const PARAMS: ParamSpec[] = [
  {
    name: 'sourceIds', label: 'Only acknowledge messages from these sources', kind: 'sourceMulti',
    help: 'Leave none selected to acknowledge messages from any source.',
  },
  {
    name: 'channelFilter', label: 'Only on these channels', kind: 'channelMulti',
    help: 'Leave none selected to acknowledge on any channel (DMs are always included).',
  },
  {
    // 'hop' MUST stay first — AutomationBuilder.tsx's defaultParams() seeds a
    // select field from options[0] when a template's chosen values are absent.
    name: 'ackStyle', label: 'Acknowledgement style', kind: 'select',
    options: [
      { value: 'hop', label: 'Tapback: hop-count emoji' },
      { value: 'fixed', label: 'Tapback: thumbs up' },
      { value: 'text', label: 'Reply message' },
    ],
    help: 'The hop-count and thumbs-up tapbacks react to the triggering message (Meshtastic only — MeshCore has no tapback). '
      + 'Reply message sends a short reply and works on both protocols.',
  },
];

function buildAckAction(ackStyle: AckStyle): FormBlock {
  // 'emoji' is deliberately OMITTED for the 'fixed' style rather than hardcoded
  // here as a literal: actionExecutor.ts's action.tapback case already applies
  // the exact same thumbs-up fallback (`String(p.emoji ?? '👍')`) when the param
  // is absent, so leaving it unset reuses that single source of truth instead of
  // duplicating the glyph. (It also keeps this file free of a raw content-emoji
  // literal, which meshmonitor-ui/no-hardcoded-ui-glyph would otherwise flag —
  // correctly, since that rule can't distinguish "duplicated app default" from
  // "hardcoded UI icon" by looking at the literal alone.)
  if (ackStyle === 'fixed') return { type: 'action.tapback', params: { emojiMode: 'fixed' } };
  if (ackStyle === 'text') {
    // No literal emoji in the template text either — {{ trigger.hopEmoji }} is
    // a plain-ASCII token that renders the protocol glyph at send time.
    return { type: 'action.sendMessage', params: { text: 'Received ({{ trigger.hopEmoji }})', replyToTrigger: true } };
  }
  return { type: 'action.tapback', params: { emojiMode: 'hopCount' } };
}

function build(values: Record<string, unknown>): BuiltAutomation {
  const sourceIds = asSourceIds(values.sourceIds);
  const channelFilter = asChannelSelection(values.channelFilter);
  const ackStyle = normalizeAckStyle(values.ackStyle);

  // portnum is deliberately OMITTED: trigger.message has no portnum field in
  // the catalog, and messageMatchesFilter/meshCoreMessageMatchesFilter treat
  // ANY portnum param as Meshtastic-only — meshCoreMessageMatchesFilter (and
  // describeMeshCoreFilterMiss) force a non-match whenever params.portnum is
  // set at all (triggerContext.ts). Setting it would silently make this
  // cross-protocol template Meshtastic-only.
  const triggerParams: Record<string, unknown> = {
    // Flood guard: caps this automation at 30 fires/minute regardless of subject —
    // see RATE_LIMIT_MAX_ACTIONS_MIN/MAX in src/types/automation.ts.
    rateLimit: { maxActions: 30, windowSeconds: 60 },
  };
  if (channelFilter.length > 0) triggerParams.channels = channelFilter;

  const conditions: FormBlock[] = [];
  // Mirrors autoAckConverter.ts's own S1 ordering (source filter first).
  if (sourceIds.length > 0) conditions.push({ type: 'condition.sourceFilter', params: { sourceIds } });
  // zeroHop (#4340 Phase 4): the derived, TOTAL (never NaN) "direct RF, 0 hops"
  // field — 1 when the message arrived direct over RF, 0 when relayed or via
  // MQTT. Verified present in EVENT_NUMERIC['trigger.message'] (catalog.ts)
  // and computed in buildMessageContext (triggerContext.ts).
  conditions.push({ type: 'condition.numeric', params: { field: 'zeroHop', op: '==', value: '1' } });

  const form: WorkflowForm = {
    trigger: { type: 'trigger.message', params: triggerParams },
    rules: [{ conditions, actions: [buildAckAction(ackStyle)] }],
    combine: null,
  };

  return {
    name: 'Auto-Ack',
    description: 'Automatically acknowledges direct (zero-hop) text messages with a tapback or a short reply.',
    config: compile(form),
  };
}

export const autoAckTemplate: AutomationTemplate = {
  id: 'auto-ack',
  name: 'Auto-Ack',
  description: 'Acknowledge direct, zero-hop text messages with a tapback (hop-count emoji or a fixed emoji) or a short reply — a lightweight range-test responder.',
  icon: 'check',
  tags: ['Acknowledgement', 'Reply'],
  params: PARAMS,
  build,
};
