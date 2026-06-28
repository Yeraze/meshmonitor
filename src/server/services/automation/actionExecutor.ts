/**
 * Action executor (#3653, §4/§5).
 *
 * Turns an `action.*` node + EngineEvalContext into a concrete IO call. All mesh
 * IO is behind the `ActionDeps` interface so the param interpolation and routing
 * logic (DM vs channel, target source/node resolution, tapback replyId) is
 * unit-tested without a live node. The real deps wiring lives in meshActionDeps.ts.
 */
import type { AutomationNode } from '../../../types/automation.js';
import { type EngineEvalContext, interpolateAsync, resolveOperand } from './engineContext.js';

export type NodeManageOp = 'favorite' | 'unfavorite' | 'ignore' | 'unignore' | 'delete';

export interface ActionDeps {
  sendMessage(a: {
    sourceId: string | null;
    text: string;
    channel: number;
    destination?: number;
    replyId?: number;
    /** MeshCore scope/region override (#3833). undefined = inherit channel/default;
     *  '' = explicit unscoped; non-empty = that region. Ignored by Meshtastic. */
    scopeOverride?: string | null;
  }): Promise<unknown>;
  sendTapback(a: {
    sourceId: string | null;
    emoji: string;
    channel?: number;
    destination?: number;
    replyId?: number;
  }): Promise<unknown>;
  manageNode(a: { sourceId: string | null; nodeNum: number; op: NodeManageOp }): Promise<unknown>;
  notify(a: { sourceId: string | null; title: string; body: string; type?: string; urls?: string[] }): Promise<unknown>;
  /** Run a user script file (in $DATA_DIR/scripts) with the given env. Never throws — returns the outcome. */
  runScript(a: { scriptPath: string; env: Record<string, string>; timeoutMs?: number }):
    Promise<{ success: boolean; returnValue?: unknown; stdout: string; error?: string }>;
}

/**
 * Build the env a `runScript` action exposes to the script: a generic
 * MM_TRIGGER_TYPE / MM_SOURCE_ID / MM_NODE_NUM / MM_TIMESTAMP plus every trigger
 * field as MM_<UPPER_SNAKE> (objects/arrays JSON-stringified, nulls skipped), and
 * message-compatible aliases (MESSAGE/FROM_NODE/…) so existing scripts still work.
 * Does NOT include process.env — runScript merges that itself.
 */
export function triggerEnv(ctx: EngineEvalContext): Record<string, string> {
  const fields = ctx.trigger.fields ?? {};
  const enc = (v: unknown): string => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  const env: Record<string, string> = {
    MM_TRIGGER_TYPE: String(ctx.trigger.triggerType ?? ''),
    MM_SOURCE_ID: ctx.trigger.sourceId ?? '',
    MM_TIMESTAMP: String(ctx.trigger.timestamp ?? ''),
  };
  if (ctx.trigger.subjectNodeNum != null) env.MM_NODE_NUM = String(ctx.trigger.subjectNodeNum);
  const toEnvKey = (k: string) =>
    'MM_' + k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    env[toEnvKey(k)] = enc(v);
  }
  const alias = (key: string, v: unknown) => { if (v != null) env[key] = enc(v); };
  alias('MESSAGE', fields.text);
  alias('FROM_NODE', fields.from);
  alias('PACKET_ID', fields.packetId);
  alias('CHANNEL', fields.channel);
  alias('SNR', fields.snr);
  alias('RSSI', fields.rssi);
  return env;
}

/** Target source for an action: explicit param wins, else the trigger's source. */
function targetSource(node: AutomationNode, ctx: EngineEvalContext): string | null {
  const p = node.params ?? {};
  const s = (p as Record<string, unknown>).sourceId;
  return typeof s === 'string' && s.length > 0 ? s : ctx.trigger.sourceId;
}

