/**
 * Auto-Acknowledge → Automation converter (#4340 Phase 4, WP2).
 *
 * Pure graph builder: takes a source's resolved Auto-Acknowledge settings and
 * returns the automation(s) to create plus a conversion report. No DB imports —
 * everything here is plain data in, plain data out, so it can be exercised with
 * literals in tests without a database.
 *
 * `compile()` (`src/components/automations/compile.ts`) is the ONLY graph
 * emitter. This file builds a `WorkflowForm` and calls `compile(form)` —
 * hand-assembling `nodes`/`edges` here would break the round-trip guarantee
 * `decompile()` depends on (spec §9.1: `compile.ts:128` returns `null` for any
 * ported edge, which drops the user into the raw-JSON editor — a converted
 * automation the user cannot open and edit is a failure, not a partial
 * success). That is exactly why WP1 added the derived `zeroHop` trigger field:
 * it lets all four AutoAck cells express as a flat AND-chain with no condition
 * ports.
 *
 * See docs/internal/dev-notes/AUTOACK_CONVERTER_PHASE4_SPEC.md §4 for the full
 * design (this file implements it verbatim) and §1 for the reuse inventory —
 * every non-trivial piece of AutoAck's own decision logic (the 2×2 matrix
 * model, ZeroHop/reply-routing decisions, the pre-send delay clamp, the legacy
 * matrix translator, channel-configuredness) is imported from its existing
 * home, not re-derived here.
 */
import { compile, type WorkflowForm, type FormBlock, type Rule } from '../../../components/automations/compile.js';
import type { AutomationGraph } from '../../../types/automation.js';
import {
  AUTOACK_CELLS,
  DEFAULT_AUTOACK_MATRIX,
  settingsToMatrix,
  cellServerKeyPrefix,
  type AutoAckMatrix,
} from '../../../utils/autoAckMatrix.js';
import { resolveAutoAckReplyRouting } from '../../utils/autoAckDecision.js';
import { resolveAutoAckPreSendDelaySeconds } from '../../autoAckDelay.js';
import { computeMatrixValues } from '../../migrations/093_autoack_matrix.js';
import { isConfiguredChannel } from './channelUnify.js';

// ─── Defaults AutoAck itself applies at runtime (meshtasticManager.ts) ────────
// The converter must reproduce these literally rather than emitting a blank
// value that would mean something different to the engine (spec obligations
// 1/2; epic doc "Four Phase 4 converter obligations").

/** AutoAck's own default trigger regex when `autoAckRegex` is blank/unset. */
export const AUTOACK_DEFAULT_REGEX = '^(test|ping)';
/** AutoAck's own default reply template when `autoAckMessage` is blank/unset. */
export const AUTOACK_DEFAULT_MESSAGE = '🤖 Copy, {NUMBER_HOPS} hops at {TIME}';
/** AutoAck's own default cooldown (seconds) when `autoAckCooldownSeconds` is blank/unset. */
export const AUTOACK_DEFAULT_COOLDOWN_SECONDS = 60;

// ─── Input shape ───────────────────────────────────────────────────────────

/**
 * A source's Auto-Acknowledge settings, resolved down to the same raw strings
 * `getSettingForSource` returns (undefined when a key is absent). Deliberately
 * NOT pre-defaulted/pre-parsed by the caller — this file owns every default
 * and every parse (obligations 1/2, §2.2's legacy-matrix detection) so it can
 * be fully exercised with literals, no DB (§7 test plan).
 */
