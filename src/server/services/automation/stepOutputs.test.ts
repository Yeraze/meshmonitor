/**
 * Run-scoped step outputs (#5636): the `steps.` token resolver, the store a
 * "Run a script" step writes, the empty-send rule, and the variable-write
 * failure that used to pass silently.
 */
import { describe, it, expect } from 'vitest';
import { executeAction, actionStepDetail, type ActionDeps } from './actionExecutor.js';
import {
  capStepOutput,
  createStepOutputs,
  interpolateAsync,
  resolveStepValue,
  type EngineEvalContext,
  type StepOutput,
} from './engineContext.js';
import type { TriggerContext } from './triggerContext.js';
import type { VariableResolver, SetResult } from './variableResolver.js';
import { STEP_OUTPUT_MAX_BYTES, type AutomationNode } from '../../../types/automation.js';
import { TxDisabledError } from '../../errors/txDisabledError.js';

type ScriptResult = { success: boolean; returnValue?: unknown; stdout: string; error?: string };

function recorder(script: ScriptResult = { success: true, stdout: '' }) {
  const calls: Array<{ fn: string; args: any }> = [];
  const deps: ActionDeps = {
    sendMessage: async (a) => { calls.push({ fn: 'sendMessage', args: a }); return 1; },
    sendTapback: async (a) => { calls.push({ fn: 'sendTapback', args: a }); return 2; },
    manageNode: async (a) => { calls.push({ fn: 'manageNode', args: a }); return 3; },
    requestData: async (a) => { calls.push({ fn: 'requestData', args: a }); return 5; },
    rebootDevice: async (a) => { calls.push({ fn: 'rebootDevice', args: a }); return 6; },
    notify: async (a) => { calls.push({ fn: 'notify', args: a }); return 4; },
    broadcastWaypoint: async (a) => { calls.push({ fn: 'broadcastWaypoint', args: a }); return 7; },
    runScript: async (a) => { calls.push({ fn: 'runScript', args: a }); return script; },
  };
  const sends = () => calls.filter((c) => c.fn === 'sendMessage' || c.fn === 'sendTapback' || c.fn === 'notify');
  return { calls, deps, sends };
}

interface CtxOptions {
  fields?: Record<string, unknown>;
  outputs?: Map<string, StepOutput>;
  vars?: Record<string, unknown>;
  setValue?: (name: string, value: unknown) => Promise<SetResult>;
  protocol?: string;
  channels?: Array<{ id: number; name: string; role?: number }>;
}

function ctx(o: CtxOptions = {}): EngineEvalContext {
  const fields = o.fields ?? { from: 111, channel: 2, isDM: false, packetId: 9 };
  const trigger: TriggerContext = {
    triggerType: 'trigger.message',
    sourceId: 'default',
    subjectNodeNum: typeof fields.from === 'number' ? fields.from : null,
    timestamp: 1000,
    fields,
  };
  const vars = {
    getValue: async (name: string) => (o.vars && name in o.vars ? o.vars[name] : null),
    setValue: o.setValue ?? (async () => ({ ok: true })),
  } as unknown as VariableResolver;
  const data = {
    getNode: async () => null,
    getTelemetry: async () => null,
    ...(o.protocol ? { getSourceProtocol: async () => o.protocol! } : {}),
    ...(o.channels ? { getChannels: async () => o.channels! } : {}),
  };
  return {
    trigger, vars, data, now: 1000,
    varCtx: { sourceId: 'default', nodeNum: trigger.subjectNodeNum },
    stepOutputs: o.outputs ?? createStepOutputs(),
  };
}

const node = (type: string, params: Record<string, unknown>, id = 'a'): AutomationNode => ({ id, type: type as any, params });
const stored = (entries: Record<string, StepOutput>) => new Map(Object.entries(entries));