async function num(ctx: EngineEvalContext, raw: unknown): Promise<number | undefined> {
  if (raw == null) return undefined;
  const v = await resolveOperand(ctx, raw);
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Execute an action node against the injected deps. Throws on unknown action
 * type or missing required data; the graph evaluator catches and records it.
 */
export async function executeAction(node: AutomationNode, ctx: EngineEvalContext, deps: ActionDeps): Promise<unknown> {
  const p = (node.params ?? {}) as Record<string, unknown>;
  const sourceId = targetSource(node, ctx);
  const triggerChannel = Number(ctx.trigger.fields.channel ?? 0) || 0;
  const isDM = ctx.trigger.fields.isDM === true;

  switch (node.type) {
    case 'action.nothing':
      return undefined; // no-op — used so a rule can contribute only its IF result to a FINALLY step

    case 'action.runScript': {
      const scriptPath = String(p.scriptPath ?? '');
      if (!scriptPath) throw new Error('action.runScript: no scriptPath');
      const timeoutMs = p.timeoutSeconds != null && Number.isFinite(Number(p.timeoutSeconds))
        ? Math.max(1, Number(p.timeoutSeconds)) * 1000 : undefined;
      const result = await deps.runScript({ scriptPath, env: triggerEnv(ctx), timeoutMs });
      if (!result.success) throw new Error(`script "${scriptPath}" failed: ${result.error ?? 'non-zero exit'}`);
      // Store the script's JSON result into a variable (usable later as
      // {{ var.NAME.a.b }}); fall back to trimmed stdout when there's no JSON.
      const resultVar = typeof p.resultVariable === 'string' ? p.resultVariable : '';
      if (resultVar) {
        const value = result.returnValue !== undefined ? result.returnValue : result.stdout.trim();
        await ctx.vars.setValue(resultVar, value, ctx.varCtx, ctx.now);
      }
      return { scriptPath, success: true, returnValue: result.returnValue };
    }

    case 'action.sendMessage': {
      const text = await interpolateAsync(String(p.text ?? ''), ctx);
      const destination = await num(ctx, p.to);
      const replyId = p.replyToTrigger ? (ctx.trigger.fields.packetId as number | undefined) : await num(ctx, p.replyId);
      const fallbackChannel = p.channel != null ? Number(p.channel) : triggerChannel;

      // MeshCore scope/region (#3833). Translate the selected mode into the
      // manager's `scopeOverride` contract: undefined = inherit (channel/default),
      // '' = explicit unscoped, non-empty = a named region. Meshtastic ignores it.
      // Only applied to channel/broadcast sends below — DMs keep inherit.
      let scopeOverride: string | null | undefined;
      switch (String(p.scopeMode ?? 'inherit')) {
        case 'unscoped':
          scopeOverride = '';
          break;
        case 'named': {
          const n = (await interpolateAsync(String(p.scopeName ?? ''), ctx)).trim();
          scopeOverride = n || undefined; // empty named → inherit
          break;
        }
        case 'trigger': {
          const tn = ctx.trigger.fields.scopeName;
          if (typeof tn === 'string' && tn.length > 0) scopeOverride = tn;
          else if (ctx.trigger.fields.scopeCode === 0) scopeOverride = ''; // trigger was explicitly unscoped
          else scopeOverride = undefined; // Meshtastic / unknown → inherit
          break;
        }
        default:
          scopeOverride = undefined; // inherit
      }
      // Only forward the key when set, so the default (inherit) call shape — and
      // thus the run-log resolvedParams and existing tests — is unchanged.
      const scopeArg = scopeOverride !== undefined ? { scopeOverride } : {};

      // Target sources: explicit multi-select, else the legacy single source /
      // the triggering source.
      const sourceIds = Array.isArray(p.sourceIds) && p.sourceIds.length > 0
        ? (p.sourceIds as unknown[]).map(String)
        : [sourceId];

      // Selected unified channels (protocol + name). When set, send to each
      // source on each selected channel it carries — but only channels of the
      // source's own protocol (MeshCore "gauntlet" ≠ Meshtastic "gauntlet").
      // A channel absent on a source is skipped (source×channel matrix).
      const channelSel = Array.isArray(p.channels)
        ? (p.channels as Array<Record<string, unknown>>).map((c) => ({ name: String(c?.name ?? ''), protocol: String(c?.protocol ?? '') }))
        : [];

      const results: unknown[] = [];
      for (const sid of sourceIds) {
        if (destination != null || channelSel.length === 0) {
          // DM, or no unified-channel selection → single send on the fallback channel.
          // DMs keep inherit scope (MeshCore DM-by-pubkey isn't reachable here anyway);
          // a channel-only fallback send still honors the scope override.
          const fallbackScope = destination != null ? {} : scopeArg;
          results.push(await deps.sendMessage({ sourceId: sid, text, channel: fallbackChannel, destination, replyId, ...fallbackScope }));
          continue;
        }
        const proto = (await ctx.data.getSourceProtocol?.(sid)) ?? null;
        const srcChannels = (await ctx.data.getChannels?.(sid)) ?? [];
        for (const sel of channelSel) {
          if (sel.protocol && proto && sel.protocol !== proto) continue; // wrong-protocol channel
          const match = srcChannels.find((c) => c.name.toLowerCase() === sel.name.toLowerCase() && c.role !== 0);
          if (!match) continue; // channel not present on this source
          results.push(await deps.sendMessage({ sourceId: sid, text, channel: match.id, destination, replyId, ...scopeArg }));
        }
      }

      if (channelSel.length > 0 && destination == null && results.length === 0) {
        throw new Error('action.sendMessage: none of the selected channels exist on the selected source(s)');
      }
      // Unwrap the single-send case so the result shape (and run-log
      // resolvedParams) matches the original one-target behavior.
      return results.length === 1 ? results[0] : results;
    }

    case 'action.tapback': {
      const emoji = String(p.emoji ?? '👍');
      // Default replyId is the triggering packet; route the way the trigger arrived.
      const replyId = p.replyId != null ? await num(ctx, p.replyId) : (ctx.trigger.fields.packetId as number | undefined);
      const destination = isDM ? (ctx.trigger.fields.from as number | undefined) : undefined;
      const channel = isDM ? undefined : triggerChannel;
      return deps.sendTapback({ sourceId, emoji, channel, destination, replyId });
    }

    case 'action.nodeManage': {
      const op = String(p.op ?? '') as NodeManageOp;
      const nodeNum = p.nodeNum != null ? await num(ctx, p.nodeNum) : (ctx.trigger.subjectNodeNum ?? undefined);
      if (nodeNum == null) throw new Error('action.nodeManage: no target node');
      if (!['favorite', 'unfavorite', 'ignore', 'unignore', 'delete'].includes(op)) {
        throw new Error(`action.nodeManage: invalid op "${op}"`);
      }
      return deps.manageNode({ sourceId, nodeNum, op });
    }

    case 'action.notify': {
      const title = await interpolateAsync(String(p.title ?? 'MeshMonitor automation'), ctx);
      const body = await interpolateAsync(String(p.body ?? ''), ctx);
      const type = typeof p.type === 'string' ? p.type : undefined;
      // `urls` is an optional newline/comma-separated list of Apprise service
      // URLs entered on the action. Interpolation is restricted to {{ var.* }} —
      // mesh-controlled {{ trigger.* }} must NOT be able to inject a target URL.
      const rawUrls = typeof p.urls === 'string' ? await interpolateAsync(p.urls, ctx, { varsOnly: true }) : '';
      const urls = rawUrls.split(/[\n,]/).map((u) => u.trim()).filter((u) => u.length > 0);
      return deps.notify({ sourceId, title, body, type, urls });
    }

    default:
      throw new Error(`unknown action type "${node.type}"`);
  }
}
