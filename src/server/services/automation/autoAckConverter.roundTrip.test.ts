/**
 * `buildAutoAckAutomations()` round-trip tests (#4340 Phase 4, WP2, spec §7).
 *
 * THE PHASE'S EXIT CRITERION. Every graph the converter produces must:
 *  1. pass `validateAutomationGraph()`;
 *  2. `decompile()` to a non-null form — `compile.ts:128` returns `null` for ANY
 *     ported edge, and `AutomationsPage.tsx` then opens the raw-JSON editor. A
 *     converted automation the user cannot open and edit in the builder is a
 *     failure, not a partial success (this is why WP1 added the flat `zeroHop`
 *     field instead of porting off `hops > 0`);
 *  3. `decompile(compile(form))` deep-equal the original `form`, modulo the
 *     same `clean()` normalisation `compile()` itself applies to params (blank/
 *     undefined/null values are dropped — replicated locally since `compile.ts`
 *     does not export `clean`);
 *  4. every `condition.numeric`/`condition.string` `field` value be offered by
 *     `numericFields`/`stringFields('trigger.message')` — otherwise the
 *     builder's `fieldselect` renders it blank and clobbers it on first edit;
 *  5. every emitted block `type` be a key of `BLOCK_BY_TYPE`, and every param
 *     name be a real `FieldDef.name` on that block.
 */
import { describe, it, expect } from 'vitest';
import { buildAutoAckAutomations, type AutoAckConverterInput, type ResolvedAutoAck } from './autoAckConverter.js';
import { decompile, type WorkflowForm, type FormBlock } from '../../../components/automations/compile.js';
import { validateAutomationGraph } from '../../../types/automation.js';
import { BLOCK_BY_TYPE, numericFields, stringFields } from '../../../components/automations/catalog.js';
import { DEFAULT_AUTOACK_MATRIX, matrixToSettings, type AutoAckMatrix } from '../../../utils/autoAckMatrix.js';

// ─── local `clean()` mirror (compile.ts's own — not exported) ─────────────
function clean(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === '' || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}
function cleanBlock(b: FormBlock): FormBlock { return { type: b.type, params: clean(b.params) }; }
function cleanForm(form: WorkflowForm): WorkflowForm {
  return {
    trigger: cleanBlock(form.trigger),
    rules: form.rules.map((r) => ({ conditions: r.conditions.map(cleanBlock), actions: r.actions.map(cleanBlock) })),
    combine: form.combine
      ? { mode: form.combine.mode, actions: form.combine.actions.map(cleanBlock) }
      : null,
  };
}

// ─── catalog cross-checks (points 4 and 5) ─────────────────────────────────
function checkBlockAgainstCatalog(block: FormBlock): void {
  const def = BLOCK_BY_TYPE[block.type];
  expect(def, `${block.type} is not a key of BLOCK_BY_TYPE`).toBeDefined();
  for (const key of Object.keys(block.params)) {
    expect(def.fields.some((f) => f.name === key), `${block.type} has no FieldDef named "${key}"`).toBe(true);
  }
  if (block.type === 'condition.numeric' || block.type === 'condition.string') {
    const groups = block.type === 'condition.numeric' ? numericFields('trigger.message') : stringFields('trigger.message');
    const offered = new Set(groups.flatMap((g) => g.options.map((o) => o.value)));
    expect(offered.has(String(block.params.field)), `field "${block.params.field}" is not offered by the ${block.type} picker for trigger.message`).toBe(true);
  }
}

function checkFormAgainstCatalog(form: WorkflowForm): void {
  checkBlockAgainstCatalog(form.trigger);
  for (const rule of form.rules) {
    rule.conditions.forEach(checkBlockAgainstCatalog);
    rule.actions.forEach(checkBlockAgainstCatalog);
  }
  if (form.combine) form.combine.actions.forEach(checkBlockAgainstCatalog);
}

// ─── fixtures: 8 configs spanning 1..4 enabled cells × delay/no-delay × skipIncomplete/ignoreList ──

function matrix(overrides: Partial<AutoAckMatrix>): AutoAckMatrix {
  return {
    channelZeroHop: { reply: false, tapback: false, replyDm: false },
    channelMultiHop: { reply: false, tapback: false, replyDm: false },
    directZeroHop: { reply: false, tapback: false, replyDm: false },
    directMultiHop: { reply: false, tapback: false, replyDm: false },
    ...overrides,
  };
}