describe('steps.* token resolver', () => {
  const outputs = stored({
    joke: { ok: true, output: 'Why did the node cross the mesh?' },
    wx: { ok: true, output: { temp: 21, wind: { kph: 12, dir: 'NW' }, tags: ['a', 'b'] } },
    broke: { ok: false },
  });

  it('renders text output', async () => {
    expect(await interpolateAsync('> {{ steps.joke.output }}', ctx({ outputs }))).toBe('> Why did the node cross the mesh?');
  });

  it('walks a nested path into JSON output, array indexes included', async () => {
    const c = ctx({ outputs });
    expect(await interpolateAsync('{{ steps.wx.output.wind.kph }} kph {{ steps.wx.output.wind.dir }}', c)).toBe('12 kph NW');
    expect(await interpolateAsync('{{ steps.wx.output.tags.1 }}', c)).toBe('b');
  });

  it('renders an object as JSON', async () => {
    const c = ctx({ outputs });
    expect(await interpolateAsync('{{ steps.wx.output.wind }}', c)).toBe('{"kph":12,"dir":"NW"}');
    expect(JSON.parse(await interpolateAsync('{{ steps.wx.output }}', c))).toEqual({ temp: 21, wind: { kph: 12, dir: 'NW' }, tags: ['a', 'b'] });
  });

  it('renders .ok as true / false', async () => {
    const c = ctx({ outputs });
    expect(await interpolateAsync('{{ steps.joke.ok }}/{{ steps.broke.ok }}', c)).toBe('true/false');
  });

  it('renders empty for a missing name, a missing path, a failed step and a malformed token', async () => {
    const c = ctx({ outputs });
    expect(await interpolateAsync('[{{ steps.nope.output }}]', c)).toBe('[]');
    expect(await interpolateAsync('[{{ steps.nope.ok }}]', c)).toBe('[]');
    expect(await interpolateAsync('[{{ steps.wx.output.wind.gust }}]', c)).toBe('[]');
    expect(await interpolateAsync('[{{ steps.joke.output.length }}]', c)).toBe('[]');
    expect(await interpolateAsync('[{{ steps.broke.output }}]', c)).toBe('[]');
    expect(await interpolateAsync('[{{ steps.joke }}]', c)).toBe('[]');
    expect(await interpolateAsync('[{{ steps.joke.stdout }}]', c)).toBe('[]');
    expect(await interpolateAsync('[{{ steps.joke.ok.x }}]', c)).toBe('[]');
  });

  it('never reaches inherited properties', () => {
    expect(resolveStepValue(outputs, 'wx.output.constructor')).toBeUndefined();
    expect(resolveStepValue(outputs, 'wx.output.__proto__')).toBeUndefined();
    expect(resolveStepValue(outputs, '__proto__.output')).toBeUndefined();
    expect(resolveStepValue(outputs, 'wx.output.tags.length')).toBe(2); // own property of an array
  });

  it('renders empty when the run has no store at all', async () => {
    const c = ctx();
    delete c.stepOutputs;
    expect(await interpolateAsync('[{{ steps.joke.output }}]', c)).toBe('[]');
  });

  it('does NOT expand templates found inside an output (single pass)', async () => {
    const hostile = stored({
      a: { ok: true, output: 'x {{ var.secret }} {{ trigger.text }} {{ steps.b.output }} y' },
      b: { ok: true, output: 'B' },
      j: { ok: true, output: { t: '{{ var.secret }}' } },
    });
    const c = ctx({ outputs: hostile, vars: { secret: 'TOP-SECRET' }, fields: { from: 111, text: 'hello' } });
    expect(await interpolateAsync('{{ steps.a.output }}', c)).toBe('x {{ var.secret }} {{ trigger.text }} {{ steps.b.output }} y');
    expect(await interpolateAsync('{{ steps.j.output.t }}', c)).toBe('{{ var.secret }}');
    // The same template still resolves its OWN tokens.
    expect(await interpolateAsync('{{ var.secret }}|{{ steps.a.output }}', c)).toBe('TOP-SECRET|x {{ var.secret }} {{ trigger.text }} {{ steps.b.output }} y');
  });

  it('varsOnly fields refuse steps.* and still accept var.*', async () => {
    const c = ctx({ outputs: stored({ url: { ok: true, output: 'discord://evil' } }), vars: { hook: 'discord://mine' } });
    expect(await interpolateAsync('{{ steps.url.output }}', c, { varsOnly: true })).toBe('');
    expect(await interpolateAsync('{{ var.hook }}{{ steps.url.output }}', c, { varsOnly: true })).toBe('discord://mine');
  });

  it('a notify action never takes an Apprise URL from a step output', async () => {
    const { calls, deps } = recorder();
    const c = ctx({ outputs: stored({ url: { ok: true, output: 'discord://evil' } }) });
    await executeAction(node('action.notify', { body: 'b', urls: '{{ steps.url.output }}\ntgram://ok' }), c, deps);
    expect(calls[0].args.urls).toEqual(['tgram://ok']);
  });
});