export interface ResolvedAutoAck {
  /** `autoAckEnabled === 'true'`. NOT blocking on its own — a disabled config may still be converted (§2.1). */
  enabled: boolean;
  /** `autoAckRegex` as read; falsy → apply {@link AUTOACK_DEFAULT_REGEX}. */
  regex: string | undefined;
  /** `autoAckMessage` as read; falsy → apply {@link AUTOACK_DEFAULT_MESSAGE}. */
  message: string | undefined;
  /** `autoAckMessageDirect` as read; falsy → falls back to `message` on ZeroHop cells only. */
  messageDirect: string | undefined;
  /** `autoAckChannels` as read: comma-separated channel indices, unparsed. */
  channelsRaw: string | undefined;
  /** `autoAckSkipIncompleteNodes === 'true'`. */
  skipIncompleteNodes: boolean;
  /** `autoAckIgnoredNodes` as read: comma/whitespace-separated tokens, unparsed. */
  ignoredNodesRaw: string | undefined;
  /** `autoAckCooldownSeconds` as read; falsy → apply {@link AUTOACK_DEFAULT_COOLDOWN_SECONDS}. */
  cooldownSecondsRaw: string | undefined;
  /** `autoAckPreSendDelaySeconds` as read — fed straight into {@link resolveAutoAckPreSendDelaySeconds}. */
  preSendDelaySecondsRaw: string | undefined;
  /** `autoAckMaxAttempts` as read. Report-only — NEVER emitted onto a graph (§9.5, parity note 8). */
  maxAttemptsRaw: string | undefined;
  /**
   * Every raw value whose key participates in the 2×2 matrix (the 12
   * `autoAck{Cell}{Reply,Tapback,ReplyDm}Enabled` keys) or the pre-093 legacy
   * scheme (migration 093's `LEGACY_SUFFIXES`, minus `autoAckEnabled` — which
   * `computeMatrixValues` does not read). Keyed by the literal setting name;
   * absent keys are simply missing from this record (not present with value
   * `undefined`, though either is accepted). §2.2's three-way detection
   * ("matrix present" / "legacy present" / "neither") runs against this.
   */
  rawMatrixAndLegacy: Record<string, string | undefined>;
}

export interface AutoAckConverterInput {
  sourceId: string;
  sourceName: string;
  settings: ResolvedAutoAck;
  channels: Array<{ index: number; name: string; role: number | null }>;
  /** Injectable clock for the description's date line. Defaults to `new Date()`. */
  now?: Date;
}

// ─── Output shape ──────────────────────────────────────────────────────────

export type AutoAckAutomationKey = 'channel' | 'direct';

export interface ConvertedAutomation {
  key: AutoAckAutomationKey;
  name: string;
  description: string;
  enabled: boolean;
  /** For the preview UI — render the rules as readable English from `form.rules`. */
  form: WorkflowForm;
  config: AutomationGraph;
}

export interface ReportEntry { key: string; label: string; detail: string; }

export interface ConversionReport {
  converted: ReportEntry[];
  approximated: ReportEntry[];
  notConvertible: ReportEntry[];
  dropped: ReportEntry[];
}

export type AutoAckBlockingReason = 'NO_CELLS_ENABLED' | 'CHANNEL_ALLOWLIST_UNCONVERTIBLE';

export interface AutoAckConversionResult {
  automations: ConvertedAutomation[];
  report: ConversionReport;
  blocking?: AutoAckBlockingReason;
}

// ─── §2.2 matrix / legacy-matrix resolution ────────────────────────────────

/** The 12 `autoAck{Cell}{Reply,Tapback,ReplyDm}Enabled` setting keys, in AUTOACK_CELLS order. */
const MATRIX_KEYS: string[] = AUTOACK_CELLS.flatMap((c) => {
  const prefix = cellServerKeyPrefix(c.id);
  return [`${prefix}ReplyEnabled`, `${prefix}TapbackEnabled`, `${prefix}ReplyDmEnabled`];
});

/** Mirrors migration 093's `LEGACY_SUFFIXES`, minus `autoAckEnabled` (an input signal to the
 *  migration's own gating, not read by `computeMatrixValues` itself). */
const LEGACY_KEYS = [
  'autoAckDirectMessages',
  'autoAckUseDM',
  'autoAckDirectEnabled',
  'autoAckDirectTapbackEnabled',
  'autoAckDirectReplyEnabled',
  'autoAckMultihopEnabled',
  'autoAckMultihopTapbackEnabled',
  'autoAckMultihopReplyEnabled',
] as const;

interface MatrixResolution {
  matrix: AutoAckMatrix;
  /** Non-empty only when the matrix was derived from legacy keys (§2.2 case 2). */
  legacyKeysUsed: string[];
}