function settings(overrides: Partial<ResolvedAutoAck>): ResolvedAutoAck {
  return {
    enabled: true,
    regex: undefined,
    message: '🤖 Copy, {NUMBER_HOPS} hops at {TIME}',
    messageDirect: undefined,
    channelsRaw: undefined,
    skipIncompleteNodes: false,
    ignoredNodesRaw: undefined,
    cooldownSecondsRaw: undefined,
    preSendDelaySecondsRaw: undefined,
    maxAttemptsRaw: undefined,
    rawMatrixAndLegacy: matrixToSettings(DEFAULT_AUTOACK_MATRIX),
    ...overrides,
  };
}

const CHANNEL_ROW = { index: 0, name: 'gauntlet', role: 1 };

const FIXTURES: Array<{ name: string; input: AutoAckConverterInput }> = [
  {
    name: '1 cell (channelZeroHop reply), no delay, no skipIncomplete, no ignoreList',
    input: {
      sourceId: 's1', sourceName: 'Source One', channels: [CHANNEL_ROW], now: new Date('2026-01-01'),
      settings: settings({ channelsRaw: '0', rawMatrixAndLegacy: matrixToSettings(matrix({ channelZeroHop: { reply: true, tapback: false, replyDm: false } })) }),
    },
  },
  {
    name: '1 cell (directMultiHop tapback), delay=10, skipIncomplete=true, no ignoreList',
    input: {
      sourceId: 's2', sourceName: 'Source Two', channels: [], now: new Date('2026-01-02'),
      settings: settings({
        preSendDelaySecondsRaw: '10', skipIncompleteNodes: true,
        rawMatrixAndLegacy: matrixToSettings(matrix({ directMultiHop: { reply: false, tapback: true, replyDm: false } })),
      }),
    },
  },
  {
    name: '2 channel cells (reply+tapback each), no delay, ignoreList set, no skipIncomplete',
    input: {
      sourceId: 's3', sourceName: 'Source Three', channels: [CHANNEL_ROW], now: new Date('2026-01-03'),
      settings: settings({
        channelsRaw: '0', ignoredNodesRaw: '!deadbeef, badtoken',
        rawMatrixAndLegacy: matrixToSettings(matrix({
          channelZeroHop: { reply: true, tapback: true, replyDm: false },
          channelMultiHop: { reply: true, tapback: true, replyDm: false },
        })),
      }),
    },
  },
  {
    name: '2 direct cells (reply+replyDm), delay=5, skipIncomplete=true, ignoreList set',
    input: {
      sourceId: 's4', sourceName: 'Source Four', channels: [], now: new Date('2026-01-04'),
      settings: settings({
        preSendDelaySecondsRaw: '5', skipIncompleteNodes: true, ignoredNodesRaw: '!aaaaaaaa',
        messageDirect: 'Direct ack {NODE_ID}',
        rawMatrixAndLegacy: matrixToSettings(matrix({
          directZeroHop: { reply: true, tapback: false, replyDm: true },
          directMultiHop: { reply: true, tapback: false, replyDm: true },
        })),
      }),
    },
  },
  {
    name: '3 cells (channelZeroHop, directZeroHop, directMultiHop), no delay, no skip, no ignore',
    input: {
      sourceId: 's5', sourceName: 'Source Five', channels: [CHANNEL_ROW], now: new Date('2026-01-05'),
      settings: settings({
        channelsRaw: '0',
        rawMatrixAndLegacy: matrixToSettings(matrix({
          channelZeroHop: { reply: true, tapback: true, replyDm: false },
          directZeroHop: { reply: true, tapback: false, replyDm: false },
          directMultiHop: { reply: false, tapback: true, replyDm: false },
        })),
      }),
    },
  },
  {
    name: '3 cells with delay + skipIncomplete + ignoreList all combined',
    input: {
      sourceId: 's6', sourceName: 'Source Six', channels: [CHANNEL_ROW], now: new Date('2026-01-06'),
      settings: settings({
        channelsRaw: '0', preSendDelaySecondsRaw: '20', skipIncompleteNodes: true, ignoredNodesRaw: '!bbbbbbbb, !cccccccc',
        rawMatrixAndLegacy: matrixToSettings(matrix({
          channelZeroHop: { reply: true, tapback: false, replyDm: true },
          channelMultiHop: { reply: false, tapback: true, replyDm: false },
          directZeroHop: { reply: true, tapback: true, replyDm: false },
        })),
      }),
    },
  },
  {
    name: 'all 4 cells enabled, no delay, no skip, no ignore, valid channel allowlist',
    input: {
      sourceId: 's7', sourceName: 'Source Seven', channels: [CHANNEL_ROW], now: new Date('2026-01-07'),
      settings: settings({
        channelsRaw: '0',
        rawMatrixAndLegacy: matrixToSettings(matrix({
          channelZeroHop: { reply: true, tapback: true, replyDm: false },
          channelMultiHop: { reply: true, tapback: false, replyDm: true },
          directZeroHop: { reply: true, tapback: true, replyDm: false },
          directMultiHop: { reply: true, tapback: false, replyDm: false },
        })),
      }),
    },
  },
  {
    name: 'all 4 cells enabled, delay + skipIncomplete + ignoreList all combined',
    input: {
      sourceId: 's8', sourceName: 'Source Eight', channels: [CHANNEL_ROW], now: new Date('2026-01-08'),
      settings: settings({
        channelsRaw: '0', preSendDelaySecondsRaw: '30', skipIncompleteNodes: true, ignoredNodesRaw: '!dddddddd',
        messageDirect: 'ZeroHop reply {LONG_NAME}',
        rawMatrixAndLegacy: matrixToSettings(matrix({
          channelZeroHop: { reply: true, tapback: true, replyDm: true },
          channelMultiHop: { reply: true, tapback: true, replyDm: false },
          directZeroHop: { reply: true, tapback: true, replyDm: false },
          directMultiHop: { reply: true, tapback: true, replyDm: false },
        })),
      }),
    },
  },
  {
    // §4.2a branch 3 — the default Meshtastic config: primary channel (index 0, role 1)
    // has a blank name, so the trigger must fall back to `channel` (kind: 'number',
    // catalog.ts:95) instead of `channels`. Round-trips this param specifically.
    name: '1 channel cell, unnamed primary channel → falls back to `channel: 0` (kind: number)',
    input: {
      sourceId: 's9', sourceName: 'Source Nine', channels: [{ index: 0, name: '', role: 1 }], now: new Date('2026-01-09'),
      settings: settings({
        channelsRaw: '0',
        rawMatrixAndLegacy: matrixToSettings(matrix({ channelZeroHop: { reply: true, tapback: true, replyDm: false } })),
      }),
    },
  },
];