describe('capStepOutput', () => {
  it('leaves output at or under the cap alone', () => {
    const exact = 'a'.repeat(STEP_OUTPUT_MAX_BYTES);
    expect(capStepOutput(exact)).toEqual({ value: exact, truncated: false });
    expect(capStepOutput({ a: 1 })).toEqual({ value: { a: 1 }, truncated: false });
  });

  it('cuts text at 64 KiB', () => {
    const r = capStepOutput('a'.repeat(STEP_OUTPUT_MAX_BYTES + 1));
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.value as string, 'utf8')).toBe(STEP_OUTPUT_MAX_BYTES);
  });

  it('never splits a multi-byte character', () => {
    // 3-byte characters: the cap does not land on a boundary.
    const r = capStepOutput('€'.repeat(STEP_OUTPUT_MAX_BYTES));
    const text = r.value as string;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(STEP_OUTPUT_MAX_BYTES);
    expect(text).not.toContain('�');
    expect(/^€+$/.test(text)).toBe(true);
  });

  it('a value that cannot be written as JSON is kept as nothing, so the token renders empty', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(capStepOutput(loop)).toEqual({ value: undefined, truncated: false });
    expect(capStepOutput({ n: 10n })).toEqual({ value: undefined, truncated: false });
  });

  it('keeps over-size JSON as its cut text', () => {
    const r = capStepOutput({ blob: 'x'.repeat(STEP_OUTPUT_MAX_BYTES) });
    expect(r.truncated).toBe(true);
    expect(typeof r.value).toBe('string');
    expect(Buffer.byteLength(r.value as string, 'utf8')).toBe(STEP_OUTPUT_MAX_BYTES);
  });
});