/**
 * §2.2's three-way detection, pure and total:
 *  1. Any of the 12 matrix keys present → use them (`settingsToMatrix`), ignore legacy entirely.
 *  2. All 12 absent AND ≥1 legacy key present → translate via `computeMatrixValues` (migration
 *     093's own exported translator — not reimplemented here), then normalise through
 *     `settingsToMatrix` so both branches return the same `AutoAckMatrix` shape.
 *  3. Neither → the source never touched Auto-Acknowledge; matrix is all-off.
 */
function resolveMatrix(raw: Record<string, string | undefined>): MatrixResolution {
  if (MATRIX_KEYS.some((k) => raw[k] !== undefined)) {
    return { matrix: settingsToMatrix(raw), legacyKeysUsed: [] };
  }
  const legacyKeysUsed = LEGACY_KEYS.filter((k) => raw[k] !== undefined);
  if (legacyKeysUsed.length > 0) {
    const legacy: Parameters<typeof computeMatrixValues>[0] = {};
    for (const k of legacyKeysUsed) (legacy as Record<string, string>)[k] = raw[k]!;
    return { matrix: settingsToMatrix(computeMatrixValues(legacy)), legacyKeysUsed: [...legacyKeysUsed] };
  }
  return { matrix: DEFAULT_AUTOACK_MATRIX, legacyKeysUsed: [] };
}

// ─── §4.1-adjacent defaulting helpers ──────────────────────────────────────

// Mirrors meshtasticManager.ts's own falsy-check defaulting exactly (`autoAckRegex || '...'`
// etc.) — NOT a `.trim()`-based blank check, so behaviour matches byte-for-byte.
function resolveRegex(raw: string | undefined): string { return raw || AUTOACK_DEFAULT_REGEX; }
function resolveMessage(raw: string | undefined): string { return raw || AUTOACK_DEFAULT_MESSAGE; }
function resolveMessageDirect(raw: string | undefined): string { return raw || ''; }
function resolveCooldownSeconds(raw: string | undefined): number {
  if (!raw) return AUTOACK_DEFAULT_COOLDOWN_SECONDS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : AUTOACK_DEFAULT_COOLDOWN_SECONDS;
}

function parseChannelIndices(raw: string | undefined): number[] {
  if (!raw) return [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    const n = parseInt(part.trim(), 10);
    if (Number.isFinite(n)) seen.add(n);
  }
  return [...seen];
}

/**
 * §4.3 S3: normalises the ignore list exactly like `meshtasticManager.ts`'s own parser
 * (split on comma/whitespace, lowercase, strip a leading `!`, keep only 8-hex tokens, re-emit
 * canonical `!xxxxxxxx`). Tokens failing the hex test are discarded and reported — AutoAck
 * discards them too at read time, so this is fidelity, not loss.
 */
function normalizeIgnoredNodes(raw: string | undefined): { value: string; discarded: string[] } {
  if (!raw) return { value: '', discarded: [] };
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const kept: string[] = [];
  const discarded: string[] = [];
  for (const token of tokens) {
    const stripped = token.startsWith('!') ? token.slice(1) : token;
    if (/^[0-9a-f]{8}$/.test(stripped)) kept.push(`!${stripped}`);
    else discarded.push(token);
  }
  return { value: kept.join(', '), discarded };
}

// ─── §4.5 token translation ─────────────────────────────────────────────────

interface TokenDef { engine: string; bucket: 'converted' | 'approximated'; reason: string; }

