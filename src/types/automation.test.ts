import { describe, it, expect } from 'vitest';
import {
  validateAutomationGraph,
  categoryOf,
  parseCooldownScope,
  parseSendMaxAttempts,
  parseRateLimit,
  SEND_MAX_ATTEMPTS_MIN,
  SEND_MAX_ATTEMPTS_MAX,
  RATE_LIMIT_MAX_ACTIONS_MAX,
  AUTOMATION_CONFIG_VERSION,
  type AutomationGraph,
} from './automation.js';

/** A minimal valid graph: trigger → tapback. */
function baseGraph(overrides: Partial<AutomationGraph> = {}): AutomationGraph {
  return {
    version: AUTOMATION_CONFIG_VERSION,
    nodes: [
      { id: 't', type: 'trigger.message', params: { textContains: 'ping' } },
      { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
    ],
    edges: [{ from: 't', to: 'a' }],
    ...overrides,
  };
}

describe('categoryOf', () => {
  it('classifies by prefix', () => {
    expect(categoryOf('trigger.message')).toBe('trigger');
    expect(categoryOf('condition.numeric')).toBe('condition');
    expect(categoryOf('action.tapback')).toBe('action');
    expect(categoryOf('flow.collapse')).toBe('flow');
  });
});

describe('validateAutomationGraph', () => {
  it('accepts a minimal valid graph', () => {
    const r = validateAutomationGraph(baseGraph());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.graph).toBeDefined();
  });

  it('accepts an If/ElseIf/Else routing graph (true/false ports)', () => {
    const g: AutomationGraph = {
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: { regex: '^(test|ping)' } },
        { id: 'c', type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } },
        { id: 'tap', type: 'action.tapback', params: { emoji: '👍' } },
        { id: 'msg', type: 'action.sendMessage', params: { text: 'pong' } },
      ],
      edges: [
        { from: 't', to: 'c' },
        { from: 'c', to: 'tap', port: 'true' },
        { from: 'c', to: 'msg', port: 'false' },
      ],
    };
    expect(validateAutomationGraph(g).valid).toBe(true);
  });

  it('condition.meshcoreScope: accepts valid modes, rejects an empty named block (#3914)', () => {
    const withCond = (params: Record<string, unknown>): AutomationGraph => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'c', type: 'condition.meshcoreScope', params },
        { id: 'a', type: 'action.sendMessage', params: { text: 'hi' } },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a' }],
    });
    expect(validateAutomationGraph(withCond({ mode: 'unscoped' })).valid).toBe(true);
    expect(validateAutomationGraph(withCond({ mode: 'scoped' })).valid).toBe(true);
    expect(validateAutomationGraph(withCond({ mode: 'named', regions: 'de' })).valid).toBe(true);
    expect(validateAutomationGraph(withCond({ mode: 'named', includeUnscoped: true })).valid).toBe(true);
    // named with neither regions nor includeUnscoped → error
    const empty = validateAutomationGraph(withCond({ mode: 'named' }));
    expect(empty.valid).toBe(false);
    expect(empty.errors.join(' ')).toMatch(/requires params\.regions or params\.includeUnscoped/);
    // unknown mode → error
    expect(validateAutomationGraph(withCond({ mode: 'bogus' })).valid).toBe(false);
  });

  it('action.deviceReboot: optional targetNodeNum validates present/absent (#4126)', () => {
    const withReboot = (params: Record<string, unknown>): AutomationGraph => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.schedule', params: { cron: '0 3 * * *' } },
        { id: 'a', type: 'action.deviceReboot', params },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    // absent → valid (local-only reboot, unchanged behavior)
    expect(validateAutomationGraph(withReboot({})).valid).toBe(true);
    // blank string → valid (treated as absent)
    expect(validateAutomationGraph(withReboot({ targetNodeNum: '' })).valid).toBe(true);
    // positive node number → valid (remote-admin reboot)
    expect(validateAutomationGraph(withReboot({ targetNodeNum: 123456789 })).valid).toBe(true);
    // zero / negative / non-integer → error
    expect(validateAutomationGraph(withReboot({ targetNodeNum: 0 })).valid).toBe(false);
    const neg = validateAutomationGraph(withReboot({ targetNodeNum: -1 }));
    expect(neg.valid).toBe(false);
    expect(neg.errors.join(' ')).toMatch(/positive node number/);
    expect(validateAutomationGraph(withReboot({ targetNodeNum: 1.5 })).valid).toBe(false);
  });

  // ── action.tapback emojiMode (#4340) ────────────────────────────────────
  it('action.tapback: emojiMode validates when present, and absence still validates', () => {
    const withTapback = (params: Record<string, unknown>): AutomationGraph => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'a', type: 'action.tapback', params },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    // absent → valid (pre-4.14 stored automations keep validating)
    expect(validateAutomationGraph(withTapback({})).valid).toBe(true);
    expect(validateAutomationGraph(withTapback({ emoji: '👍' })).valid).toBe(true);
    // valid modes
    expect(validateAutomationGraph(withTapback({ emojiMode: 'fixed' })).valid).toBe(true);
    expect(validateAutomationGraph(withTapback({ emojiMode: 'hopCount' })).valid).toBe(true);
    // invalid mode → error
    const bad = validateAutomationGraph(withTapback({ emojiMode: 'random' }));
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/emojiMode ∈ \{fixed,hopCount\}/);
  });

  // ── trigger.* cooldownScope (#4340 Phase 2) ─────────────────────────────
  it('trigger.message: cooldownScope validates when present, and absence still validates', () => {
    const withTrigger = (params: Record<string, unknown>): AutomationGraph => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params },
        { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    // absent → valid (pre-Phase-2 stored automations keep validating unchanged)
    expect(validateAutomationGraph(withTrigger({})).valid).toBe(true);
    expect(validateAutomationGraph(withTrigger({ textContains: 'ping' })).valid).toBe(true);
    // valid scopes
    expect(validateAutomationGraph(withTrigger({ cooldownScope: 'automation' })).valid).toBe(true);
    expect(validateAutomationGraph(withTrigger({ cooldownScope: 'node' })).valid).toBe(true);
    expect(validateAutomationGraph(withTrigger({ cooldownScope: 'sourceNode' })).valid).toBe(true);
    // invalid scope → error
    const bad = validateAutomationGraph(withTrigger({ cooldownScope: 'perNode' }));
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/cooldownScope ∈ \{automation,node,sourceNode\}/);
  });

  it('cooldownScope guard applies to every trigger type, not just trigger.message', () => {
    const withTelemetryTrigger = (params: Record<string, unknown>): AutomationGraph => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.telemetry', params },
        { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    expect(validateAutomationGraph(withTelemetryTrigger({ cooldownScope: 'node' })).valid).toBe(true);
    const bad = validateAutomationGraph(withTelemetryTrigger({ cooldownScope: 'bogus' }));
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/trigger\.telemetry .* requires params\.cooldownScope ∈ \{automation,node,sourceNode\}/);
  });

  // ── trigger.* rateLimit (#4577 Phase 2, RATE-LIMIT) ─────────────────────
  it('trigger.message: rateLimit validates when present, and absence still validates', () => {
    const withTrigger = (params: Record<string, unknown>): AutomationGraph => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params },
        { id: 'a', type: 'action.tapback', params: { emoji: '👍' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    // absent → valid (pre-Phase-2 stored automations keep validating unchanged)
    expect(validateAutomationGraph(withTrigger({})).valid).toBe(true);
    expect(validateAutomationGraph(withTrigger({ textContains: 'ping' })).valid).toBe(true);
    // valid rateLimit
    expect(validateAutomationGraph(withTrigger({ rateLimit: { maxActions: 5, windowSeconds: 60 } })).valid).toBe(true);
    expect(validateAutomationGraph(withTrigger({ rateLimit: { maxActions: 1, windowSeconds: 1 } })).valid).toBe(true);
    // maxActions 0 → error
    const zeroMax = validateAutomationGraph(withTrigger({ rateLimit: { maxActions: 0, windowSeconds: 60 } }));
    expect(zeroMax.valid).toBe(false);
    expect(zeroMax.errors.join(' ')).toMatch(/requires params\.rateLimit = \{ maxActions >= 1, windowSeconds >= 1 \}/);
    // non-integer maxActions → error
    expect(validateAutomationGraph(withTrigger({ rateLimit: { maxActions: 2.5, windowSeconds: 60 } })).valid).toBe(false);
    // windowSeconds 0 → error
    expect(validateAutomationGraph(withTrigger({ rateLimit: { maxActions: 5, windowSeconds: 0 } })).valid).toBe(false);
    // non-object rateLimit → error
    expect(validateAutomationGraph(withTrigger({ rateLimit: 'often' })).valid).toBe(false);
    expect(validateAutomationGraph(withTrigger({ rateLimit: [5, 60] })).valid).toBe(false);
  });

  it('trigger.becameMobile / trigger.leftHome require a non-empty nodeNums list', () => {
    const graph = (type: string, params: Record<string, unknown>): AutomationGraph => ({
      version: 1,
      nodes: [
        { id: 't', type: type as any, params },
        { id: 'a', type: 'action.notify', params: { body: 'x' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    expect(validateAutomationGraph(graph('trigger.becameMobile', {})).valid).toBe(false);
    expect(validateAutomationGraph(graph('trigger.becameMobile', { nodeNums: [] })).valid).toBe(false);
    expect(validateAutomationGraph(graph('trigger.becameMobile', { nodeNums: [1, 2] })).valid).toBe(true);
    expect(validateAutomationGraph(graph('trigger.leftHome', { nodeNums: [1], thresholdMeters: 0 })).valid).toBe(false);
    expect(validateAutomationGraph(graph('trigger.leftHome', { nodeNums: [1], thresholdMeters: 100 })).valid).toBe(true);
    expect(validateAutomationGraph(graph('trigger.leftHome', { nodeNums: [1] })).valid).toBe(true); // default threshold
  });

  // ── action.sendMessage maxAttempts (#4340 Phase 3) ──────────────────────
  it('action.sendMessage: maxAttempts validates when present, and absence still validates', () => {
    const withSendMessage = (params: Record<string, unknown>): AutomationGraph => ({
      version: 1,
      nodes: [
        { id: 't', type: 'trigger.message', params: {} },
        { id: 'a', type: 'action.sendMessage', params },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    // absent → valid (pre-Phase-3 stored automations, and any automation that
    // never sets maxAttempts, keep validating byte-identically to today)
    expect(validateAutomationGraph(withSendMessage({ text: 'pong' })).valid).toBe(true);
    // a graph with only `text` still validates — the new case must not require
    // anything (regression per §6).
    expect(validateAutomationGraph(withSendMessage({})).valid).toBe(true);
    // blank string → valid (treated as absent)
    expect(validateAutomationGraph(withSendMessage({ text: 'pong', maxAttempts: '' })).valid).toBe(true);
    // in-range values → valid
    expect(validateAutomationGraph(withSendMessage({ text: 'pong', maxAttempts: 1 })).valid).toBe(true);
    expect(validateAutomationGraph(withSendMessage({ text: 'pong', maxAttempts: 2 })).valid).toBe(true);
    expect(validateAutomationGraph(withSendMessage({ text: 'pong', maxAttempts: 3 })).valid).toBe(true);
    // out-of-range / non-integer / non-numeric → error, with the ∈ [1, 3] message
    for (const bad of [0, 4, 'x', 2.5]) {
      const r = validateAutomationGraph(withSendMessage({ text: 'pong', maxAttempts: bad }));
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/requires params\.maxAttempts ∈ \[1, 3\]/);
    }
  });

  it('rejects non-object config', () => {
    expect(validateAutomationGraph(null).valid).toBe(false);
    expect(validateAutomationGraph(42).errors[0]).toMatch(/must be an object/);
  });

  it('rejects malformed top-level shape', () => {
    const r = validateAutomationGraph({ version: 'x', nodes: {}, edges: 1 });
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/version must be a number/),
      expect.stringMatching(/nodes must be an array/),
      expect.stringMatching(/edges must be an array/),
    ]));
  });

  it('requires exactly one trigger', () => {
    const none = baseGraph({
      nodes: [{ id: 'a', type: 'action.tapback' }],
      edges: [],
    });
    expect(validateAutomationGraph(none).errors.join()).toMatch(/exactly one trigger/);

    const two = baseGraph({
      nodes: [
        { id: 't1', type: 'trigger.message' },
        { id: 't2', type: 'trigger.schedule' },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't1', to: 'a' }, { from: 't2', to: 'a' }],
    });
    expect(validateAutomationGraph(two).errors.join()).toMatch(/found 2/);
  });

  it('rejects unknown node types and duplicate ids', () => {
    expect(validateAutomationGraph(baseGraph({
      nodes: [{ id: 't', type: 'trigger.message' }, { id: 'a', type: 'action.bogus' as any }],
      edges: [{ from: 't', to: 'a' }],
    })).errors.join()).toMatch(/unknown type/);

    expect(validateAutomationGraph(baseGraph({
      nodes: [{ id: 'dup', type: 'trigger.message' }, { id: 'dup', type: 'action.tapback' }],
      edges: [],
    })).errors.join()).toMatch(/duplicate node id/);
  });

  it('rejects edges to/from unknown nodes and self-loops', () => {
    expect(validateAutomationGraph(baseGraph({
      edges: [{ from: 't', to: 'ghost' }],
    })).errors.join()).toMatch(/unknown node "ghost"/);

    expect(validateAutomationGraph(baseGraph({
      nodes: [{ id: 't', type: 'trigger.message' }, { id: 'a', type: 'action.tapback' }],
      edges: [{ from: 'a', to: 'a' }],
    })).errors.join()).toMatch(/self-loop/);
  });

  it('rejects ports on non-condition edges and invalid port values', () => {
    expect(validateAutomationGraph(baseGraph({
      edges: [{ from: 't', to: 'a', port: 'true' }],
    })).errors.join()).toMatch(/only allowed on edges leaving a condition/);

    const g = baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'condition.string', params: { op: 'contains', value: 'x' } },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a', port: 'maybe' as any }],
    });
    expect(validateAutomationGraph(g).errors.join()).toMatch(/port must be/);
  });

  it('rejects incoming edges to a trigger', () => {
    const g = baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 't' }],
    });
    // a→t also forms a cycle, but the trigger-incoming check fires first
    expect(validateAutomationGraph(g).errors.join()).toMatch(/must not have incoming edges/);
  });

  it('detects cycles', () => {
    const g = baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'a', type: 'flow.fanout' },
        { id: 'b', type: 'flow.fanout' },
      ],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    });
    expect(validateAutomationGraph(g).errors.join()).toMatch(/acyclic/);
  });

  it('flags orphan (unreachable) nodes', () => {
    const g = baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'a', type: 'action.tapback' },
        { id: 'orphan', type: 'action.sendMessage', params: { text: 'hi' } },
      ],
      edges: [{ from: 't', to: 'a' }],
    });
    expect(validateAutomationGraph(g).errors.join()).toMatch(/not reachable from the trigger/);
  });

  it('applies light per-block param checks', () => {
    expect(validateAutomationGraph(baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'c', type: 'flow.collapse', params: { mode: 'MAYBE' } },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a' }],
    })).errors.join()).toMatch(/mode ∈/);

    expect(validateAutomationGraph(baseGraph({
      nodes: [
        { id: 't', type: 'trigger.message' },
        { id: 'v', type: 'flow.setVar', params: {} },
        { id: 'a', type: 'action.tapback' },
      ],
      edges: [{ from: 't', to: 'v' }, { from: 'v', to: 'a' }],
    })).errors.join()).toMatch(/requires params.variable/);
  });
});

