import { describe, it, expect } from 'vitest';
import { executeAction, triggerEnv, type ActionDeps } from './actionExecutor.js';
import type { EngineEvalContext } from './engineContext.js';
import type { TriggerContext } from './triggerContext.js';
import type { AutomationNode } from '../../../types/automation.js';
import type { VariableResolver } from './variableResolver.js';
import { TxDisabledError } from '../../errors/txDisabledError.js';

function recorder() {
  const calls: Array<{ fn: string; args: any }> = [];
  const deps: ActionDeps = {
    sendMessage: async (a) => { calls.push({ fn: 'sendMessage', args: a }); return 1; },
    sendTapback: async (a) => { calls.push({ fn: 'sendTapback', args: a }); return 2; },
    manageNode: async (a) => { calls.push({ fn: 'manageNode', args: a }); return 3; },
    requestData: async (a) => { calls.push({ fn: 'requestData', args: a }); return 5; },
    rebootDevice: async (a) => { calls.push({ fn: 'rebootDevice', args: a }); return 6; },
    notify: async (a) => { calls.push({ fn: 'notify', args: a }); return 4; },
    runScript: async (a) => { calls.push({ fn: 'runScript', args: a }); return { success: true, stdout: '', returnValue: { ok: 1 } }; },
  };
  return { calls, deps };
}

/**
 * Like `recorder()`, but the named dep function throws `TxDisabledError`
 * instead of recording a call — simulates a mesh-send action hitting a
 * TX-disabled Meshtastic source's primitive guard (#4294 WP1/WP3). Other dep
 * functions still record normally, so mixed-source scenarios can be composed.
 */
function recorderWithTxDisabled(failFn: keyof ActionDeps) {
  const { calls, deps } = recorder();
  (deps as any)[failFn] = async () => {
    throw new TxDisabledError();
  };
  return { calls, deps };
}

/**
 * Like `recorderWithTxDisabled`, but only the given source's call throws —
 * other sources still record normally. Used for mixed-source multi-select
 * scenarios (mirrors the MeshCore mixed-source tests above).
 */
function recorderWithTxDisabledForSource(failFn: 'sendMessage' | 'sendTapback' | 'requestData' | 'rebootDevice', targetSourceId: string) {
  const { calls, deps } = recorder();
  const original = deps[failFn] as (a: any) => Promise<unknown>;
  (deps as any)[failFn] = async (a: any) => {
    if (a.sourceId === targetSourceId) throw new TxDisabledError();
    return original(a);
  };
  return { calls, deps };
}