const TOKEN_MAP: Record<string, TokenDef> = {
  '{NUMBER_HOPS}': { engine: '{{ trigger.hops }}', bucket: 'approximated', reason: "the engine's hops is unfloored, so a hopless packet renders blank and a malformed one can render negative" },
  '{HOPS}': { engine: '{{ trigger.hops }}', bucket: 'approximated', reason: "the engine's hops is unfloored, so a hopless packet renders blank and a malformed one can render negative" },
  '{NODE_ID}': { engine: '{{ trigger.fromId }}', bucket: 'converted', reason: 'exact equivalent' },
  '{LONG_NAME}': { engine: '{{ trigger.fromName }}', bucket: 'approximated', reason: 'degrades long → short → id, same as AutoAck, but the fallback chain differs slightly' },
  '{SNR}': { engine: '{{ trigger.snr }}', bucket: 'approximated', reason: "AutoAck substitutes the literal \"N/A\" when unavailable; the engine renders blank" },
  '{RSSI}': { engine: '{{ trigger.rssi }}', bucket: 'approximated', reason: "AutoAck substitutes the literal \"N/A\" when unavailable; the engine renders blank" },
  '{CHANNEL}': { engine: '{{ trigger.channelName }}', bucket: 'approximated', reason: 'AutoAck emits "DM" on a direct message and the raw channel index when unnamed' },
  '{DATE}': { engine: '{{ NOW }}', bucket: 'approximated', reason: '{{ NOW }} is send time in a fixed YYYY-MM-DD HH:MM:SS format, not rx time in your date/time preference' },
  '{TIME}': { engine: '{{ NOW }}', bucket: 'approximated', reason: '{{ NOW }} is send time in a fixed YYYY-MM-DD HH:MM:SS format, not rx time in your date/time preference' },
};

/** Left in the text verbatim — no engine equivalent (§4.5). */
const NOT_CONVERTIBLE_TOKENS = [
  '{SHORT_NAME}', '{RABBIT_HOPS}', '{LAST_HOP}', '{TRANSPORT}', '{VERSION}',
  '{DURATION}', '{FEATURES}', '{NODECOUNT}', '{DIRECTCOUNT}', '{IP}', '{PORT}',
];

interface TokenTranslation {
  text: string;
  converted: string[];
  approximated: string[];
  notConvertible: string[];
}

/** Only tokens actually present in the template are reported (§4.5, last line). */
function translateTokens(template: string): TokenTranslation {
  let text = template;
  const converted = new Set<string>();
  const approximated = new Set<string>();
  const notConvertible = new Set<string>();
  for (const [token, def] of Object.entries(TOKEN_MAP)) {
    if (text.includes(token)) {
      text = text.split(token).join(def.engine);
      (def.bucket === 'converted' ? converted : approximated).add(token);
    }
  }
  for (const token of NOT_CONVERTIBLE_TOKENS) {
    if (text.includes(token)) notConvertible.add(token); // left verbatim — no replacement
  }
  return { text, converted: [...converted], approximated: [...approximated], notConvertible: [...notConvertible] };
}

// ─── §4.4 reply routing ─────────────────────────────────────────────────────

/**
 * `to` / `replyToTrigger` for a cell's `action.sendMessage`, derived from
 * `resolveAutoAckReplyRouting()` — the same function `checkAutoAcknowledge` calls at runtime —
 * so the two cannot drift (spec §4.4, test (i)). `channelIndex`/`fromNum` don't affect
 * `replyViaDm`/`replyId`'s SHAPE (only their numeric destination, which the converter never
 * emits — a DM always targets `{{ trigger.from }}` and a channel reply always inherits the
 * triggering channel), so `0` is a safe sentinel. `packetId: 1` is a truthy sentinel purely so
 * `replyId`'s presence/absence tells us threadability; the actual value is never read.
 */
function replyRoutingParams(isDirectCell: boolean, cellReplyDmEnabled: boolean): Record<string, unknown> {
  const routing = resolveAutoAckReplyRouting({
    isDirectMessage: isDirectCell,
    cellReplyDmEnabled,
    channelIndex: 0,
    fromNum: 0,
    packetId: 1,
  });
  const params: Record<string, unknown> = {};
  if (routing.replyViaDm) params.to = '{{ trigger.from }}';
  if (routing.replyId !== undefined) params.replyToTrigger = true;
  return params;
}

// ─── §4.6 naming ─────────────────────────────────────────────────────────────

function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }

/**
 * Description first line is the machine-readable re-conversion marker (§4.7); the second line
 * is human-readable AND carries the `(channel|direct)` key WP3's re-conversion matcher parses
 * (`Kind: channel.` / `Kind: direct.`).
 */
function buildDescription(sourceId: string, key: AutoAckAutomationKey, cellLabels: string[], now: Date): string {
  const marker = `Converted from Auto-Acknowledge (source ${sourceId}) on ${isoDate(now)}.`;
  const humanKind = key === 'channel' ? 'Channel' : 'Direct message';
  return `${marker}\nKind: ${key}. Cells: ${cellLabels.join(', ')} (${humanKind}).`;
}