describe('action.runScript — store for this run', () => {
  it('stores JSON output under the given name', async () => {
    const { deps } = recorder({ success: true, stdout: '{"joke":"knock"}', returnValue: { joke: 'knock' } });
    const c = ctx();
    await executeAction(node('action.runScript', { scriptPath: 'joke.py', outputName: 'joke' }), c, deps);
    expect(c.stepOutputs!.get('joke')).toEqual({ ok: true, output: { joke: 'knock' } });
    expect(await interpolateAsync('{{ steps.joke.output.joke }}', c)).toBe('knock');
  });

  it('stores trimmed stdout when the script prints no JSON', async () => {
    const { deps } = recorder({ success: true, stdout: '  plain text\n' });
    const c = ctx();
    await executeAction(node('action.runScript', { scriptPath: 'joke.py', outputName: 'joke' }), c, deps);
    expect(c.stepOutputs!.get('joke')).toEqual({ ok: true, output: 'plain text' });
  });

  it('stores nothing without a name, and nothing under a malformed one', async () => {
    const { deps } = recorder({ success: true, stdout: 'x' });
    const c = ctx();
    await executeAction(node('action.runScript', { scriptPath: 'joke.py' }), c, deps);
    await executeAction(node('action.runScript', { scriptPath: 'joke.py', outputName: 'Bad Name' }), c, deps);
    expect(c.stepOutputs!.size).toBe(0);
  });

  it('a failed script records ok:false, then fails the step', async () => {
    const { deps } = recorder({ success: false, stdout: '', error: 'exit 2' });
    const c = ctx();
    await expect(executeAction(node('action.runScript', { scriptPath: 'joke.py', outputName: 'joke' }), c, deps))
      .rejects.toThrow(/failed: exit 2/);
    expect(c.stepOutputs!.get('joke')).toEqual({ ok: false });
    expect(await interpolateAsync('{{ steps.joke.ok }}[{{ steps.joke.output }}]', c)).toBe('false[]');
  });

  it('cuts output over 64 KiB and says so in the step detail, without the output', async () => {
    const big = `SECRET-${'z'.repeat(STEP_OUTPUT_MAX_BYTES)}`;
    const { deps } = recorder({ success: true, stdout: big });
    const c = ctx();
    const n = node('action.runScript', { scriptPath: 'joke.py', outputName: 'joke' });
    const value = await executeAction(n, c, deps);
    const kept = c.stepOutputs!.get('joke')!.output as string;
    expect(Buffer.byteLength(kept, 'utf8')).toBe(STEP_OUTPUT_MAX_BYTES);
    const detail = actionStepDetail(n, value);
    expect(detail).toEqual({ reason: 'output "joke" was cut to 64 KiB for this run' });
    expect(JSON.stringify(detail)).not.toContain('SECRET');
  });

  it('adds no step detail for an output under the cap', async () => {
    const { deps } = recorder({ success: true, stdout: 'SECRET' });
    const n = node('action.runScript', { scriptPath: 'joke.py', outputName: 'joke' });
    expect(actionStepDetail(n, await executeAction(n, ctx(), deps))).toBeUndefined();
  });

  it('may store to a variable and to the run at once', async () => {
    const writes: Array<{ name: string; value: unknown }> = [];
    const { deps } = recorder({ success: true, stdout: '{"n":1}', returnValue: { n: 1 } });
    const c = ctx({ setValue: async (name, value) => { writes.push({ name, value }); return { ok: true }; } });
    await executeAction(node('action.runScript', { scriptPath: 's.py', outputName: 'r', resultVariable: 'saved' }), c, deps);
    expect(writes).toEqual([{ name: 'saved', value: { n: 1 } }]);
    expect(c.stepOutputs!.get('r')).toEqual({ ok: true, output: { n: 1 } });
  });
});

describe('action.runScript — a refused variable write is reported (#5636)', () => {
  const refusals: Array<[string, string]> = [
    ['an unknown variable', 'unknown variable "gone"'],
    ['a read-only variable', 'variable "gone" is readonly'],
    ['a wrong-type variable', 'value not representable as integer'],
    ['a node-scoped variable with no node', 'missing scope context for "gone" (node)'],
  ];
  for (const [label, error] of refusals) {
    it(`fails the step for ${label}`, async () => {
      const { deps } = recorder({ success: true, stdout: 'out' });
      const c = ctx({ setValue: async () => ({ ok: false, error }) });
      await expect(executeAction(node('action.runScript', { scriptPath: 's.py', resultVariable: 'gone' }), c, deps))
        .rejects.toThrow(`script "s.py" ran, but its result was not stored in variable "gone": ${error}`);
    });
  }

  it('still keeps the run output when the variable write is refused', async () => {
    const { deps } = recorder({ success: true, stdout: 'out' });
    const c = ctx({ setValue: async () => ({ ok: false, error: 'unknown variable "gone"' }) });
    await expect(executeAction(node('action.runScript', { scriptPath: 's.py', resultVariable: 'gone', outputName: 'r' }), c, deps))
      .rejects.toThrow(/was not stored/);
    expect(c.stepOutputs!.get('r')).toEqual({ ok: true, output: 'out' });
  });

  it('an accepted write still succeeds', async () => {
    const { deps } = recorder({ success: true, stdout: 'out' });
    await expect(executeAction(node('action.runScript', { scriptPath: 's.py', resultVariable: 'ok' }), ctx(), deps))
      .resolves.toMatchObject({ success: true });
  });
});

