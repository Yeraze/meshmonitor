/**
 * MT↔MC Bridge template (Automation Template Gallery, Phase 4).
 *
 * Installs a MATCHED PAIR of automations that relay channel text between a
 * Meshtastic source/channel and a MeshCore source/channel: one rule watches
 * the Meshtastic side and forwards to MeshCore, the other watches the
 * MeshCore side and forwards to Meshtastic. Both directions prefix the
 * relayed text with a protocol tag ("MT@name: " / "MC@name: ") so a human
 * reading either channel can tell where a message originated.
 *
 * LOOP SAFETY is the whole point of this file. Without a guard, a message
 * relayed MT→MC would come straight back through the MC→MT rule (same text,
 * same channel pairing) and bounce forever. Both directions therefore carry
 * the SAME two `condition.string notContains` guards against the OTHER
 * direction's own tag: the MT→MC rule refuses to forward anything already
 * carrying "MT@" (its own tag — an echo/loop) OR "MC@" (a message that just
 * came FROM the MC→MT rule and would otherwise bounce straight back). See
 * `bridge.loopSafety.test.ts` for the round-trip proof.
 *
 * Built via `compile()` (`../compile.ts`) exactly like `autoAck.ts` — no
 * hand-rolled node/edge assembly — which is what keeps each installed
 * automation `decompile()`-able back into the friendly builder UI.
 */
import { compile, type WorkflowForm, type FormBlock } from '../compile';
import type { AutomationTemplate, BuiltAutomation, ParamSpec } from './types';
import { RATE_LIMIT_MAX_ACTIONS_MIN, RATE_LIMIT_MAX_ACTIONS_MAX } from '../../../types/automation';

/** `sourceMulti` fields store a plain array of source ids (mirrors autoAck.ts). */
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

/** This template only ever relays via ONE source/channel per side — take the first pick. */
function firstSourceId(v: unknown): string | undefined {
  return asSourceIds(v)[0];
}
function firstChannel(v: unknown): { name: string; protocol?: string } | undefined {
  return asChannelSelection(v)[0];
}

/** A blank/non-integer/out-of-range override is ignored — falls back to the template default. */
function normalizeRateLimitMax(v: unknown): number | undefined {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) return undefined;
  if (n < RATE_LIMIT_MAX_ACTIONS_MIN || n > RATE_LIMIT_MAX_ACTIONS_MAX) return undefined;
  return n;
}

const DEFAULT_RATE_LIMIT_MAX_ACTIONS = 20;

const PARAMS: ParamSpec[] = [
  {
    name: 'mtSource', label: 'Meshtastic source', kind: 'sourceMulti',
    help: 'The Meshtastic connection to bridge. Leave none selected to relay from/to any Meshtastic source.',
  },
  {
    name: 'mtChannel', label: 'Meshtastic channel', kind: 'channelMulti',
    help: 'The Meshtastic channel to bridge. Leave none selected to relay on any channel.',
  },
  {
    name: 'mcSource', label: 'MeshCore source', kind: 'sourceMulti',
    help: 'The MeshCore connection to bridge. Leave none selected to relay from/to any MeshCore source.',
  },
  {
    name: 'mcChannel', label: 'MeshCore channel', kind: 'channelMulti',
    help: 'The MeshCore channel to bridge. Leave none selected to relay on any channel.',
  },
  {
    name: 'rateLimitMax', label: 'Max relays per minute', kind: 'number', advanced: true,
    placeholder: String(DEFAULT_RATE_LIMIT_MAX_ACTIONS),
    help: `Flood guard shared by both directions — caps each rule at this many relays per 60-second window. Leave blank for the default (${DEFAULT_RATE_LIMIT_MAX_ACTIONS}).`,
  },
];

interface DirectionSpec {
  /** Only relay messages arriving from this source. Unset = any source. */
  triggerSource?: string;
  /** Only relay messages arriving on this channel. Unset = any channel. */
  triggerChannel?: { name: string; protocol?: string };
  /** Relay to this source. Unset = the triggering source (rarely what you want for a bridge). */
  sendSource?: string;
  /** Relay to this channel. Unset = the triggering channel. */
  sendChannel?: { name: string; protocol?: string };
  rateLimitMax?: number;
}

