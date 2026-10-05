/**
 * Builder ↔ graph round trip for run-scoped step outputs (#5636), and the
 * token hints the builder draws from the compiled graph.
 */
import { describe, it, expect } from 'vitest';
import { compile, decompile, blockNodeId, formOutputNames, outputNameErrors, type WorkflowForm, type FormBlock } from './compile.js';
import { validateAutomationGraph, stepOutputScopes } from '../../types/automation.js';
import { validTokenSet, classifyToken, diagnoseTokens, tokenize, stepTokenProblem, type StepTokenScope } from './tokenHints';
import { BLOCK_BY_TYPE } from './catalog';

const trig: FormBlock = { type: 'trigger.message', params: {} };
const script = (outputName?: string, extra: Record<string, unknown> = {}): FormBlock =>
  ({ type: 'action.runScript', params: { scriptPath: 'joke.py', ...(outputName === undefined ? {} : { outputName }), ...extra } });
const send = (text: string): FormBlock => ({ type: 'action.sendMessage', params: { text } });
const cond: FormBlock = { type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } };

describe('compile / decompile — outputName', () => {
  it('round-trips on the linear shape', () => {
    const form: WorkflowForm = { trigger: trig, rules: [{ conditions: [], actions: [script('joke'), send('{{ steps.joke.output }}')] }], combine: null };
    const graph = compile(form);
    expect(validateAutomationGraph(graph)).toMatchObject({ valid: true, errors: [] });
    expect(graph.nodes[1].params).toEqual({ scriptPath: 'joke.py', outputName: 'joke' });
    expect(decompile(graph)).toEqual(form);
  });

  it('round-trips on the fanout / FINALLY shape, in rules and in FINALLY', () => {
    const form: WorkflowForm = {
      trigger: trig,
      rules: [
        { conditions: [cond], actions: [script('one'), send('{{ steps.one.output }}')] },
        { conditions: [], actions: [script('two')] },
      ],
      combine: { mode: 'ALL', actions: [script('sum'), send('{{ steps.sum.output }}')] },
    };
    const graph = compile(form);
    expect(validateAutomationGraph(graph).valid).toBe(true);
    expect(decompile(graph)).toEqual(form);
    expect(decompile(JSON.parse(JSON.stringify(graph)))).toEqual(form); // survives export → import as JSON
  });

  it('keeps the name when the ids change: insert a step in front and the reference still resolves', () => {
    const before: WorkflowForm = { trigger: trig, rules: [{ conditions: [], actions: [script('joke'), send('{{ steps.joke.output }}')] }], combine: null };
    const after: WorkflowForm = { ...before, rules: [{ conditions: [], actions: [{ type: 'action.nothing', params: {} }, ...before.rules[0].actions] }] };
    const g1 = compile(before);
    const g2 = compile(after);
    expect(g1.nodes.find((n) => n.params?.outputName === 'joke')!.id).toBe('a0');
    expect(g2.nodes.find((n) => n.params?.outputName === 'joke')!.id).toBe('a1'); // id moved…
    expect(validateAutomationGraph(g2)).not.toHaveProperty('warnings');          // …the reference did not break
  });

  it('keeps a variable target and a run target apart', () => {
    const form: WorkflowForm = { trigger: trig, rules: [{ conditions: [], actions: [script(undefined, { resultVariable: 'saved' })] }], combine: null };
    const back = decompile(compile(form))!;
    expect(back.rules[0].actions[0].params).toEqual({ scriptPath: 'joke.py', resultVariable: 'saved' });
    expect(back.rules[0].actions[0].params).not.toHaveProperty('outputName');
  });

  it('drops a blank name on compile (it stores nothing) — which is why the builder flags it first', () => {
    const form: WorkflowForm = { trigger: trig, rules: [{ conditions: [], actions: [script('')] }], combine: null };
    expect(compile(form).nodes[1].params).toEqual({ scriptPath: 'joke.py' });
    expect(outputNameErrors(form)).toEqual(['Rule 1: name the script result you keep for this run.']);
  });

  it('blockNodeId names the node compile() makes for each block', () => {
    const linear: WorkflowForm = { trigger: trig, rules: [{ conditions: [cond], actions: [script('a'), send('x')] }], combine: null };
    const fan: WorkflowForm = { trigger: trig, rules: [linear.rules[0], { conditions: [cond], actions: [send('y')] }], combine: { mode: 'ANY', actions: [send('z')] } };
    for (const form of [linear, fan]) {
      const byId = new Map(compile(form).nodes.map((n) => [n.id, n]));
      form.rules.forEach((r, i) => {
        r.conditions.forEach((b, k) => expect(byId.get(blockNodeId(form, { section: 'condition', rule: i, index: k }))?.type).toBe(b.type));
        r.actions.forEach((b, k) => expect(byId.get(blockNodeId(form, { section: 'action', rule: i, index: k }))?.params).toEqual(b.params));
      });
      form.combine?.actions.forEach((b, k) => expect(byId.get(blockNodeId(form, { section: 'finally', index: k }))?.params).toEqual(b.params));
    }
  });
});

describe('outputNameErrors', () => {
  const form = (...actions: FormBlock[]): WorkflowForm => ({ trigger: trig, rules: [{ conditions: [], actions }], combine: null });

  it('passes good names and steps that store nothing', () => {
    expect(outputNameErrors(form(script('joke'), script('wx_2'), script(), send('x')))).toEqual([]);
  });

  it('flags a malformed name', () => {
    expect(outputNameErrors(form(script('Joke')))[0]).toMatch(/Rule 1: the run result name "Joke" must start with a lower-case letter/);
  });

  it('flags a name used twice, across rules and FINALLY', () => {
    const f: WorkflowForm = {
      trigger: trig,
      rules: [{ conditions: [], actions: [script('joke')] }, { conditions: [], actions: [script('joke')] }],
      combine: { mode: 'ANY', actions: [script('joke')] },
    };
    expect(outputNameErrors(f)).toEqual([
      'Rule 2: the run result name "joke" is used twice. Each name must be unique.',
      'FINALLY: the run result name "joke" is used twice. Each name must be unique.',
    ]);
    expect(formOutputNames(f)).toEqual(['joke', 'joke', 'joke']);
  });
});

