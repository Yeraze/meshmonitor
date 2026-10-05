/**
 * Run-scoped step outputs (#5636): the name rules validateAutomationGraph
 * enforces, and the ancestry analysis behind the builder's "always empty" /
 * "may be empty" flags.
 */
import { describe, it, expect } from 'vitest';
import {
  validateAutomationGraph,
  analyzeStepOutputRefs,
  stepOutputScopes,
  stepOutputRefs,
  stepOutputNameOf,
  isStepOutputName,
  STEP_OUTPUT_MAX_BYTES,
  type AutomationGraph,
  type AutomationNode,
} from './automation.js';

const trigger: AutomationNode = { id: 't', type: 'trigger.message', params: {} };
const script = (id: string, outputName?: unknown): AutomationNode =>
  ({ id, type: 'action.runScript', params: { scriptPath: 's.py', ...(outputName === undefined ? {} : { outputName }) } });
const send = (id: string, text: string): AutomationNode => ({ id, type: 'action.sendMessage', params: { text } });
const cond = (id: string): AutomationNode => ({ id, type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } });
const chain = (...nodes: AutomationNode[]): AutomationGraph => ({
  version: 1,
  nodes,
  edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
});

/** trigger → fanout → rule chains → (optional) collapse → finally chain. */
function rules(ruleChains: AutomationNode[][], combine?: { mode: string; actions: AutomationNode[] }): AutomationGraph {
  const nodes: AutomationNode[] = [trigger, { id: 'f', type: 'flow.fanout', params: {} }];
  const edges: AutomationGraph['edges'] = [{ from: 't', to: 'f' }];
  const tails: string[] = [];
  for (const c of ruleChains) {
    let prev = 'f';
    for (const n of c) { nodes.push(n); edges.push({ from: prev, to: n.id }); prev = n.id; }
    tails.push(prev);
  }
  if (combine) {
    nodes.push({ id: 'col', type: 'flow.collapse', params: { mode: combine.mode } });
    for (const tail of tails) edges.push({ from: tail, to: 'col' });
    let prev = 'col';
    for (const n of combine.actions) { nodes.push(n); edges.push({ from: prev, to: n.id }); prev = n.id; }
  }
  return { version: 1, nodes, edges };
}