/**
 * One direction of the bridge: WHEN a channel message arrives (not a DM, and
 * not already carrying either protocol tag) THEN relay it, tagged, to the
 * other side.
 *
 * `portnum` is deliberately OMITTED from the trigger — see autoAck.ts's own
 * comment on the same point: any portnum param makes messageMatchesFilter /
 * meshCoreMessageMatchesFilter treat the trigger as Meshtastic-only, which
 * would make this cross-protocol bridge blind to the MeshCore half.
 */
function buildDirectionForm(spec: DirectionSpec): WorkflowForm {
  const triggerParams: Record<string, unknown> = {
    rateLimit: { maxActions: spec.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX_ACTIONS, windowSeconds: 60 },
  };
  if (spec.triggerChannel) triggerParams.channels = [spec.triggerChannel];

  const conditions: FormBlock[] = [];
  if (spec.triggerSource) conditions.push({ type: 'condition.sourceFilter', params: { sourceIds: [spec.triggerSource] } });
  // Channel broadcast only — a DM was never meant for the other mesh.
  conditions.push({ type: 'condition.numeric', params: { field: 'isDM', op: '==', value: '0' } });
  // Loop guard (see file header): never relay something that already carries
  // either side's tag — that's either our own echo or the other direction's
  // relay bouncing straight back. `notContains` — NOT a regex negative
  // lookahead: the evaluator compiles condition.string regexes with RE2
  // (src/utils/safeRegex.ts), which throws on lookaround, and the trigger
  // pre-filter swallows that throw as a silent non-match, so a lookahead-based
  // guard would make this rule never fire at all.
  conditions.push({ type: 'condition.string', params: { field: 'text', op: 'notContains', value: 'MT@' } });
  conditions.push({ type: 'condition.string', params: { field: 'text', op: 'notContains', value: 'MC@' } });

  const actionParams: Record<string, unknown> = {
    text: '{{ trigger.protocolShort }}@{{ trigger.fromName }}: {{ trigger.text }}',
  };
  if (spec.sendSource) actionParams.sourceIds = [spec.sendSource];
  if (spec.sendChannel) actionParams.channels = [spec.sendChannel];

  return {
    trigger: { type: 'trigger.message', params: triggerParams },
    rules: [{ conditions, actions: [{ type: 'action.sendMessage', params: actionParams }] }],
    combine: null,
  };
}

function build(values: Record<string, unknown>): BuiltAutomation[] {
  const mtSource = firstSourceId(values.mtSource);
  const mtChannel = firstChannel(values.mtChannel);
  const mcSource = firstSourceId(values.mcSource);
  const mcChannel = firstChannel(values.mcChannel);
  const rateLimitMax = normalizeRateLimitMax(values.rateLimitMax);

  const mtToMc: BuiltAutomation = {
    name: 'MT_to_MC_Bridge',
    description: 'Relays Meshtastic channel messages to MeshCore, tagged "MT@sender: ". Installs disabled — review the source/channel selection before enabling.',
    config: compile(buildDirectionForm({
      triggerSource: mtSource,
      triggerChannel: mtChannel,
      sendSource: mcSource,
      sendChannel: mcChannel,
      rateLimitMax,
    })),
  };

  const mcToMt: BuiltAutomation = {
    name: 'MC_to_MT_Bridge',
    description: 'Relays MeshCore channel messages to Meshtastic, tagged "MC@sender: ". Installs disabled — review the source/channel selection before enabling.',
    config: compile(buildDirectionForm({
      triggerSource: mcSource,
      triggerChannel: mcChannel,
      sendSource: mtSource,
      sendChannel: mtChannel,
      rateLimitMax,
    })),
  };

  return [mtToMc, mcToMt];
}

export const bridgeTemplate: AutomationTemplate = {
  id: 'mt-mc-bridge',
  name: 'MT↔MC Bridge',
  description: 'Relay channel messages both ways between a Meshtastic channel and a MeshCore channel, tagged with their protocol of origin. Installs a matched pair of automations (disabled) with a built-in loop guard.',
  icon: 'bidirectional',
  tags: ['Bridge', 'MeshCore', 'Relay'],
  params: PARAMS,
  build,
};