describe('buildAutoAckAutomations round-trip (phase exit criterion)', () => {
  it.each(FIXTURES)('$name', ({ input }) => {
    const result = buildAutoAckAutomations(input);
    expect(result.blocking).toBeUndefined();
    expect(result.automations.length).toBeGreaterThan(0);

    for (const automation of result.automations) {
      const { config, form } = automation;

      const validation = validateAutomationGraph(config);
      expect(validation.valid, `invalid graph for "${automation.name}": ${validation.errors.join('; ')}`).toBe(true);

      const decompiled = decompile(config);
      expect(
        decompiled,
        `decompile() returned null for "${automation.name}" — compile.ts:128 drops any ported edge, and the automation would open in the raw-JSON editor: a failure, not a partial success`,
      ).not.toBeNull();
      expect(decompiled).toEqual(cleanForm(form));

      checkFormAgainstCatalog(form);
    }
  });

  it('the §4.2a-branch-3 `channel` (kind: number) param survives decompile() with its value intact', () => {
    const fixture = FIXTURES.find((f) => f.name.includes('falls back to `channel: 0`'))!;
    const result = buildAutoAckAutomations(fixture.input);
    const chan = result.automations.find((a) => a.key === 'channel')!;
    expect(chan.form.trigger.params.channel).toBe(0);
    expect(chan.form.trigger.params.channels).toBeUndefined();

    const decompiled = decompile(chan.config);
    expect(decompiled, 'decompile() returned null for the channel-by-index fixture').not.toBeNull();
    expect(decompiled!.trigger.params.channel).toBe(0);
    expect(decompiled!.trigger.params.channels).toBeUndefined();
  });
});
