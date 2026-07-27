/**
 * Action executor (#3653, §4/§5).
 *
 * Turns an `action.*` node + EngineEvalContext into a concrete IO call. All mesh
 * IO is behind the `ActionDeps` interface so the param interpolation and routing
 * logic (DM vs channel, target source/node resolution, tapback replyId) is
 * unit-tested without a live node. The real deps wiring lives in meshActionDeps.ts.
 */
import { type AutomationNode, AUTOMATION_DELAY_MAX_SECONDS } from '../../../types/automation.js';
import { type EngineEvalContext, interpolateAsync, resolveOperand } from './engineContext.js';
import { isTxDisabledError } from '../../errors/txDisabledError.js';

export type NodeManageOp = 'favorite' | 'unfavorite' | 'ignore' | 'unignore' | 'delete';

/** Safe request/operation a `action.requestData` can ask a node/mesh to perform (#3835). */
export type NodeRequestOp = 'telemetry' | 'position' | 'traceroute' | 'nodeinfo' | 'neighbors' | 'advert';
export type TelemetryKind = 'device' | 'environment' | 'airQuality' | 'power';

export interface ActionDeps {
  sendMessage(a: {
    sourceId: string | null;
    text: string;
    channel: number;
    /** Meshtastic: a node number. MeshCore: a contact public-key string (#4018). */
    destination?: number | string;
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
  /** Ask a node/mesh for data or to announce (#3835). `target` is raw — a node # for
   *  Meshtastic, a public key for MeshCore; '' for `advert` (no target). */
  requestData(a: {
    sourceId: string | null;
    op: NodeRequestOp;
    target: string;
    channel: number;
    telemetryType?: TelemetryKind;
  }): Promise<unknown>;
  /** Reboot the physical device behind a source (#3995). `seconds` is the
   *  Meshtastic reboot delay; MeshCore ignores it. `targetNodeNum` (#4126) is an
   *  optional remote node to reboot over the mesh via the Meshtastic session-passkey
   *  admin mechanism — omitted = reboot the source's locally-connected node.
   *  Throws on an unreachable/unsupported source so the run-log records a failed step. */
  rebootDevice(a: { sourceId: string | null; seconds?: number; targetNodeNum?: number }): Promise<unknown>;
  notify(a: { sourceId: string | null; title: string; body: string; type?: string; urls?: string[] }): Promise<unknown>;
  /** Run a user script file (in $DATA_DIR/scripts) with the given env. Never throws — returns the outcome. */
  runScript(a: { scriptPath: string; env: Record<string, string>; timeoutMs?: number }):
    Promise<{ success: boolean; returnValue?: unknown; stdout: string; error?: string }>;
  /** Pause for `ms` (action.delay). Optional/injectable so tests don't wait in real time. */
  sleep?(ms: number): Promise<void>;
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

/** Like `num`, but resolves to a trimmed string — for MeshCore pubkey targets (#4018). */
async function str(ctx: EngineEvalContext, raw: unknown): Promise<string | undefined> {
  if (raw == null) return undefined;
  const v = await resolveOperand(ctx, raw);
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

/**
 * True when the action's target source speaks MeshCore. Best-effort: when the
 * data provider can't report a protocol (older callers / tests), returns false
 * so behavior is unchanged. Used to skip Meshtastic-only actions (tapback,
 * node favorite/ignore admin) on MeshCore sources as a recorded no-op instead
 * of letting the deps throw — now that MeshCore messages also trigger the
 * engine (#3833), a trigger.message automation can match MeshCore traffic.
 */
async function isMeshCoreSource(ctx: EngineEvalContext, sourceId: string | null): Promise<boolean> {
  if (!sourceId) return false;
  return (await ctx.data.getSourceProtocol?.(sourceId)) === 'meshcore';
}

/**
 * Run a mesh-send action dep call and push its result into `results`. A
 * `TxDisabledError` from a TX-disabled Meshtastic source (#4294) is caught and
 * converted into the file's existing skip shape — mirroring the MeshCore-
 * unsupported skips above — so the run stays `status: 'completed'` instead of
 * failing. Any other error rethrows, preserving existing failure behavior.
 */
async function pushOrSkipTxDisabled<T>(results: unknown[], fn: () => Promise<T>): Promise<void> {
  try {
    results.push(await fn());
  } catch (error) {
    if (isTxDisabledError(error)) {
      results.push({ skipped: true, reason: 'TX_DISABLED' });
      return;
    }
    throw error;
  }
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

    case 'action.delay': {
      // Bounded, in-process pause that serializes with the sequential executor:
      // later actions in the chain wait for it. Clamped to [0, MAX]; not durable
      // across a restart (the run is in-memory).
      const raw = Number((p as Record<string, unknown>).seconds);
      const seconds = Number.isFinite(raw) ? Math.max(0, Math.min(AUTOMATION_DELAY_MAX_SECONDS, Math.floor(raw))) : 0;
      if (seconds > 0) {
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        await sleep(seconds * 1000);
      }
      return { delayedSeconds: seconds };
    }

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
      let text = await interpolateAsync(String(p.text ?? ''), ctx);
      // Destination resolution is deferred into the per-source loop below (#4018):
      // a MeshCore DM target is a pubkey string, a Meshtastic DM target is a node
      // number, and which applies depends on each target source's protocol —
      // unconditionally coercing via Number() left MeshCore destinations always NaN.
      const rawTo = p.to;
      const replyId = p.replyToTrigger ? (ctx.trigger.fields.packetId as number | undefined) : await num(ctx, p.replyId);

      // #3973: "Reply to the triggering message" auto-mention for MeshCore.
      // MeshCore carries no per-packet id, so `replyId` is always undefined for a
      // MeshCore trigger and the packetId tapback below is a no-op. A reply is
      // instead expressed by prepending the app's `@[Name]: ` mention — matching
      // the in-app reply composer (MeshCoreMessageStream `handleReply`). We use the
      // universal `senderLabel` (#3978: fromName → channelName → id) so a channel
      // post with no name prefix still degrades to the channel name / id rather
      // than an empty `@[]`. Gated to `protocol === 'meshcore'`: Meshtastic has no
      // `@[ ]` convention and keeps its packetId tapback (its senderLabel is a
      // nodeNum/id that would be a meaningless mention).
      if (
        p.replyToTrigger
        && ctx.trigger.triggerType === 'trigger.message'
        && ctx.trigger.fields.protocol === 'meshcore'
      ) {
        const label = typeof ctx.trigger.fields.senderLabel === 'string'
          ? ctx.trigger.fields.senderLabel.trim()
          : '';
        if (label && !text.trimStart().startsWith('@[')) {
          text = `@[${label}]: ${text}`;
        }
      }
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
          // `scopeCode` is only present in fields at all for a MeshCore message
          // trigger (buildMeshCoreMessageContext) — a schedule/telemetry/Meshtastic
          // trigger has no such key, and must inherit rather than be forced unscoped.
          const hasTriggerScope = 'scopeCode' in ctx.trigger.fields;
          if (typeof tn === 'string' && tn.length > 0) scopeOverride = tn; // resolved region name → match it
          else if (!hasTriggerScope) scopeOverride = undefined; // non-MeshCore trigger (no scope concept) → inherit
          // MeshCore message trigger with no resolvable region name: confirmed
          // unscoped (scopeCode 0), unresolvable (scopeCode null), OR scoped to a
          // region we can't name (scopeCode > 0, no known match). None can be
          // reproduced — the transport code is an HMAC keyed by the region name —
          // so reply unscoped rather than substitute the node's unrelated default
          // scope (#3998; previously inherited the default for the unmapped case, #3887).
          else scopeOverride = '';
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
        const proto = (await ctx.data.getSourceProtocol?.(sid)) ?? null;
        const meshcore = proto === 'meshcore';
        // MeshCore DM targets are contact public-key strings; Meshtastic DM
        // targets are node numbers (#4018) — resolve per the target source's
        // own protocol, not the trigger's. A `to` value can't be valid for both
        // at once, so a mixed-protocol multi-select whose `to` only makes sense
        // for one protocol falls back to a channel broadcast on the others —
        // a pre-existing per-source-multi-select design consequence, not new here.
        const destination = rawTo == null ? undefined : meshcore ? await str(ctx, rawTo) : await num(ctx, rawTo);

        if (destination != null || channelSel.length === 0) {
          // DM, or no unified-channel selection → single send on the fallback channel.
          // A DM keeps inherit scope: MeshCore reply scope only applies to flooded
          // channel broadcasts, so dropping the override on a DM is correct, not a leak.
          // A channel-only fallback send (no `to`) still honors the scope override.
          const fallbackScope = destination != null ? {} : scopeArg;
          await pushOrSkipTxDisabled(results, () => deps.sendMessage({ sourceId: sid, text, channel: fallbackChannel, destination, replyId, ...fallbackScope }));
          continue;
        }
        const srcChannels = (await ctx.data.getChannels?.(sid)) ?? [];
        for (const sel of channelSel) {
          if (sel.protocol && proto && sel.protocol !== proto) continue; // wrong-protocol channel
          const match = srcChannels.find((c) => c.name.toLowerCase() === sel.name.toLowerCase() && c.role !== 0);
          if (!match) continue; // channel not present on this source
          await pushOrSkipTxDisabled(results, () => deps.sendMessage({ sourceId: sid, text, channel: match.id, destination, replyId, ...scopeArg }));
        }
      }

      // `results` only stays empty when every target source produced neither a DM
      // send nor a channel match — equivalent to (and simpler than) checking the
      // old single outer `destination`, now that resolution is per-source.
      if (channelSel.length > 0 && results.length === 0) {
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

      // Target sources: explicit multi-select, else the legacy single source /
      // the triggering source (mirrors action.sendMessage / action.requestData, #3996).
      const sourceIds = Array.isArray(p.sourceIds) && p.sourceIds.length > 0
        ? (p.sourceIds as unknown[]).map(String)
        : [sourceId];

      const results: unknown[] = [];
      for (const sid of sourceIds) {
        // MeshCore has no tapback / emoji-reaction concept. Skip as a recorded
        // no-op rather than letting the deps throw, which would log a failed run
        // for every MeshCore message a tapback automation happens to match.
        if (await isMeshCoreSource(ctx, sid)) {
          results.push({ skipped: true, reason: 'tapback is not supported on MeshCore' });
          continue;
        }
        await pushOrSkipTxDisabled(results, () => deps.sendTapback({ sourceId: sid, emoji, channel, destination, replyId }));
      }
      // Unwrap the single-target case so the result shape (and run-log
      // resolvedParams) matches the original one-target behavior.
      return results.length === 1 ? results[0] : results;
    }

    case 'action.nodeManage': {
      const op = String(p.op ?? '') as NodeManageOp;
      const nodeNum = p.nodeNum != null ? await num(ctx, p.nodeNum) : (ctx.trigger.subjectNodeNum ?? undefined);
      if (nodeNum == null) throw new Error('action.nodeManage: no target node');
      if (!['favorite', 'unfavorite', 'ignore', 'unignore', 'delete'].includes(op)) {
        throw new Error(`action.nodeManage: invalid op "${op}"`);
      }
      // favorite/ignore management rides a Meshtastic admin channel; MeshCore
      // managers have no such senders. `delete` is DB-level and works for any
      // source, so only gate the mesh-admin ops — skip (no-op) on MeshCore.
      if (op !== 'delete' && await isMeshCoreSource(ctx, sourceId)) {
        return { skipped: true, reason: `nodeManage:${op} is not supported on MeshCore` };
      }
      return deps.manageNode({ sourceId, nodeNum, op });
    }

    case 'action.requestData': {
      // Ask a node/mesh for data or to announce (#3835): telemetry / position /
      // traceroute / nodeinfo / neighbors / advert. Protocol-aware — ops a
      // protocol can't do are recorded no-ops (like tapback/nodeManage).
      const op = String(p.op ?? 'telemetry') as NodeRequestOp;
      const telemetryType = ['device', 'environment', 'airQuality', 'power'].includes(String(p.telemetryType))
        ? (String(p.telemetryType) as TelemetryKind) : undefined;
      const channel = (await num(ctx, p.channel)) ?? triggerChannel;

      // Target source(s): explicit multi-select else the trigger source — lets a
      // source-less schedule/system trigger pick which radio to send via.
      const sourceIds = Array.isArray(p.sourceIds) && p.sourceIds.length > 0
        ? (p.sourceIds as unknown[]).map(String)
        : [sourceId];

      const results: unknown[] = [];
      for (const sid of sourceIds) {
        const meshcore = await isMeshCoreSource(ctx, sid);
        // MeshCore has no position / nodeinfo-exchange request → skip as a no-op.
        if (meshcore && (op === 'position' || op === 'nodeinfo')) {
          results.push({ skipped: true, reason: `${op} request is not supported on MeshCore` });
          continue;
        }
        let target = '';
        if (op !== 'advert') {
          target = (await interpolateAsync(String(p.to ?? ''), ctx)).trim();
          if (!target) {
            // Fall back to the triggering node: pubkey for MeshCore, node # for Meshtastic.
            target = meshcore
              ? String(ctx.trigger.fields.from ?? '').trim()
              : (ctx.trigger.subjectNodeNum != null ? String(ctx.trigger.subjectNodeNum) : '');
          }
          if (!target) throw new Error(`action.requestData: no target node for "${op}"`);
        }
        await pushOrSkipTxDisabled(results, () => deps.requestData({ sourceId: sid, op, target, channel, telemetryType: op === 'telemetry' ? telemetryType : undefined }));
      }
      return results.length === 1 ? results[0] : results;
    }

    case 'action.deviceReboot': {
      // Reboot the physical device (#3995). By default targets a SOURCE's local
      // node — so there's no nodeNum. `seconds` is the Meshtastic reboot delay
      // (default handled by the manager); MeshCore ignores it. Supports the same
      // multi-source select as sendMessage/requestData so a source-less schedule
      // trigger can pick which radio(s) to reboot.
      //
      // #4126: an optional `targetNodeNum` reboots a REMOTE node over the mesh via
      // the source's Meshtastic session-passkey admin mechanism. When set, it is
      // forwarded to the manager's remote-admin reboot; when blank/absent the
      // local-only path is unchanged.
      const secondsRaw = p.seconds != null ? Number(p.seconds) : undefined;
      const seconds = secondsRaw != null && Number.isFinite(secondsRaw) && secondsRaw >= 0
        ? Math.floor(secondsRaw) : undefined;
      const targetRaw = p.targetNodeNum != null && p.targetNodeNum !== '' ? Number(p.targetNodeNum) : undefined;
      const targetNodeNum = targetRaw != null && Number.isFinite(targetRaw) && targetRaw > 0
        ? Math.floor(targetRaw) : undefined;
      const sourceIds = Array.isArray(p.sourceIds) && p.sourceIds.length > 0
        ? (p.sourceIds as unknown[]).map(String)
        : [sourceId];
      const results: unknown[] = [];
      for (const sid of sourceIds) {
        // A remote-admin target rides the Meshtastic session-passkey mechanism,
        // which MeshCore sources don't have. In a mixed multi-source select,
        // skip those as a recorded no-op (matching tapback/nodeManage) instead
        // of hard-failing the whole action and starving later sources.
        if (targetNodeNum != null && await isMeshCoreSource(ctx, sid)) {
          results.push({ skipped: true, reason: 'remote-admin reboot is not supported on MeshCore' });
          continue;
        }
        await pushOrSkipTxDisabled(results, () => deps.rebootDevice({ sourceId: sid, seconds, targetNodeNum }));
      }
      return results.length === 1 ? results[0] : results;
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