describe('run-output names', () => {
  it('the cap is 64 KiB', () => {
    expect(STEP_OUTPUT_MAX_BYTES).toBe(65536);
  });

  it('accepts [a-z][a-z0-9_]{0,31}', () => {
    for (const ok of ['a', 'joke', 'wx_2', 'a'.repeat(32), 'a_b_c9']) expect(isStepOutputName(ok), ok).toBe(true);
    for (const bad of ['', 'Joke', '9lives', '_x', 'a-b', 'a b', 'a.b', 'a'.repeat(33), 'é', 5, null, undefined, {}]) {
      expect(isStepOutputName(bad), String(bad)).toBe(false);
    }
  });

  it('only a Run a script step has one', () => {
    expect(stepOutputNameOf(script('a', 'joke'))).toBe('joke');
    expect(stepOutputNameOf(script('a'))).toBeUndefined();
    expect(stepOutputNameOf(script('a', 'Bad'))).toBeUndefined();
    expect(stepOutputNameOf({ type: 'action.sendMessage', params: { outputName: 'joke' } })).toBeUndefined();
  });

  it('finds the names steps.* tokens refer to', () => {
    expect(stepOutputRefs('a {{ steps.joke.output }} b {{steps.wx.output.temp}} {{ steps.joke.ok }} {{ var.steps.x }} {{ trigger.text }}'))
      .toEqual(['joke', 'wx']);
    expect(stepOutputRefs('no tokens')).toEqual([]);
  });

  it('uses the engine\'s token bounds, and stays fast on hostile text', () => {
    expect(stepOutputRefs('{{steps.a.output}}{{ steps.b.ok }}')).toEqual(['a', 'b']);
    expect(stepOutputRefs('{{ steps.a.output } {{ steps.b.output }}')).toEqual(['b']); // a lone } ends nothing
    expect(stepOutputRefs('{{{{ steps.c.output }}')).toEqual([]); // path is "{{ steps.c.output", as the engine reads it
    expect(stepOutputRefs('{{ steps.d.output')).toEqual([]);
    const started = Date.now();
    expect(stepOutputRefs('{{{{' + ' '.repeat(200_000))).toEqual([]);
    expect(stepOutputRefs('{{'.repeat(100_000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('validateAutomationGraph — outputName', () => {
  it('accepts a well-formed, unique name; absent and blank still validate', () => {
    expect(validateAutomationGraph(chain(trigger, script('a0', 'joke'), send('a1', '{{ steps.joke.output }}')))).toMatchObject({ valid: true, errors: [] });
    expect(validateAutomationGraph(chain(trigger, script('a0'))).valid).toBe(true);
    expect(validateAutomationGraph(chain(trigger, script('a0', ''))).valid).toBe(true);
  });

  it.each(['Joke', '9x', 'a-b', 'has space', 'a'.repeat(33), 7, true])('rejects the name %j', (name) => {
    const r = validateAutomationGraph(chain(trigger, script('a0', name)));
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/action\.runScript "a0" requires params\.outputName/);
  });

  it('rejects a name used twice, wherever the two steps sit', () => {
    const sameRule = validateAutomationGraph(chain(trigger, script('a0', 'joke'), script('a1', 'joke')));
    expect(sameRule.valid).toBe(false);
    expect(sameRule.errors).toEqual([
      'action.runScript "a1" reuses the run output name "joke" (already used by "a0"); names must be unique within an automation',
    ]);
    const twoRules = validateAutomationGraph(rules([[script('r0a0', 'joke')], [script('r1a0', 'joke')]]));
    expect(twoRules.valid).toBe(false);
    expect(twoRules.errors[0]).toMatch(/reuses the run output name "joke"/);
  });

  it('rejects outputName on any other block type (v1: Run a script only)', () => {
    const r = validateAutomationGraph(chain(trigger, { id: 'a0', type: 'action.sendMessage', params: { text: 'x', outputName: 'joke' } }));
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(['action.sendMessage "a0" cannot store a run output (params.outputName); only action.runScript can']);
  });

  it('a reference that will be empty is a warning, never a save error', () => {
    const r = validateAutomationGraph(chain(trigger, send('a0', '{{ steps.joke.output }}'), script('a1', 'joke')));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      'action.sendMessage "a0": {{ steps.joke }} is always empty: the step that stores "joke" does not run before this one',
    ]);
  });

  it('reports no warnings key when every reference is certain', () => {
    const r = validateAutomationGraph(chain(trigger, script('a0', 'joke'), send('a1', '{{ steps.joke.output }}')));
    expect(r).not.toHaveProperty('warnings');
  });
});

describe('analyzeStepOutputRefs — DAG ancestry, not list order', () => {
  const diag = (g: AutomationGraph) => analyzeStepOutputRefs(g).map((d) => `${d.nodeId}:${d.name}:${d.severity}`);

  it('a later step in the same rule reads it: no finding', () => {
    expect(diag(chain(trigger, script('a0', 'joke'), send('a1', '{{ steps.joke.output }} {{ steps.joke.ok }}')))).toEqual([]);
  });

  it('an unknown name is an error', () => {
    const d = analyzeStepOutputRefs(chain(trigger, send('a0', '{{ steps.nope.output }}')));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ nodeId: 'a0', name: 'nope', severity: 'error' });
    expect(d[0].message).toContain('always empty: no step stores its output as "nope"');
  });

  it('an earlier step in the same rule, and the step itself, are errors', () => {
    expect(diag(chain(trigger, send('a0', '{{ steps.joke.output }}'), script('a1', 'joke')))).toEqual(['a0:joke:error']);
    const self: AutomationNode = { id: 'a0', type: 'action.runScript', params: { scriptPath: 's.py', outputName: 'joke', args: '{{ steps.joke.output }}' } };
    expect(diag(chain(trigger, self))).toEqual(['a0:joke:error']);
  });

  it('a step in ANOTHER rule is an error even though it is listed first', () => {
    // Rule 1 stores "joke"; rule 2 (listed after it) reads it. Rules are
    // siblings under the fanout, so rule 2 never sees it.
    const g = rules([[script('r0a0', 'joke')], [send('r1a0', '{{ steps.joke.output }}')]]);
    const d = analyzeStepOutputRefs(g);
    expect(d.map((x) => `${x.nodeId}:${x.severity}`)).toEqual(['r1a0:error']);
    expect(d[0].message).toContain('does not run before this one');
  });

  it('a rule condition cannot read its own rule\'s output', () => {
    const c: AutomationNode = { id: 'c0', type: 'condition.numeric', params: { field: 'hops', op: '==', value: '{{ steps.n.output }}' } };
    expect(diag(chain(trigger, c, script('a0', 'n')))).toEqual(['c0:n:error']);
  });

  it.each(['ANY', 'NONE', 'ALWAYS'])('FINALLY under %s reading a conditional rule\'s output is a warning', (mode) => {
    const g = rules(
      [[cond('r0c0'), script('r0a0', 'joke')], [cond('r1c0'), send('r1a0', 'x')]],
      { mode, actions: [send('f0', '{{ steps.joke.output }}')] },
    );
    const d = analyzeStepOutputRefs(g);
    expect(d.map((x) => `${x.nodeId}:${x.name}:${x.severity}`)).toEqual(['f0:joke:warn']);
    expect(d[0].message).toContain('may be empty');
  });

  it('FINALLY under ALL is certain of every rule\'s output', () => {
    const g = rules(
      [[cond('r0c0'), script('r0a0', 'one')], [cond('r1c0'), script('r1a0', 'two')]],
      { mode: 'ALL', actions: [send('f0', '{{ steps.one.output }} {{ steps.two.output }}')] },
    );
    expect(diag(g)).toEqual([]);
  });

  it('FINALLY is certain of a step that runs on every event, whatever the mode', () => {
    for (const mode of ['ANY', 'NONE', 'ALWAYS']) {
      const g = rules(
        [[script('r0a0', 'always')], [cond('r1c0'), send('r1a0', 'x')]],
        { mode, actions: [send('f0', '{{ steps.always.output }}')] },
      );
      expect(diag(g), mode).toEqual([]);
    }
  });

  it('a later FINALLY step reads an earlier FINALLY step\'s output', () => {
    const g = rules([[cond('r0c0'), send('r0a0', 'x')], [send('r1a0', 'y')]], {
      mode: 'ANY', actions: [script('f0', 'sum'), send('f1', '{{ steps.sum.output }}')],
    });
    expect(diag(g)).toEqual([]);
  });

  it('finds references in any string param, nested ones included', () => {
    const notify: AutomationNode = { id: 'a0', type: 'action.notify', params: { title: '{{ steps.a.output }}', body: 'b', extra: [{ deep: '{{ steps.b.ok }}' }] } };
    expect(diag(chain(trigger, notify)).sort()).toEqual(['a0:a:error', 'a0:b:error']);
  });

  it('exposes the per-node scopes the builder uses', () => {
    const g = rules(
      [[cond('r0c0'), script('r0a0', 'joke'), send('r0a1', 'x')], [send('r1a0', 'y')]],
      { mode: 'ANY', actions: [send('f0', 'z')] },
    );
    const scopes = stepOutputScopes(g);
    expect([...scopes.get('r0a1')!.guaranteed]).toEqual(['joke']);
    expect([...scopes.get('r1a0')!.possible]).toEqual([]);
    expect([...scopes.get('f0')!.possible]).toEqual(['joke']);
    expect([...scopes.get('f0')!.guaranteed]).toEqual([]);
    expect([...scopes.get('r0a0')!.possible]).toEqual([]); // not its own
  });
});