/** Context with a fake var resolver (var.* → a small fixed map). */
function ctx(fields: Record<string, unknown>, sourceId: string | null = 'default', protocol?: string): EngineEvalContext {
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
  // Only expose getSourceProtocol when a protocol is given, so legacy tests keep
  // the original (no-protocol-info) data shape.
  const data = protocol
    ? { getNode: async () => null, getTelemetry: async () => null, getSourceProtocol: async () => protocol }
    : { getNode: async () => null, getTelemetry: async () => null };
  return { trigger, vars, data, varCtx: { sourceId, nodeNum: trigger.subjectNodeNum }, now: 1000 };
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

  // ── MeshCore DM destination resolution (#4018) ──────────────────────────────
  it('sendMessage: DM to a MeshCore pubkey resolves destination as a string, not NaN', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'pong', to: '{{ trigger.from }}' }),
      ctx({ from: '3745442c10a1', channel: undefined, isDM: true, protocol: 'meshcore' }, 'mc', 'meshcore'),
      deps,
    );
    // Must NOT fall back to a channel broadcast (the pre-fix bug): a real
    // destination is set, so the send is a DM, not `channel: 0`.
    expect(calls[0].args).toMatchObject({ destination: '3745442c10a1', sourceId: 'mc' });
  });

  it('sendMessage: a Meshtastic DM target still resolves as a number on a MeshCore-aware context', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'pong', to: '{{ trigger.from }}' }),
      ctx({ from: 777, isDM: true }, 'mt', 'meshtastic'),
      deps,
    );
    expect(calls[0].args).toMatchObject({ destination: 777, sourceId: 'mt' });
  });

  // ── replyToTrigger auto-mention for MeshCore (#3973 / #3978) ────────────────
  it('sendMessage: replyToTrigger prepends @[senderLabel] for a MeshCore channel trigger', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'see https://example.com', replyToTrigger: true }),
      // MeshCore channel message: senderLabel = the parsed sender name. No packetId.
      ctx({ from: 'channel-13', fromId: 'channel-13', fromName: 'Alice', senderLabel: 'Alice', channel: 13, isChannel: true, isBroadcast: true, protocol: 'meshcore' }),
      deps,
    );
    expect(calls[0].args.text).toBe('@[Alice]: see https://example.com');
    // No packetId → no Meshtastic tapback replyId.
    expect(calls[0].args.replyId).toBeUndefined();
  });

  it('sendMessage: replyToTrigger prepends @[senderLabel] for a MeshCore DM trigger', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'got it', replyToTrigger: true }),
      // MeshCore DM: fromName populated from the resolved contact (#3973) → senderLabel.
      ctx({ from: 'abc123', fromId: 'abc123', fromName: 'Bob', senderLabel: 'Bob', isDM: true, protocol: 'meshcore' }),
      deps,
    );
    expect(calls[0].args.text).toBe('@[Bob]: got it');
  });

  it('sendMessage: replyToTrigger falls back to channelName via senderLabel when no sender name', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      // No name prefix on the channel post, but senderLabel degrades to the channel name (#3978).
      node('action.sendMessage', { text: 'anonymous reply', replyToTrigger: true }),
      ctx({ from: 'channel-4', fromId: 'channel-4', channelName: 'gauntlet', senderLabel: 'gauntlet', channel: 4, isChannel: true, isBroadcast: true, protocol: 'meshcore' }),
      deps,
    );
    expect(calls[0].args.text).toBe('@[gauntlet]: anonymous reply');
  });

  it('sendMessage: replyToTrigger does not double-prepend when the text already starts with a mention', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      // User hand-wrote the mention (the pre-fix workaround) — must not be doubled.
      node('action.sendMessage', { text: '@[{{ trigger.senderLabel }}] hi', replyToTrigger: true }),
      ctx({ from: 'channel-9', fromName: 'Carol', senderLabel: 'Carol', channel: 9, isChannel: true, isBroadcast: true, protocol: 'meshcore' }),
      deps,
    );
    expect(calls[0].args.text).toBe('@[Carol] hi');
  });

  it('sendMessage: replyToTrigger does not prepend when senderLabel is entirely missing', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'anonymous reply', replyToTrigger: true }),
      // No name, no channel name, no usable id → senderLabel undefined → nothing to mention.
      ctx({ from: 'channel-4', channel: 4, isChannel: true, isBroadcast: true, protocol: 'meshcore' }),
      deps,
    );
    expect(calls[0].args.text).toBe('anonymous reply');
  });

  it('sendMessage: replyToTrigger leaves a Meshtastic reply unchanged (packetId tapback, no @[ ] mention)', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'pong', to: '{{ trigger.from }}', replyToTrigger: true, channel: 0 }),
      // Meshtastic message trigger: protocol meshtastic + packetId → tapback, no mention,
      // even though senderLabel is now populated (a nodeNum/id) universally.
      ctx({ from: 777, fromId: '!00000309', fromName: '!00000309', senderLabel: '!00000309', channel: 0, packetId: 42, isDM: true, protocol: 'meshtastic' }),
      deps,
    );
    expect(calls[0].args.text).toBe('pong');
    expect(calls[0].args.replyId).toBe(42);
  });

  // ── MeshCore scope/region (#3833) ──────────────────────────────────────────
  it('sendMessage: inherit scope omits scopeOverride (default call shape unchanged)', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', channel: 1 }),
      ctx({ from: 5, channel: 1, isDM: false }),
      deps,
    );
    expect('scopeOverride' in calls[0].args).toBe(false);
  });

  it('sendMessage: unscoped scope passes empty-string override', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', channel: 1, scopeMode: 'unscoped' }),
      ctx({ from: 5, channel: 1, isDM: false }),
      deps,
    );
    expect(calls[0].args.scopeOverride).toBe('');
  });

  it('sendMessage: named scope passes the interpolated region name', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', channel: 1, scopeMode: 'named', scopeName: ' paris ' }),
      ctx({ from: 5, channel: 1, isDM: false }),
      deps,
    );
    expect(calls[0].args.scopeOverride).toBe('paris');
  });

  it('sendMessage: empty named scope falls back to inherit (no override)', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', channel: 1, scopeMode: 'named', scopeName: '   ' }),
      ctx({ from: 5, channel: 1, isDM: false }),
      deps,
    );
    expect('scopeOverride' in calls[0].args).toBe(false);
  });

  it('sendMessage: trigger scope uses the triggering message scopeName', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', channel: 1, scopeMode: 'trigger' }),
      ctx({ from: 5, channel: 1, isDM: false, scopeName: 'lyon', scopeCode: 123 }),
      deps,
    );
    expect(calls[0].args.scopeOverride).toBe('lyon');
  });

  it('sendMessage: trigger scope on an explicitly-unscoped trigger sends unscoped', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', channel: 1, scopeMode: 'trigger' }),
      ctx({ from: 5, channel: 1, isDM: false, scopeName: undefined, scopeCode: 0 }),
      deps,
    );
    expect(calls[0].args.scopeOverride).toBe('');
  });

  it('sendMessage: trigger scope on a Meshtastic trigger (no scope) inherits', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', channel: 1, scopeMode: 'trigger' }),
      ctx({ from: 5, channel: 1, isDM: false }),
      deps,
    );
    expect('scopeOverride' in calls[0].args).toBe(false);
  });

  it('sendMessage: trigger scope on a MeshCore trigger whose scope could not be resolved sends unscoped (#3887)', async () => {
    // scopeCode/scopeName both null (not absent): a real MeshCore message
    // trigger where raw-packet scope resolution failed (LogRxData correlation
    // miss) — must be treated as unscoped, not silently fall back to inherit.
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', channel: 1, scopeMode: 'trigger' }),
      ctx({ from: 5, channel: 1, isDM: false, scopeName: null, scopeCode: null }),
      deps,
    );
    expect(calls[0].args.scopeOverride).toBe('');
  });

  it('sendMessage: trigger scope on a known-but-unmapped scope code sends unscoped (#3998)', async () => {
    // scopeCode > 0 but no resolved region name: the trigger WAS scoped, but to a
    // region we can't name (e.g. a flood re-scoped by a repeater whose region isn't
    // in our known set). We can't reproduce an unnameable scope (the transport code
    // is an HMAC keyed by the region name), so "match the trigger scope" must degrade
    // to unscoped — NOT the node's unrelated default scope (was: inherit, #3887).
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', channel: 1, scopeMode: 'trigger' }),
      ctx({ from: 5, channel: 1, isDM: false, scopeName: null, scopeCode: 456 }),
      deps,
    );
    expect(calls[0].args.scopeOverride).toBe('');
  });

  it('sendMessage: DM send never carries a scope override', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', to: '{{ trigger.from }}', channel: 0, scopeMode: 'unscoped' }),
      ctx({ from: 777, channel: 0, isDM: true }),
      deps,
    );
    expect('scopeOverride' in calls[0].args).toBe(false);
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
    // #3996: with no explicit sourceIds the reaction fires exactly once — from
    // the triggering source only — never fanned out to every connected source.
    expect(calls).toHaveLength(1);
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

  it('tapback: skips as a recorded no-op on a MeshCore source (#3833 follow-up)', async () => {
    const { calls, deps } = recorder();
    const result = await executeAction(
      node('action.tapback', { emoji: '👍' }),
      ctx({ from: 5, channel: 3, packetId: 99, isDM: false }, 'mc', 'meshcore'),
      deps,
    );
    expect(result).toMatchObject({ skipped: true });
    expect(calls).toHaveLength(0); // deps never invoked
  });

  // ── source selection (#3996) ────────────────────────────────────────────
  it('tapback: explicit sourceIds fans out to each selected source', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.tapback', { emoji: '👍', sourceIds: ['radioA', 'radioB'] }),
      ctx({ from: 5, channel: 3, packetId: 99, isDM: false }),
      deps,
    );
    expect(calls.map((c) => c.args.sourceId)).toEqual(['radioA', 'radioB']);
    expect(calls[0].args).toMatchObject({ emoji: '👍', channel: 3, destination: undefined, replyId: 99 });
  });

  it('tapback: a MeshCore source within an explicit selection is skipped, Meshtastic sources still fire', async () => {
    const { calls, deps } = recorder();
    const data = {
      getNode: async () => null,
      getTelemetry: async () => null,
      getSourceProtocol: async (sid: string) => (sid === 'mc' ? 'meshcore' : 'meshtastic'),
    };
    const c = { ...ctx({ from: 5, channel: 3, packetId: 99, isDM: false }), data };
    const results = await executeAction(
      node('action.tapback', { emoji: '👍', sourceIds: ['radioA', 'mc'] }),
      c,
      deps,
    );
    expect(calls.map((c2) => c2.args.sourceId)).toEqual(['radioA']);
    expect(results).toEqual([2, { skipped: true, reason: 'tapback is not supported on MeshCore' }]);
  });

  it('tapback: a single-entry explicit sourceIds still unwraps to a scalar result, not a one-element array', async () => {
    const { deps } = recorder();
    const result = await executeAction(
      node('action.tapback', { emoji: '👍', sourceIds: ['radioA'] }),
      ctx({ from: 5, channel: 3, packetId: 99, isDM: false }),
      deps,
    );
    expect(result).toBe(2);
    expect(Array.isArray(result)).toBe(false);
  });

  it('nodeManage: defaults to the subject node and validates op', async () => {
    const { calls, deps } = recorder();
    await executeAction(node('action.nodeManage', { op: 'favorite' }), ctx({ from: 222 }), deps);
    expect(calls[0]).toEqual({ fn: 'manageNode', args: { sourceId: 'default', nodeNum: 222, op: 'favorite' } });

    await expect(executeAction(node('action.nodeManage', { op: 'explode' }), ctx({ from: 1 }), deps)).rejects.toThrow(/invalid op/);
  });

  it('nodeManage: skips favorite/ignore on MeshCore but still allows delete (#3833 follow-up)', async () => {
    const { calls, deps } = recorder();
    // favorite is a Meshtastic-admin op → skipped no-op on MeshCore.
    const fav = await executeAction(node('action.nodeManage', { op: 'favorite' }), ctx({ from: 7 }, 'mc', 'meshcore'), deps);
    expect(fav).toMatchObject({ skipped: true });
    expect(calls).toHaveLength(0);

    // delete is DB-level → runs on any source, MeshCore included.
    await executeAction(node('action.nodeManage', { op: 'delete' }), ctx({ from: 7 }, 'mc', 'meshcore'), deps);
    expect(calls).toEqual([{ fn: 'manageNode', args: { sourceId: 'mc', nodeNum: 7, op: 'delete' } }]);
  });

  // ── deviceReboot (#3995) ───────────────────────────────────────────────────
  it('deviceReboot: reboots the trigger source and passes the seconds delay', async () => {
    const { calls, deps } = recorder();
    const result = await executeAction(
      node('action.deviceReboot', { seconds: 30 }),
      ctx({ from: 1 }, 'default'),
      deps,
    );
    expect(calls).toEqual([{ fn: 'rebootDevice', args: { sourceId: 'default', seconds: 30 } }]);
    expect(result).toBe(6);
  });

  it('deviceReboot: a scheduled (source-less) trigger reboots the selected source(s)', async () => {
    const { calls, deps } = recorder();
    // A schedule trigger carries no sourceId; the action must reboot the
    // source(s) the user selected in the builder (multi-select), NOT the null
    // trigger source. This is the core #3995 use case (daily scheduled reboot).
    const scheduleCtx: EngineEvalContext = {
      trigger: { triggerType: 'trigger.schedule', sourceId: null, timestamp: 1000, fields: {} },
      vars: { getValue: async () => null } as unknown as VariableResolver,
      data: { getNode: async () => null, getTelemetry: async () => null },
      varCtx: { sourceId: null, nodeNum: undefined },
      now: 1000,
    };
    await executeAction(
      node('action.deviceReboot', { sourceIds: ['radioA', 'radioB'] }),
      scheduleCtx,
      deps,
    );
    expect(calls).toEqual([
      { fn: 'rebootDevice', args: { sourceId: 'radioA', seconds: undefined } },
      { fn: 'rebootDevice', args: { sourceId: 'radioB', seconds: undefined } },
    ]);
  });

  it('deviceReboot: ignores a non-numeric/negative seconds (falls back to manager default)', async () => {
    const { calls, deps } = recorder();
    await executeAction(node('action.deviceReboot', { seconds: -5 }), ctx({ from: 1 }, 'default'), deps);
    await executeAction(node('action.deviceReboot', { seconds: 'soon' }), ctx({ from: 1 }, 'default'), deps);
    expect(calls[0].args).toEqual({ sourceId: 'default', seconds: undefined });
    expect(calls[1].args).toEqual({ sourceId: 'default', seconds: undefined });
  });

  it('deviceReboot: forwards a remote targetNodeNum to rebootDevice (#4126)', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.deviceReboot', { seconds: 15, targetNodeNum: 123456789 }),
      ctx({ from: 1 }, 'default'),
      deps,
    );
    expect(calls).toEqual([
      { fn: 'rebootDevice', args: { sourceId: 'default', seconds: 15, targetNodeNum: 123456789 } },
    ]);
  });

  it('deviceReboot: no targetNodeNum ⇒ local-only reboot (targetNodeNum undefined)', async () => {
    const { calls, deps } = recorder();
    await executeAction(node('action.deviceReboot', { seconds: 20 }), ctx({ from: 1 }, 'default'), deps);
    expect(calls[0].args.targetNodeNum).toBeUndefined();
    expect(calls[0].args).toMatchObject({ sourceId: 'default', seconds: 20 });
  });

  it('deviceReboot: ignores a blank/invalid targetNodeNum (falls back to local)', async () => {
    const { calls, deps } = recorder();
    await executeAction(node('action.deviceReboot', { targetNodeNum: '' }), ctx({ from: 1 }, 'default'), deps);
    await executeAction(node('action.deviceReboot', { targetNodeNum: 0 }), ctx({ from: 1 }, 'default'), deps);
    await executeAction(node('action.deviceReboot', { targetNodeNum: 'nope' }), ctx({ from: 1 }, 'default'), deps);
    expect(calls[0].args.targetNodeNum).toBeUndefined();
    expect(calls[1].args.targetNodeNum).toBeUndefined();
    expect(calls[2].args.targetNodeNum).toBeUndefined();
  });

  it('deviceReboot: mixed-source select + targetNodeNum skips MeshCore sources instead of failing the action', async () => {
    const { calls, deps } = recorder();
    // A remote-admin target rides Meshtastic's session-passkey mechanism, which
    // MeshCore lacks. In a mixed multi-select the MeshCore source must be a
    // recorded no-op (like tapback/nodeManage) — NOT a hard failure that starves
    // the remaining Meshtastic sources of their reboot.
    const mixedCtx: EngineEvalContext = {
      trigger: { triggerType: 'trigger.schedule', sourceId: null, timestamp: 1000, fields: {} },
      vars: { getValue: async () => null } as unknown as VariableResolver,
      data: {
        getNode: async () => null,
        getTelemetry: async () => null,
        getSourceProtocol: async (sid: string) => (sid === 'mc' ? 'meshcore' : 'meshtastic'),
      },
      varCtx: { sourceId: null, nodeNum: undefined },
      now: 1000,
    };
    const result = await executeAction(
      node('action.deviceReboot', { sourceIds: ['radioA', 'mc'], targetNodeNum: 42 }),
      mixedCtx,
      deps,
    );
    // Only the Meshtastic source reached the deps; the MeshCore entry is a skip record.
    expect(calls).toEqual([
      { fn: 'rebootDevice', args: { sourceId: 'radioA', seconds: undefined, targetNodeNum: 42 } },
    ]);
    expect(result).toEqual([
      6, // recorder's rebootDevice return for the Meshtastic source
      { skipped: true, reason: 'remote-admin reboot is not supported on MeshCore' },
    ]);
  });

  // ── requestData (#3835) ────────────────────────────────────────────────────
  it('requestData: telemetry passes op/target/channel/telemetryType (the #3835 case)', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.requestData', { op: 'telemetry', telemetryType: 'environment', to: '12345', channel: 3 }),
      ctx({ from: 5, channel: 0 }),
      deps,
    );
    expect(calls[0]).toEqual({
      fn: 'requestData',
      args: { sourceId: 'default', op: 'telemetry', target: '12345', channel: 3, telemetryType: 'environment' },
    });
  });

  it('requestData: blank target falls back to the subject node, blank channel to trigger channel', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.requestData', { op: 'traceroute' }),
      ctx({ from: 777, channel: 4 }),
      deps,
    );
    expect(calls[0].args).toMatchObject({ op: 'traceroute', target: '777', channel: 4, telemetryType: undefined });
  });

  it('requestData: advert needs no target', async () => {
    const { calls, deps } = recorder();
    await executeAction(node('action.requestData', { op: 'advert', channel: 1 }), ctx({ from: 9 }), deps);
    expect(calls[0].args).toMatchObject({ op: 'advert', target: '', channel: 1 });
  });

  it('requestData: position/nodeinfo are skipped on MeshCore (no-op)', async () => {
    const { calls, deps } = recorder();
    const pos = await executeAction(node('action.requestData', { op: 'position', to: 'abc' }), ctx({ from: 1 }, 'mc', 'meshcore'), deps);
    expect(pos).toMatchObject({ skipped: true });
    const ni = await executeAction(node('action.requestData', { op: 'nodeinfo', to: 'abc' }), ctx({ from: 1 }, 'mc', 'meshcore'), deps);
    expect(ni).toMatchObject({ skipped: true });
    expect(calls).toHaveLength(0);
  });

  it('requestData: on MeshCore, blank target falls back to the trigger pubkey', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.requestData', { op: 'telemetry' }),
      ctx({ from: 'aabbccddeeff', channel: 0 }, 'mc', 'meshcore'),
      deps,
    );
    expect(calls[0].args).toMatchObject({ op: 'telemetry', target: 'aabbccddeeff' });
  });

  it('requestData: source-less (schedule) trigger fans out to the selected sources (#3835)', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.requestData', { op: 'telemetry', telemetryType: 'environment', to: '999', channel: 2, sourceIds: ['radioA', 'radioB'] }),
      ctx({}, null), // schedule-style: no trigger source
      deps,
    );
    expect(calls.map((c) => c.args.sourceId)).toEqual(['radioA', 'radioB']);
    expect(calls[0].args).toMatchObject({ op: 'telemetry', target: '999', channel: 2, telemetryType: 'environment' });
  });

  it('requestData: telemetryType is dropped for non-telemetry ops', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.requestData', { op: 'traceroute', telemetryType: 'environment', to: '5' }),
      ctx({ from: 5, channel: 0 }),
      deps,
    );
    expect(calls[0].args.telemetryType).toBeUndefined();
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
      args: { sourceId: 'default', title: 'Node 9', body: 'said mayday', type: 'warning', urls: [] },
    });
  });

  it('notify: parses urls list but does NOT interpolate mesh-controlled trigger.* (security)', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.notify', { body: 'hi', urls: 'discord://x\ntgram://{{ trigger.text }}, json://y' }),
      ctx({ from: 9, text: 'evil-token' }),
      deps,
    );
    // {{ trigger.text }} is stripped (varsOnly) — a mesh message can't inject a
    // notification target; "evil-token" must NOT appear anywhere in the urls.
    expect(calls[0].args.urls).toEqual(['discord://x', 'tgram://', 'json://y']);
    expect(JSON.stringify(calls[0].args.urls)).not.toContain('evil-token');
  });

  it('honors an explicit target source override', async () => {
    const { calls, deps } = recorder();
    await executeAction(node('action.notify', { body: 'x', sourceId: 'srcB' }), ctx({}, 'default'), deps);
    expect(calls[0].args.sourceId).toBe('srcB');
  });

  it('sendMessage: an explicit source routes a source-less (system/schedule) trigger', async () => {
    const { calls, deps } = recorder();
    // System triggers carry sourceId=null; the action's "Send via source" param
    // supplies the radio so the send has a target instead of failing.
    await executeAction(
      node('action.sendMessage', { text: 'up', sourceId: 'srcB', channel: 2 }),
      ctx({ event: 'bootup' }, null),
      deps,
    );
    expect(calls[0].args).toMatchObject({ sourceId: 'srcB', text: 'up', channel: 2 });
  });

  // Helper: a context whose data provider knows each source's channels + protocol.
  const ctxWithChannels = (
    channelsBySource: Record<string, Array<{ id: number; name: string; role?: number | null }>>,
    protoBySource: Record<string, string> = {},
  ) => {
    const base = ctx({ event: 'bootup' }, null);
    return { ...base, data: {
      ...base.data,
      getChannels: async (sid: string | null) => channelsBySource[sid ?? ''] ?? [],
      getSourceProtocol: async (sid: string | null) => protoBySource[sid ?? ''] ?? null,
    } };
  };

  it('sendMessage: source×channel matrix resolves each source local slot', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', sourceIds: ['A', 'B'], channels: [{ name: 'gauntlet', protocol: 'meshtastic' }] }),
      ctxWithChannels({
        A: [{ id: 2, name: 'gauntlet', role: 2 }],
        B: [{ id: 5, name: 'gauntlet', role: 2 }, { id: 0, name: 'Primary', role: 1 }],
      }, { A: 'meshtastic', B: 'meshtastic' }),
      deps,
    );
    expect(calls.map((c) => ({ s: c.args.sourceId, ch: c.args.channel }))).toEqual([
      { s: 'A', ch: 2 }, { s: 'B', ch: 5 },
    ]);
  });

  it('sendMessage: a Meshtastic channel is NOT sent to a MeshCore source (protocol-scoped)', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', sourceIds: ['MT', 'MC'], channels: [{ name: 'gauntlet', protocol: 'meshtastic' }] }),
      ctxWithChannels({
        MT: [{ id: 2, name: 'gauntlet', role: 2 }],
        MC: [{ id: 1, name: 'gauntlet', role: null }], // same name, but MeshCore → must be skipped
      }, { MT: 'meshtastic', MC: 'meshcore' }),
      deps,
    );
    expect(calls.map((c) => c.args.sourceId)).toEqual(['MT']);
  });

  it('sendMessage: skips a selected channel that is absent on a source', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'hi', sourceIds: ['A', 'B'], channels: [{ name: 'gauntlet', protocol: 'meshtastic' }] }),
      ctxWithChannels({
        A: [{ id: 2, name: 'gauntlet', role: 2 }],
        B: [{ id: 0, name: 'Primary', role: 1 }], // no gauntlet → skipped
      }, { A: 'meshtastic', B: 'meshtastic' }),
      deps,
    );
    expect(calls.map((c) => c.args.sourceId)).toEqual(['A']);
  });

  it('sendMessage: throws when no selected channel exists on any source', async () => {
    const { deps } = recorder();
    await expect(executeAction(
      node('action.sendMessage', { text: 'hi', sourceIds: ['A'], channels: [{ name: 'nope', protocol: 'meshtastic' }] }),
      ctxWithChannels({ A: [{ id: 0, name: 'Primary', role: 1 }] }, { A: 'meshtastic' }),
      deps,
    )).rejects.toThrow(/none of the selected channels/);
  });

  it('sendMessage: back-compat — legacy single sourceId + channel still sends once', async () => {
    const { calls, deps } = recorder();
    await executeAction(
      node('action.sendMessage', { text: 'legacy', sourceId: 'srcB', channel: 3 }),
      ctx({ from: 5 }, 'default'),
      deps,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ sourceId: 'srcB', channel: 3 });
  });

  it('nothing: is a no-op that calls no deps', async () => {
    const { calls, deps } = recorder();
    await expect(executeAction(node('action.nothing', {}), ctx({ from: 5 }), deps)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('throws on an unknown action type', async () => {
    const { deps } = recorder();
    await expect(executeAction(node('action.bogus', {}), ctx({}), deps)).rejects.toThrow(/unknown action/);
  });

  // ─── runScript ─────────────────────────────────────────────────────────────
  it('triggerEnv maps the trigger context to MM_* + message aliases', () => {
    const env = triggerEnv(ctx({ from: 5, text: 'hello', telemetryType: 'battery', changed: ['a', 'b'] }, 'src1'));
    expect(env.MM_TRIGGER_TYPE).toBe('trigger.message');
    expect(env.MM_SOURCE_ID).toBe('src1');
    expect(env.MM_TEXT).toBe('hello');
    expect(env.MM_TELEMETRY_TYPE).toBe('battery');     // camelCase → MM_SNAKE
    expect(env.MM_CHANGED).toBe('["a","b"]');           // arrays JSON-stringified
    expect(env.MESSAGE).toBe('hello');                   // message alias
    expect(env.FROM_NODE).toBe('5');
    expect('MM_NOTHERE' in env).toBe(false);             // absent field → no key
  });

  it('runScript: calls the dep with scriptPath + env, stores returnValue in the result variable', async () => {
    const { calls, deps } = recorder();
    const writes: Array<{ name: string; value: unknown }> = [];
    const c = ctx({ from: 5, text: 'hi' });
    (c.vars as any).setValue = async (name: string, value: unknown) => { writes.push({ name, value }); return { ok: true }; };
    await executeAction(node('action.runScript', { scriptPath: 'foo.sh', resultVariable: 'scriptOut', timeoutSeconds: 5 }), c, deps);
    const call = calls.find((x) => x.fn === 'runScript')!;
    expect(call.args.scriptPath).toBe('foo.sh');
    expect(call.args.timeoutMs).toBe(5000);
    expect(call.args.env.MM_TEXT).toBe('hi');
    expect(writes).toEqual([{ name: 'scriptOut', value: { ok: 1 } }]); // recorder returns returnValue {ok:1}
  });

  it('runScript: a failing script throws (recorded as action:error)', async () => {
    const { deps } = recorder();
    deps.runScript = async () => ({ success: false, stdout: '', error: 'boom' });
    await expect(executeAction(node('action.runScript', { scriptPath: 'bad.sh' }), ctx({}), deps))
      .rejects.toThrow(/script "bad\.sh" failed: boom/);
  });

  it('runScript: requires a scriptPath', async () => {
    const { deps } = recorder();
    await expect(executeAction(node('action.runScript', {}), ctx({}), deps)).rejects.toThrow(/no scriptPath/);
  });

  it('delay: waits the requested seconds via the injected sleep', async () => {
    const { deps } = recorder();
    const slept: number[] = [];
    const out = await executeAction(node('action.delay', { seconds: 5 }), ctx({}), { ...deps, sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([5000]);
    expect(out).toEqual({ delayedSeconds: 5 });
  });

  it('delay: zero / missing seconds never sleeps', async () => {
    const { deps } = recorder();
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    expect(await executeAction(node('action.delay', { seconds: 0 }), ctx({}), { ...deps, sleep })).toEqual({ delayedSeconds: 0 });
    expect(await executeAction(node('action.delay', {}), ctx({}), { ...deps, sleep })).toEqual({ delayedSeconds: 0 });
    expect(slept).toEqual([]);
  });

  it('delay: non-numeric / non-finite seconds is treated as 0 (never sleeps)', async () => {
    const { deps } = recorder();
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    expect(await executeAction(node('action.delay', { seconds: 'garbage' }), ctx({}), { ...deps, sleep })).toEqual({ delayedSeconds: 0 });
    expect(await executeAction(node('action.delay', { seconds: NaN }), ctx({}), { ...deps, sleep })).toEqual({ delayedSeconds: 0 });
    expect(await executeAction(node('action.delay', { seconds: {} }), ctx({}), { ...deps, sleep })).toEqual({ delayedSeconds: 0 });
    expect(slept).toEqual([]);
  });

  it('delay: clamps to the 300s cap and floors fractional seconds', async () => {
    const { deps } = recorder();
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    await executeAction(node('action.delay', { seconds: 9999 }), ctx({}), { ...deps, sleep });
    await executeAction(node('action.delay', { seconds: 2.9 }), ctx({}), { ...deps, sleep });
    expect(slept).toEqual([300_000, 2_000]);
  });

  // ── TX-disabled skip (#4294 epic, Phase 1 WP3, §8) ────────────────────────
  // A TX-disabled Meshtastic source's primitive guard throws TxDisabledError
  // (WP1). The action executor must catch it and record a skip — mirroring the
  // MeshCore-unsupported skips above — so the automation run stays
  // status:'completed' instead of failing.
  describe('TX-disabled skip (#4294 WP3)', () => {
    it('sendMessage: a TX-disabled source is recorded as a TX_DISABLED skip, not a thrown error', async () => {
      const { calls, deps } = recorderWithTxDisabled('sendMessage');
      const result = await executeAction(
        node('action.sendMessage', { text: 'hello' }),
        ctx({ from: 5, channel: 2, isDM: false }),
        deps,
      );
      expect(result).toEqual({ skipped: true, reason: 'TX_DISABLED' });
      expect(calls).toHaveLength(0);
    });

    it('sendTapback: a TX-disabled source is recorded as a TX_DISABLED skip', async () => {
      const { calls, deps } = recorderWithTxDisabled('sendTapback');
      const result = await executeAction(
        node('action.tapback', { emoji: '👍' }),
        ctx({ from: 5, channel: 3, packetId: 99, isDM: false }),
        deps,
      );
      expect(result).toEqual({ skipped: true, reason: 'TX_DISABLED' });
      expect(calls).toHaveLength(0);
    });

    it('requestData: a TX-disabled source is recorded as a TX_DISABLED skip', async () => {
      const { calls, deps } = recorderWithTxDisabled('requestData');
      const result = await executeAction(
        node('action.requestData', { op: 'traceroute', to: '12345', channel: 1 }),
        ctx({ from: 5, channel: 0 }),
        deps,
      );
      expect(result).toEqual({ skipped: true, reason: 'TX_DISABLED' });
      expect(calls).toHaveLength(0);
    });

    it('deviceReboot: a TX-disabled remote-admin target is recorded as a TX_DISABLED skip', async () => {
      const { calls, deps } = recorderWithTxDisabled('rebootDevice');
      const result = await executeAction(
        node('action.deviceReboot', { targetNodeNum: 42 }),
        ctx({ from: 1 }, 'default'),
        deps,
      );
      expect(result).toEqual({ skipped: true, reason: 'TX_DISABLED' });
      expect(calls).toHaveLength(0);
    });

    it('sendMessage: a mixed multi-source select skips the TX-disabled source but still sends on the others', async () => {
      const { calls, deps } = recorderWithTxDisabledForSource('sendMessage', 'radioOff');
      const result = await executeAction(
        node('action.sendMessage', { text: 'hi', sourceIds: ['radioA', 'radioOff'] }),
        ctx({ from: 5, channel: 2, isDM: false }),
        deps,
      );
      expect(calls.map((c) => c.args.sourceId)).toEqual(['radioA']);
      expect(result).toEqual([1, { skipped: true, reason: 'TX_DISABLED' }]);
    });

    it('a non-TX error still rethrows unchanged (only TxDisabledError is converted to a skip)', async () => {
      const { deps } = recorder();
      (deps as any).sendMessage = async () => { throw new Error('boom'); };
      await expect(executeAction(
        node('action.sendMessage', { text: 'hi' }),
        ctx({ from: 5, channel: 2, isDM: false }),
        deps,
      )).rejects.toThrow('boom');
    });
  });
});