describe('token hints for steps.*', () => {
  const valid = validTokenSet('trigger.message', ['saved']);
  const scope = (guaranteed: string[], possible: string[], all: string[]): StepTokenScope =>
    ({ guaranteed: new Set(guaranteed), possible: new Set(possible), all: new Set(all) });

  it('a step that always ran first is ok', () => {
    const s = scope(['joke'], ['joke'], ['joke']);
    expect(classifyToken('steps.joke.output', valid, s)).toBe('ok');
    expect(classifyToken('steps.joke.output.a.b', valid, s)).toBe('ok');
    expect(classifyToken('steps.joke.ok', valid, s)).toBe('ok');
    expect(diagnoseTokens('{{ steps.joke.output }} {{ steps.joke.ok }}', valid, s)).toEqual([]);
  });

  it('a name no step stores is an error: always empty', () => {
    expect(diagnoseTokens('{{ steps.nope.output }}', valid, scope([], [], ['joke']))).toEqual([
      { token: 'steps.nope.output', severity: 'error', detail: 'is always empty: no step stores its output as "nope"' },
    ]);
  });

  it('a step that does not run before this one is an error: always empty', () => {
    const s = scope([], [], ['joke']);
    expect(classifyToken('steps.joke.output', valid, s)).toBe('bad');
    expect(diagnoseTokens('{{ steps.joke.output }}', valid, s)).toEqual([
      { token: 'steps.joke.output', severity: 'error', detail: 'is always empty: the step that stores "joke" does not run before this one' },
    ]);
  });

  it('a step that runs first only on some paths is a warning: may be empty', () => {
    const s = scope([], ['joke'], ['joke']);
    expect(classifyToken('steps.joke.output', valid, s)).toBe('foreign');
    expect(diagnoseTokens('{{ steps.joke.output }}', valid, s)).toEqual([
      { token: 'steps.joke.output', severity: 'warn', detail: 'may be empty: the step that stores "joke" does not always run before this one' },
    ]);
  });

  it('a malformed steps token is an error', () => {
    const s = scope(['joke'], ['joke'], ['joke']);
    for (const path of ['steps.joke', 'steps.joke.stdout', 'steps.joke.ok.x', 'steps..output']) {
      expect(stepTokenProblem(path, s), path).toEqual({ severity: 'error', detail: 'is always empty: write steps.NAME.output or steps.NAME.ok' });
    }
  });

  it('a {{ var.* }}-only field refuses steps.* even for a step that ran', () => {
    expect(diagnoseTokens('{{ steps.joke.output }}', valid, 'refused')).toEqual([
      { token: 'steps.joke.output', severity: 'error', detail: 'is always empty: this field takes {{ var.* }} only' },
    ]);
    expect(BLOCK_BY_TYPE['action.broadcastWaypoint'].fields.find((f) => f.name === 'waypointKey')?.varsOnly).toBe(true);
  });

  it('outside the builder (no scope) every steps token is flagged', () => {
    expect(classifyToken('steps.joke.output', valid)).toBe('bad');
  });

  it('marks the token in the highlight layer', () => {
    const segs = tokenize('a {{ steps.joke.output }} b', valid, scope([], ['joke'], ['joke']));
    expect(segs.map((s) => s.status)).toEqual(['ok', 'foreign', 'ok']);
  });

  it('leaves the other namespaces as they were', () => {
    expect(classifyToken('trigger.text', valid)).toBe('ok');
    expect(classifyToken('var.saved', valid)).toBe('ok');
    expect(diagnoseTokens('{{ var.gone }}', valid)).toEqual([{ token: 'var.gone', severity: 'error', detail: 'does not exist' }]);
  });

  it('scopes come from ancestry in the compiled form, not list order', () => {
    // Rule 1 stores "joke". Rule 2 sits below it in the builder but cannot read it;
    // FINALLY (ANY) may; a later step in Rule 1 always can.
    const form: WorkflowForm = {
      trigger: trig,
      rules: [
        { conditions: [cond], actions: [script('joke'), send('{{ steps.joke.output }}')] },
        { conditions: [], actions: [send('{{ steps.joke.output }}')] },
      ],
      combine: { mode: 'ANY', actions: [send('{{ steps.joke.output }}')] },
    };
    const scopes = stepOutputScopes(compile(form));
    const at = (loc: Parameters<typeof blockNodeId>[1]): StepTokenScope => {
      const s = scopes.get(blockNodeId(form, loc))!;
      return { guaranteed: s.guaranteed, possible: s.possible, all: new Set(['joke']) };
    };
    const sev = (loc: Parameters<typeof blockNodeId>[1]) =>
      diagnoseTokens('{{ steps.joke.output }}', valid, at(loc)).map((d) => d.severity);
    expect(sev({ section: 'action', rule: 0, index: 1 })).toEqual([]);
    expect(sev({ section: 'action', rule: 1, index: 0 })).toEqual(['error']);
    expect(sev({ section: 'finally', index: 0 })).toEqual(['warn']);
    expect(sev({ section: 'condition', rule: 0, index: 0 })).toEqual(['error']);
  });
});