describe('parseCooldownScope', () => {
  it('round-trips each valid value', () => {
    expect(parseCooldownScope('automation')).toBe('automation');
    expect(parseCooldownScope('node')).toBe('node');
    expect(parseCooldownScope('sourceNode')).toBe('sourceNode');
  });

  it('coerces absent/blank/unrecognised values to "automation"', () => {
    expect(parseCooldownScope(undefined)).toBe('automation');
    expect(parseCooldownScope(null)).toBe('automation');
    expect(parseCooldownScope('')).toBe('automation');
    expect(parseCooldownScope('bogus')).toBe('automation');
    expect(parseCooldownScope(0)).toBe('automation');
  });
});

describe('parseSendMaxAttempts', () => {
  it('bounds are 1 and 3 (#4340 Phase 3)', () => {
    expect(SEND_MAX_ATTEMPTS_MIN).toBe(1);
    expect(SEND_MAX_ATTEMPTS_MAX).toBe(3);
  });

  it('round-trips each in-range integer value', () => {
    expect(parseSendMaxAttempts(1)).toBe(1);
    expect(parseSendMaxAttempts(2)).toBe(2);
    expect(parseSendMaxAttempts(3)).toBe(3);
  });

  it('coerces a numeric string', () => {
    expect(parseSendMaxAttempts('2')).toBe(2);
  });

  it('returns undefined for absent/blank/unparseable values', () => {
    expect(parseSendMaxAttempts(undefined)).toBeUndefined();
    expect(parseSendMaxAttempts(null)).toBeUndefined();
    expect(parseSendMaxAttempts('')).toBeUndefined();
    expect(parseSendMaxAttempts('x')).toBeUndefined();
    expect(parseSendMaxAttempts(1.5)).toBeUndefined();
  });

  it('clamps out-of-range values instead of rejecting them (lenient at runtime)', () => {
    expect(parseSendMaxAttempts(0)).toBe(1);
    expect(parseSendMaxAttempts(9)).toBe(3);
  });
});

