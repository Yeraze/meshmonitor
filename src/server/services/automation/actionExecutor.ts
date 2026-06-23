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
    case 'action.sendMessage': {
      const text = await interpolateAsync(String(p.text ?? ''), ctx);
      const destination = await num(ctx, p.to);
      const channel = p.channel != null ? Number(p.channel) : triggerChannel;
      const replyId = p.replyToTrigger ? (ctx.trigger.fields.packetId as number | undefined) : await num(ctx, p.replyId);
      return deps.sendMessage({ sourceId, text, channel, destination, replyId });
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
      // URLs entered on the action; interpolated so {{ var.* }} can supply them.
      const rawUrls = typeof p.urls === 'string' ? await interpolateAsync(p.urls, ctx) : '';
      const urls = rawUrls.split(/[\n,]/).map((u) => u.trim()).filter((u) => u.length > 0);
      return deps.notify({ sourceId, title, body, type, urls });
    }

    default:
      throw new Error(`unknown action type "${node.type}"`);
  }
}
