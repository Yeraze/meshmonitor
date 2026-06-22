import { describe, it, expect } from 'vitest';
import { executeAction, type ActionDeps } from './actionExecutor.js';
import type { EngineEvalContext } from './engineContext.js';
import type { TriggerContext } from './triggerContext.js';
import type { AutomationNode } from '../../../types/automation.js';
import type { VariableResolver } from './variableResolver.js';

function recorder() {
  const calls: Array<{ fn: string; args: any }> = [];
  const deps: ActionDeps = {
    sendMessage: async (a) => { calls.push({ fn: 'sendMessage', args: a }); return 1; },
    sendTapback: async (a) => { calls.push({ fn: 'sendTapback', args: a }); return 2; },
    manageNode: async (a) => { calls.push({ fn: 'manageNode', args: a }); return 3; },
    notify: async (a) => { calls.push({ fn: 'notify', args: a }); return 4; },
  };
  return { calls, deps };
}

/** Context with a fake var resolver (var.* → a small fixed map). */
function ctx(fields: Record<string, unknown>, sourceId: string | null = 'default'): EngineEvalContext {
  const trigger: TriggerContext = {
    triggerType: 'trigger.message',
    sourceId,
    subjectNodeNum: Number(fields.from ?? 111),
    timestamp: 1000,
    fields,
  };
  const vars = {
    getValue: async (name: string) => (name === 'greeting' ? 'hi there' : null),
  } as unknown as VariableResolver;
  return { trigger, vars, varCtx: { sourceId, nodeNum: trigger.subjectNodeNum }, now: 1000 };
}

const node = (type: string, params: Record<string, unknown>): AutomationNode => ({ id: 'a', type: type as any, params });

describe('executeAction', () => {
  it('sendMessage: interpolates text and broadcasts on the trigger channel', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hello {{ trigger.fromId }} / {{ var.greeting }}' }),
      ctx({ from: 5, fromId: '!05', channel: 2, isDM: false }),
      deps,
    );
    expect(calls[0]).toEqual({
      fn: 'sendMessage',
      args: { sourceId: 'default', text: 'hello !05 / hi there', channel: 2, destination: undefined, replyId: undefined },
    });
  });

  it('sendMessage: DM to an explicit node with reply-to-trigger', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'pong', to: '{{ trigger.from }}', replyToTrigger: true, channel: 0 }),
      ctx({ from: 777, channel: 0, packetId: 42, isDM: true }),
      deps,
    );
    expect(calls[0].args).toMatchObject({ destination: 777, replyId: 42, channel: 0 });
  });

  it('tapback: defaults replyId to the trigger packet and routes DM→DM', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.tapback', { emoji: '👍' }),
      ctx({ from: 5, channel: 3, packetId: 99, isDM: true }),
      deps,
    );
    expect(calls[0]).toEqual({
      fn: 'sendTapback',
      args: { sourceId: 'default', emoji: '👍', channel: undefined, destination: 5, replyId: 99 },
    });
  });

  it('tapback: channel message routes back to the channel', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.tapback', { emoji: '✅' }),
      ctx({ from: 5, channel: 3, packetId: 99, isDM: false }),
      deps,
    );
    expect(calls[0].args).toMatchObject({ channel: 3, destination: undefined, replyId: 99 });
  });

  it('nodeManage: defaults to the subject node and validates op', async () => {
    const { calls, deps } = recorder();
    await executeAction(node('action.nodeManage', { op: 'favorite' }), ctx({ from: 222 }), deps);
    expect(calls[0]).toEqual({ fn: 'manageNode', args: { sourceId: 'default', nodeNum: 222, op: 'favorite' } });

    await expect(executeAction(node('action.nodeManage', { op: 'explode' }), ctx({ from: 1 }), deps)).rejects.toThrow(/invalid op/);
  });

  it('notify: interpolates title/body and passes type', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.notify', { title: 'Node {{ trigger.from }}', body: 'said {{ trigger.text }}', type: 'warning' }),
      ctx({ from: 9, text: 'mayday' }),
      deps,
    );
    expect(calls[0]).toEqual({
      fn: 'notify',
      args: { sourceId: 'default', title: 'Node 9', body: 'said mayday', type: 'warning' },
    });
  });

  it('honors an explicit target source override', async () => {
    const { calls, deps } = recorder();
    await executeAction(node('action.notify', { body: 'x', sourceId: 'srcB' }), ctx({}, 'default'), deps);
    expect(calls[0].args.sourceId).toBe('srcB');
  });

  it('throws on an unknown action type', async () => {
    const { deps } = recorder();
    await expect(executeAction(node('action.bogus', {}), ctx({}), deps)).rejects.toThrow(/unknown action/);
  });
});