describe('parseRateLimit', () => {
  it('round-trips a valid shape', () => {
    expect(parseRateLimit({ maxActions: 5, windowSeconds: 60 })).toEqual({ maxActions: 5, windowSeconds: 60 });
    expect(parseRateLimit({ maxActions: 1, windowSeconds: 1 })).toEqual({ maxActions: 1, windowSeconds: 1 });
  });

  it('returns undefined for absent/blank/garbage values', () => {
    expect(parseRateLimit(undefined)).toBeUndefined();
    expect(parseRateLimit(null)).toBeUndefined();
    expect(parseRateLimit('')).toBeUndefined();
    expect(parseRateLimit('bogus')).toBeUndefined();
    expect(parseRateLimit(42)).toBeUndefined();
    expect(parseRateLimit([5, 60])).toBeUndefined();
    expect(parseRateLimit({})).toBeUndefined();
    expect(parseRateLimit({ maxActions: 0, windowSeconds: 60 })).toBeUndefined();
    expect(parseRateLimit({ maxActions: 2.5, windowSeconds: 60 })).toBeUndefined();
    expect(parseRateLimit({ maxActions: 5, windowSeconds: 0 })).toBeUndefined();
    expect(parseRateLimit({ maxActions: 5 })).toBeUndefined();
  });

  it('clamps maxActions above RATE_LIMIT_MAX_ACTIONS_MAX instead of rejecting it (lenient at runtime)', () => {
    expect(parseRateLimit({ maxActions: RATE_LIMIT_MAX_ACTIONS_MAX + 500, windowSeconds: 60 }))
      .toEqual({ maxActions: RATE_LIMIT_MAX_ACTIONS_MAX, windowSeconds: 60 });
  });
});