// ─── The builder ─────────────────────────────────────────────────────────────

/**
 * Build the automation(s) that reproduce a source's Auto-Acknowledge configuration, via
 * `compile()` only (§9.1). Returns up to two automations (§9.2) plus a full conversion report.
 */
export function buildAutoAckAutomations(input: AutoAckConverterInput): AutoAckConversionResult {
  const { sourceId, sourceName, settings, channels } = input;
  const now = input.now ?? new Date();

  const converted: ReportEntry[] = [];
  const approximated: ReportEntry[] = [];
  const notConvertible: ReportEntry[] = [];
  const dropped: ReportEntry[] = [];

  // ── always-present report entries (independent of matrix state) ──
  converted.push({
    key: 'autoAckEnabled',
    label: 'Enabled',
    detail: "The created automation's own Enabled toggle (unchecked when Auto-Acknowledge itself was off) plus a condition.sourceFilter bound to this source.",
  });

  const regex = resolveRegex(settings.regex);
  converted.push({
    key: 'autoAckRegex',
    label: 'Trigger regex',
    detail: settings.regex
      ? 'Emitted verbatim as trigger.message\'s regex.'
      : `Blank — emitted Auto-Acknowledge's own default ("${AUTOACK_DEFAULT_REGEX}"); the engine's blank regex means "match anything", so leaving it blank would have widened the trigger.`,
  });

  const cooldownSeconds = resolveCooldownSeconds(settings.cooldownSecondsRaw);
  converted.push({
    key: 'autoAckCooldownSeconds',
    label: 'Cooldown',
    detail: settings.cooldownSecondsRaw
      ? `Emitted as trigger.message's cooldownSeconds (${cooldownSeconds}s), with cooldownScope: 'node' (AutoAck cools down per sender node).`
      : `Blank — emitted Auto-Acknowledge's own default (${AUTOACK_DEFAULT_COOLDOWN_SECONDS}s); the engine's own default is 0 (no throttle).`,
  });

  if (settings.skipIncompleteNodes) {
    converted.push({
      key: 'autoAckSkipIncompleteNodes',
      label: 'Skip incomplete nodes',
      detail: "Emitted as condition.string on node.completeness, op 'in', value 'complete, unknown' — the tri-state reproduces AutoAck's \"skip only when the row exists AND is incomplete\" rule exactly.",
    });
  }

  const ignored = normalizeIgnoredNodes(settings.ignoredNodesRaw);
  if (ignored.value) {
    converted.push({
      key: 'autoAckIgnoredNodes',
      label: 'Ignored nodes',
      detail: `Emitted as condition.string on fromId, op 'notIn', value "${ignored.value}".`,
    });
  }
  if (ignored.discarded.length > 0) {
    approximated.push({
      key: 'ignored-node-unparseable',
      label: 'Ignored nodes (unparseable entries)',
      detail: `Discarded ${ignored.discarded.join(', ')} — not a valid 8-hex node id. Auto-Acknowledge's own parser discards the same tokens, so this is fidelity, not data loss.`,
    });
  }

  // ── §2.2 matrix resolution ──
  const { matrix, legacyKeysUsed } = resolveMatrix(settings.rawMatrixAndLegacy);
  if (legacyKeysUsed.length > 0) {
    converted.push({
      key: 'legacy-matrix-derived',
      label: 'Legacy configuration',
      detail: `No autoAck*Enabled matrix key was found for this source; derived the 2×2 matrix from legacy keys via migration 093's own translator: ${legacyKeysUsed.join(', ')}.`,
    });
  }

  // ── static notConvertible / dropped entries (§9.5, parity table) ──
  notConvertible.push({
    key: 'autoAckTestMessages',
    label: 'Test messages scratchpad',
    detail: 'No server code reads this key — it is a UI-only scratchpad on AutoAcknowledgeSection for pasting sample text. Its engine analogue is the Test panel, a mechanism, not a setting.',
  });
  notConvertible.push({
    key: 'autoAckMaxAttempts',
    label: 'DM resend attempts',
    detail: "checkAutoAcknowledge never reads this — it is MessageQueueService.resolveDmMaxAttempts()'s per-source queue setting, applied to every queued DM on this source. It is intentionally NOT emitted onto action.sendMessage: doing so would change TX-disabled behaviour (a queued send records 'queued', not 'skipped'). The setting survives conversion unchanged and keeps governing this source's other automated DMs.",
  });

  const DEPRECATED_KEYS: Array<{ key: string; label: string; global: boolean }> = [
    { key: 'autoAckDirectMessages', label: 'Legacy: Direct-message type gate', global: false },
    { key: 'autoAckUseDM', label: 'Legacy: channel→DM reply routing', global: false },
    { key: 'autoAckDirectEnabled', label: 'Legacy: 0-hop enabled', global: false },
    { key: 'autoAckDirectTapbackEnabled', label: 'Legacy: 0-hop tapback enabled', global: false },
    { key: 'autoAckDirectReplyEnabled', label: 'Legacy: 0-hop reply enabled', global: false },
    { key: 'autoAckMultihopEnabled', label: 'Legacy: multi-hop enabled', global: false },
    { key: 'autoAckMultihopTapbackEnabled', label: 'Legacy: multi-hop tapback enabled', global: false },
    { key: 'autoAckMultihopReplyEnabled', label: 'Legacy: multi-hop reply enabled', global: false },
    { key: 'autoAckTapbackEnabled', label: 'Legacy: global tapback enabled', global: true },
    { key: 'autoAckReplyEnabled', label: 'Legacy: global reply enabled', global: true },
  ];
  for (const dep of DEPRECATED_KEYS) {
    dropped.push({
      key: dep.key,
      label: dep.label,
      detail: dep.global
        ? 'Global-only key that predates the 2×2 matrix; folded into per-cell behaviour long ago. Nothing to convert.'
        : "Folded into the 2×2 matrix's per-cell toggles by migration 093. Nothing left to convert.",
    });
  }

  // ── §4.3/§4.4: build a rule per enabled cell ──
  const effectiveMessage = resolveMessage(settings.message);
  const effectiveMessageDirect = resolveMessageDirect(settings.messageDirect);
  const preSendDelaySeconds = resolveAutoAckPreSendDelaySeconds(settings.preSendDelaySecondsRaw);
  if (preSendDelaySeconds > 0) {
    approximated.push({
      key: 'autoAckPreSendDelaySeconds',
      label: 'Pre-send delay',
      detail: `Emitted as a single action.delay (${preSendDelaySeconds}s) before the first send. AutoAck's delay is a non-blocking timer applied independently to the tapback and the reply; action.delay blocks its own run — a converted chain needs it once, before the first send, which is behaviourally equivalent here since exactly one rule fires per event.`,
    });
  }

  let anyReplyEmitted = false;
  const usedApproximatedTokens = new Set<string>();
  const usedConvertedTokens = new Set<string>();
  const usedNotConvertibleTokens = new Set<string>();

  const S1: FormBlock = { type: 'condition.sourceFilter', params: { sourceIds: [sourceId] } };
  const S2: FormBlock | null = settings.skipIncompleteNodes
    ? { type: 'condition.string', params: { field: 'node.completeness', op: 'in', value: 'complete, unknown' } }
    : null;
  const S3: FormBlock | null = ignored.value
    ? { type: 'condition.string', params: { field: 'fromId', op: 'notIn', value: ignored.value } }
    : null;

  const channelRules: Rule[] = [];
  const directRules: Rule[] = [];
  const channelCellLabels: string[] = [];
  const directCellLabels: string[] = [];

  for (const cellMeta of AUTOACK_CELLS) {
    const cfg = matrix[cellMeta.id];
    if (!cfg.reply && !cfg.tapback) continue; // mirrors AutoAck's own early-out (:10195)

    const isDirectCell = cellMeta.type === 'direct';
    const isZeroHop = cellMeta.hop === 'zeroHop';

    const conditions: FormBlock[] = [S1];
    if (S2) conditions.push(S2);
    if (S3) conditions.push(S3);
    conditions.push({ type: 'condition.numeric', params: { field: 'isDM', op: '==', value: isDirectCell ? '1' : '0' } });
    conditions.push({ type: 'condition.numeric', params: { field: 'zeroHop', op: '==', value: isZeroHop ? '1' : '0' } });

    const actions: FormBlock[] = [];
    if (preSendDelaySeconds > 0) actions.push({ type: 'action.delay', params: { seconds: preSendDelaySeconds } });
    if (cfg.tapback) actions.push({ type: 'action.tapback', params: { emojiMode: 'hopCount' } });
    if (cfg.reply) {
      anyReplyEmitted = true;
      const template = isZeroHop && effectiveMessageDirect ? effectiveMessageDirect : effectiveMessage;
      const translation = translateTokens(template);
      translation.approximated.forEach((t) => usedApproximatedTokens.add(t));
      translation.converted.forEach((t) => usedConvertedTokens.add(t));
      translation.notConvertible.forEach((t) => usedNotConvertibleTokens.add(t));
      actions.push({
        type: 'action.sendMessage',
        params: { text: translation.text, ...replyRoutingParams(isDirectCell, cfg.replyDm) },
      });
    }

    const rule: Rule = { conditions, actions };
    if (isDirectCell) { directRules.push(rule); directCellLabels.push(cellMeta.label); }
    else { channelRules.push(rule); channelCellLabels.push(cellMeta.label); }
  }

  if (channelRules.length === 0 && directRules.length === 0) {
    return { automations: [], report: { converted, approximated, notConvertible, dropped }, blocking: 'NO_CELLS_ENABLED' };
  }

  if (anyReplyEmitted) {
    converted.push({
      key: 'autoAckMessage',
      label: 'Reply text',
      detail: settings.message
        ? 'Translated into action.sendMessage.text (see token notes below for any {TOKEN} substitutions).'
        : `Blank — used Auto-Acknowledge's own default template ("${AUTOACK_DEFAULT_MESSAGE}").`,
    });
    if (effectiveMessageDirect) {
      converted.push({
        key: 'autoAckMessageDirect',
        label: 'Direct-message reply text',
        detail: 'Used on the ZeroHop cells\' action.sendMessage.text instead of the standard reply text.',
      });
    }
    for (const token of usedConvertedTokens) {
      converted.push({ key: `token-${token}`, label: `Token ${token}`, detail: `Translated to ${TOKEN_MAP[token].engine}.` });
    }
    for (const token of usedApproximatedTokens) {
      approximated.push({ key: `token-${token}`, label: `Token ${token}`, detail: `Translated to ${TOKEN_MAP[token].engine} — ${TOKEN_MAP[token].reason}.` });
    }
    for (const token of usedNotConvertibleTokens) {
      notConvertible.push({ key: `token-${token}`, label: `Token ${token}`, detail: 'No engine equivalent — left verbatim in the message text so you can see and fix it.' });
    }
  }

  // ── §4.2 channel index → name resolution (only meaningful if a Channel automation is wanted) ──
  const automations: ConvertedAutomation[] = [];
  let blocking: AutoAckBlockingReason | undefined;

  if (channelRules.length > 0) {
    const channelIndices = parseChannelIndices(settings.channelsRaw);

    // CORRECTION (spec §4.2, found during WP2 implementation, orchestrator-verified):
    // an EMPTY allowlist means Auto-Acknowledge never acked ANY channel message
    // (meshtasticManager.ts's enabledChannelsSet.has(channelIndex) gate rejects every
    // index when the set is empty) — it is the OPPOSITE of "no channel restriction".
    // Emitting a Channel automation with no `channels` filter here would silently widen
    // dead behaviour into "answer on every channel", spamming the mesh. So an empty
    // allowlist means "no channel automation at all", not "match any channel" — distinct
    // from CHANNEL_ALLOWLIST_UNCONVERTIBLE below, which means the user listed channels but
    // none resolved (a config they must fix, not a valid no-op).
    if (channelIndices.length === 0) {
      notConvertible.push({
        key: 'channel-allowlist-empty',
        label: 'Channel allowlist',
        detail: "Auto-Acknowledge's channel allowlist was empty, so it never acknowledged channel messages — only the Direct cells were live. No channel automation was created.",
      });
    } else {
      const byNameLower = new Map<string, { name: string; indices: number[] }>();
      for (const idx of channelIndices) {
        const row = channels.find((c) => c.index === idx);
        if (!row) {
          notConvertible.push({ key: `channel-${idx}-missing`, label: `Channel #${idx}`, detail: `No channel row found at index ${idx} for this source; dropped from the allowlist.` });
          continue;
        }
        if (!isConfiguredChannel(row)) {
          notConvertible.push({ key: `channel-${idx}-disabled`, label: `Channel #${idx}`, detail: `Index ${idx} is a Disabled slot (role 0), not a real channel; dropped from the allowlist.` });
          continue;
        }
        const name = row.name.trim();
        if (!name) {
          notConvertible.push({
            key: `channel-${idx}-unnamed`,
            label: `Channel #${idx}`,
            detail: `Index ${idx} has a blank name. messageFilterChannelNames() drops blank names, and if every entry is blank the whole filter falls away and the automation would answer on every channel — so this index is dropped rather than emitted as an empty name.`,
          });
          continue;
        }
        const lower = name.toLowerCase();
        const existing = byNameLower.get(lower);
        if (existing) existing.indices.push(idx);
        else byNameLower.set(lower, { name, indices: [idx] });
      }

      const channelsOut: Array<{ name: string; protocol: 'meshtastic' }> = [];
      for (const { name, indices } of byNameLower.values()) {
        channelsOut.push({ name, protocol: 'meshtastic' });
        if (indices.length > 1) {
          approximated.push({
            key: 'channel-name-collision',
            label: 'Duplicate channel names',
            detail: `Indices ${indices.join(', ')} all resolve to the name "${name}"; the converted rule answers on all of them.`,
          });
        }
      }

      if (channelsOut.length === 0) {
        blocking = 'CHANNEL_ALLOWLIST_UNCONVERTIBLE';
      } else {
        converted.push({
          key: 'autoAckChannels',
          label: 'Channel allowlist',
          detail: `Resolved to: ${channelsOut.map((c) => c.name).join(', ')}.`,
        });
        const triggerParams: Record<string, unknown> = { regex, cooldownSeconds, cooldownScope: 'node', channels: channelsOut };
        const form: WorkflowForm = { trigger: { type: 'trigger.message', params: triggerParams }, rules: channelRules, combine: null };
        automations.push({
          key: 'channel',
          name: '', // filled in below, once we know whether this is the only automation
          description: buildDescription(sourceId, 'channel', channelCellLabels, now),
          enabled: settings.enabled,
          form,
          config: compile(form),
        });
      }
    }
  }

  if (directRules.length > 0) {
    const triggerParams: Record<string, unknown> = { regex, cooldownSeconds, cooldownScope: 'node' };
    const form: WorkflowForm = { trigger: { type: 'trigger.message', params: triggerParams }, rules: directRules, combine: null };
    automations.push({
      key: 'direct',
      name: '',
      description: buildDescription(sourceId, 'direct', directCellLabels, now),
      enabled: settings.enabled,
      form,
      config: compile(form),
    });
  }

  // ── §4.6 naming, resolved now that we know how many automations were built ──
  for (const a of automations) {
    a.name = automations.length === 1
      ? `Auto-Ack — ${sourceName}`
      : `Auto-Ack — ${sourceName} (${a.key === 'channel' ? 'Channels' : 'Direct messages'})`;
  }

  // An empty channel allowlist can leave `automations` empty even though `channelRules`
  // was non-empty (the Channel column had no live cells because of a config the user
  // never actually enabled — see the CORRECTION above). Distinct from
  // CHANNEL_ALLOWLIST_UNCONVERTIBLE (a config the user must fix): only fall back to the
  // generic NO_CELLS_ENABLED when nothing more specific is already blocking.
  if (automations.length === 0 && !blocking) {
    blocking = 'NO_CELLS_ENABLED';
  }

  return { automations, report: { converted, approximated, notConvertible, dropped }, blocking };
}