describe('empty-send rule (#5636): only ever fewer sends', () => {
  const blanks = ['', '   ', '\n\t ', '{{ steps.missing.output }}', ' {{ var.unset }} ', '{{ trigger.nope }}\n'];

  describe('action.sendMessage', () => {
    it('channel message: a non-empty text sends once, exactly as before', async () => {
      const { sends, deps } = recorder();
      await executeAction(node('action.sendMessage', { text: 'hello' }), ctx(), deps);
      expect(sends()).toHaveLength(1);
      expect(sends()[0].args).toEqual({ sourceId: 'default', text: 'hello', channel: 2, destination: undefined, replyId: undefined });
    });

    for (const text of blanks) {
      it(`channel message: ${JSON.stringify(text)} sends nothing`, async () => {
        const { sends, deps } = recorder();
        const r = await executeAction(node('action.sendMessage', { text }), ctx(), deps);
        expect(sends()).toHaveLength(0);
        expect(r).toEqual({ skipped: true, emptySend: true, reason: 'the message text rendered empty, so nothing was sent' });
      });
    }

    it('a missing text param sends nothing', async () => {
      const { sends, deps } = recorder();
      await executeAction(node('action.sendMessage', {}), ctx(), deps);
      expect(sends()).toHaveLength(0);
    });

    it('DM: 1 send with text, 0 with a blank one', async () => {
      const full = recorder();
      await executeAction(node('action.sendMessage', { text: 'hi', to: 555 }), ctx(), full.deps);
      expect(full.sends()).toHaveLength(1);
      expect(full.sends()[0].args.destination).toBe(555);

      const blank = recorder();
      await executeAction(node('action.sendMessage', { text: '  ', to: 555 }), ctx(), blank.deps);
      expect(blank.sends()).toHaveLength(0);
    });

    it('multi-source × multi-channel: 4 sends with text, 0 with a blank one', async () => {
      const params = {
        sourceIds: ['s1', 's2'],
        channels: [{ name: 'gauntlet', protocol: '' }, { name: 'ops', protocol: '' }],
      };
      const channels = [{ id: 1, name: 'gauntlet', role: 2 }, { id: 3, name: 'ops', role: 2 }];
      const full = recorder();
      await executeAction(node('action.sendMessage', { ...params, text: 'hi' }), ctx({ channels }), full.deps);
      expect(full.sends()).toHaveLength(4);

      const blank = recorder();
      const r = await executeAction(node('action.sendMessage', { ...params, text: '{{ steps.missing.output }}' }), ctx({ channels }), blank.deps);
      expect(blank.sends()).toHaveLength(0);
      expect(r).toMatchObject({ skipped: true, emptySend: true });
    });

    it('a blank text with selected channels that do not exist is a skip, not an error', async () => {
      const { sends, deps } = recorder();
      const r = await executeAction(
        node('action.sendMessage', { text: ' ', channels: [{ name: 'nope', protocol: '' }] }),
        ctx({ channels: [] }), deps,
      );
      expect(sends()).toHaveLength(0);
      expect(r).toMatchObject({ skipped: true, emptySend: true });
    });

    it('MeshCore reply: an empty body is not sent as a bare "@[Name]: " mention', async () => {
      const fields = { from: 'ab'.repeat(32), protocol: 'meshcore', senderLabel: 'Bob', isDM: false, channel: 0 };
      const full = recorder();
      await executeAction(node('action.sendMessage', { text: 'pong', replyToTrigger: true }), ctx({ fields, protocol: 'meshcore' }), full.deps);
      expect(full.sends()).toHaveLength(1);
      expect(full.sends()[0].args.text).toBe('@[Bob]: pong');

      const blank = recorder();
      await executeAction(node('action.sendMessage', { text: '{{ steps.missing.output }}', replyToTrigger: true }), ctx({ fields, protocol: 'meshcore' }), blank.deps);
      expect(blank.sends()).toHaveLength(0);
    });

    it('text that is only a zero digit or the word false is real text and still sends', async () => {
      const { sends, deps } = recorder();
      const c = ctx({ outputs: stored({ n: { ok: false, output: 0 } }) });
      await executeAction(node('action.sendMessage', { text: '{{ steps.n.ok }}' }), c, deps);
      expect(sends().map((s) => s.args.text)).toEqual(['false']);
    });

    it('a TX-disabled source is still reported as TX_DISABLED, not as an empty send', async () => {
      const { deps } = recorder();
      deps.sendMessage = async () => { throw new TxDisabledError(); };
      expect(await executeAction(node('action.sendMessage', { text: 'hi' }), ctx(), deps)).toEqual({ skipped: true, reason: 'TX_DISABLED' });
    });
  });

  describe('action.tapback', () => {
    it('1 send with an emoji (and the default), 0 with a blank one', async () => {
      const full = recorder();
      await executeAction(node('action.tapback', { emoji: '👍' }), ctx(), full.deps);
      await executeAction(node('action.tapback', {}), ctx(), full.deps);
      expect(full.sends().map((s) => s.args.emoji)).toEqual(['👍', '👍']);

      const blank = recorder();
      const r1 = await executeAction(node('action.tapback', { emoji: '' }), ctx(), blank.deps);
      const r2 = await executeAction(node('action.tapback', { emoji: '   ' }), ctx(), blank.deps);
      expect(blank.sends()).toHaveLength(0);
      expect(r1).toEqual({ skipped: true, emptySend: true, reason: 'the tapback emoji is blank, so nothing was sent' });
      expect(r2).toMatchObject({ emptySend: true });
    });
  });

  describe('action.notify', () => {
    it('a body, or a title on its own, still dispatches', async () => {
      const { sends, deps } = recorder();
      await executeAction(node('action.notify', { title: 'T', body: 'B' }), ctx(), deps);
      await executeAction(node('action.notify', { title: 'T', body: '' }), ctx(), deps);
      await executeAction(node('action.notify', { body: '' }), ctx(), deps); // default title
      await executeAction(node('action.notify', { title: ' ', body: 'B' }), ctx(), deps);
      expect(sends()).toHaveLength(4);
    });

    it('a blank title AND a blank body dispatches nothing', async () => {
      const { sends, deps } = recorder();
      const r = await executeAction(
        node('action.notify', { title: '{{ steps.missing.output }}', body: ' {{ var.unset }} ' }), ctx(), deps,
      );
      expect(sends()).toHaveLength(0);
      expect(r).toEqual({ skipped: true, emptySend: true, reason: 'the notification title and body both rendered empty, so nothing was sent' });
    });
  });

  it('the run-log detail for a held send is the reason, and nothing else', () => {
    const n = node('action.sendMessage', { text: '' });
    expect(actionStepDetail(n, { skipped: true, emptySend: true, reason: 'why' })).toEqual({ skipped: true, reason: 'why' });
    // Other skips keep their old (absent) detail.
    expect(actionStepDetail(n, { skipped: true, reason: 'TX_DISABLED' })).toBeUndefined();
  });

  it('the worked example: script output reaches the message; an empty script sends nothing', async () => {
    const script = node('action.runScript', { scriptPath: 'joke.py', outputName: 'joke' }, 'a0');
    const send = node('action.sendMessage', { text: '{{ steps.joke.output }}' }, 'a1');

    const full = recorder({ success: true, stdout: 'A mesh walks into a bar.\n' });
    const c1 = ctx();
    await executeAction(script, c1, full.deps);
    await executeAction(send, c1, full.deps);
    expect(full.sends().map((s) => s.args.text)).toEqual(['A mesh walks into a bar.']);

    const empty = recorder({ success: true, stdout: '\n' });
    const c2 = ctx();
    await executeAction(script, c2, empty.deps);
    expect(await executeAction(send, c2, empty.deps)).toMatchObject({ skipped: true, emptySend: true });
    expect(empty.sends()).toHaveLength(0);
  });
});
