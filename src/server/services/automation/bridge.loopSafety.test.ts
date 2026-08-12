/**
 * MT↔MC Bridge template — loop-safety round-trip proof (Phase 4, WP2).
 *
 * `bridge.ts` builds a MATCHED PAIR of automations (MT→MC and MC→MT) that
 * relay channel text between a Meshtastic and a MeshCore source. Each
 * direction tags the relayed text with its origin ("MT@sender: " /
 * "MC@sender: ") and refuses to relay anything ALREADY carrying either tag
 * (see `bridge.ts`'s file-header comment). This test proves that guard
 * actually breaks the cycle end-to-end, by feeding the OUTPUT of one
 * direction's simulated send back in as the OTHER direction's inbound event
 * and confirming it does not match.
 *
 * The Meshtastic-originated half uses the dry-run simulator
 * (`simulateAutomation`), mirroring `automationSimulator.test.ts`'s own setup.
 *
 * The MeshCore-originated half does NOT: `automationSimulator.ts`'s `kind:
 * 'message'` event always builds its trigger context via `buildMessageContext`
 * (the Meshtastic-shaped builder — `protocolShort` is hardcoded `'MT'`; there
 * is no MeshCore branch for message events in the simulator today). Feeding a
 * `sourceId: 'mc1'` event through `simulateAutomation` would silently still
 * tag the relay "MT@…", which would prove nothing about the MeshCore
 * direction. So the MeshCore half runs the SAME production path
 * `automationEngineService.ts` uses for a real inbound MeshCore message —
 * `buildMeshCoreMessageContext` + `meshCoreMessageMatchesFilter` +
 * `evaluateGraph` with the real `evaluateCondition`/`executeAction` hooks and
 * a recording (no-IO) `ActionDeps` — instead of the Meshtastic-only simulator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { simulateAutomation, type SimulateOptions } from './automationSimulator.js';
import { evaluateGraph } from './graphEvaluator.js';
import { evaluateCondition } from './conditionEvaluator.js';
import { executeAction, type ActionDeps } from './actionExecutor.js';
import { buildMeshCoreMessageContext, meshCoreMessageMatchesFilter } from './triggerContext.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import { VariableResolver } from './variableResolver.js';
import { varContextFromTrigger, type EngineEvalContext, type NodeDataProvider } from './engineContext.js';
import { createTestDb } from '../../test-helpers/testDb.js';
import { bridgeTemplate } from '../../../components/automations/templates/bridge.js';
import type { BuiltAutomation } from '../../../components/automations/templates/types.js';
import type { AutomationGraph } from '../../../types/automation.js';

const PARAMS = {
  mtSource: ['mt1'],
  mtChannel: [{ name: 'General', protocol: 'meshtastic' }],
  mcSource: ['mc1'],
  mcChannel: [{ name: 'General', protocol: 'meshcore' }],
};

// Live-data stub: each source only carries the one channel it was configured
// with, on the matching protocol — mirrors actionExecutor.test.ts's own
// `ctxWithChannels` helper (the source×channel matrix a real deployment has).
const liveData: NodeDataProvider = {
  async getNode() { return null; },
  async getTelemetry() { return null; },
  async getChannelName() { return null; },
  async getChannels(sourceId: string | null) {
    if (sourceId === 'mt1') return [{ id: 0, name: 'General', role: 1 }];
    if (sourceId === 'mc1') return [{ id: 0, name: 'General', role: 1 }];
    return [];
  },
  async getSourceProtocol(sourceId: string | null) {
    if (sourceId === 'mt1') return 'meshtastic';
    if (sourceId === 'mc1') return 'meshcore';
    return null;
  },
};

/** No-IO ActionDeps — each call resolves to its received params (mirrors automationSimulator.ts's own recordingDeps, not exported there). */
function recordingDeps(): ActionDeps {
  return {
    async sendMessage(a) { return { action: 'sendMessage', ...a }; },
    async sendTapback(a) { return { action: 'tapback', ...a }; },
    async manageNode(a) { return { action: 'nodeManage', ...a }; },
    async requestData(a) { return { action: 'requestData', ...a }; },
    async rebootDevice(a) { return { action: 'deviceReboot', ...a }; },
    async notify(a) { return { action: 'notify', ...a }; },
    async runScript() { return { success: true, stdout: '' }; },
    async sleep() { /* no real wait */ },
  };
}

interface MinimalSimResult {
  matched: boolean;
  conditionResults: Record<string, boolean>;
  actions: Array<{ nodeId: string; ok: boolean; resolvedParams?: unknown; error?: string }>;
}

describe('bridgeTemplate loop safety (round-trip)', () => {
  let varsRepo: AutomationVariablesRepository;
  let closeDb: () => void;

  beforeEach(() => {
    const t = createTestDb();
    varsRepo = new AutomationVariablesRepository(t.db, 'sqlite');
    closeDb = () => t.sqlite.close();
  });
  afterEach(() => closeDb());

  const [mtToMc, mcToMt] = bridgeTemplate.build(PARAMS) as BuiltAutomation[];

  /** Meshtastic-originated inbound message, via the real dry-run simulator. */
  function simMeshtastic(graph: AutomationGraph, opts: {
    sourceId: string; channelName: string; text: string; from?: number; to?: number; fromName?: string;
  }) {
    return simulateAutomation({
      graph,
      varsRepo,
      liveData,
      node: opts.fromName ? { longName: opts.fromName } : undefined,
      event: {
        kind: 'message',
        sourceId: opts.sourceId,
        channelName: opts.channelName,
        text: opts.text,
        from: opts.from ?? 111,
        to: opts.to, // undefined ⇒ BROADCAST_ADDR ⇒ isDM=0
        packetId: 1,
      },
    } satisfies SimulateOptions);
  }

  /**
   * MeshCore-originated inbound channel message, via the SAME production path
   * automationEngineService.ts uses (buildMeshCoreMessageContext +
   * meshCoreMessageMatchesFilter + evaluateGraph) — see file header for why
   * this doesn't go through automationSimulator.ts's Meshtastic-only `kind:
   * 'message'` event.
   */
  async function simMeshCore(graph: AutomationGraph, opts: {
    sourceId: string; channelName: string; text: string; fromName?: string;
  }): Promise<MinimalSimResult> {
    const now = Date.now();
    const msg: MeshCoreMessage = {
      id: 'mc-1',
      // A channel post's synthetic sender key (parseMeshCoreChannelIdx) — see
      // triggerContext.ts's buildMeshCoreMessageContext header comment.
      fromPublicKey: 'channel-0',
      fromName: opts.fromName,
      text: opts.text,
      timestamp: now,
      messageType: 'channel',
    } as MeshCoreMessage;
    const ctx = buildMeshCoreMessageContext(msg, opts.sourceId, now, { channelName: opts.channelName });

    const triggerNode = graph.nodes.find((n) => n.type === 'trigger.message');
    const matched = !!triggerNode && meshCoreMessageMatchesFilter(msg, triggerNode.params ?? {}, opts.channelName);
    if (!matched) return { matched: false, conditionResults: {}, actions: [] };

    const vars = new VariableResolver(varsRepo);
    const deps = recordingDeps();
    const evalCtx: EngineEvalContext = { trigger: ctx, vars, data: liveData, varCtx: varContextFromTrigger(ctx), now };
    const result = await evaluateGraph(graph, evalCtx, {
      evaluateCondition: (n, c) => evaluateCondition(n, c),
      executeAction: (n, c) => executeAction(n, c, deps),
      applySetVar: async () => { /* no flow.setVar in this graph */ },
    });
    return {
      matched: true,
      conditionResults: result.conditionResults,
      actions: result.actions.map((a) => ({ nodeId: a.nodeId, ok: a.ok, resolvedParams: a.value, error: a.error })),
    };
  }

  it('MT→MC: a fresh Meshtastic channel message matches, relays exactly once to mc1, tagged MT@', async () => {
    const r = await simMeshtastic(mtToMc.config, { sourceId: 'mt1', channelName: 'General', text: 'hello', fromName: 'Alice' });
    expect(r.matched).toBe(true);
    expect(r.status).toBe('completed');
    expect(r.actions).toHaveLength(1);
    const params = r.actions[0].resolvedParams as { sourceId?: string; text?: string };
    expect(params.sourceId).toBe('mc1');
    expect(params.text).toMatch(/^MT@.*: hello$/);
  });

  it('MT→MC then feeding the relayed text back through MC→MT: the loop guard breaks the cycle (0 actions)', async () => {
    const first = await simMeshtastic(mtToMc.config, { sourceId: 'mt1', channelName: 'General', text: 'hello', fromName: 'Alice' });
    const relayedText = (first.actions[0].resolvedParams as { text: string }).text;
    expect(relayedText).toMatch(/^MT@/);

    // The relayed "MT@..." text now arrives on the MeshCore side. The trigger
    // pre-filter still matches (it only checks channel/text-contains/regex,
    // not the notContains guard) — the guard lives in the condition chain, so
    // it shows up as zero actions, not a trigger miss.
    const second = await simMeshCore(mcToMt.config, { sourceId: 'mc1', channelName: 'General', text: relayedText });
    expect(second.matched).toBe(true);
    expect(second.conditionResults).toMatchObject({ c2: false }); // the notContains 'MT@' guard
    expect(second.actions).toHaveLength(0);
  });

  it('MC→MT: a fresh MeshCore channel message matches, relays exactly once to mt1, tagged MC@', async () => {
    const r = await simMeshCore(mcToMt.config, { sourceId: 'mc1', channelName: 'General', text: 'hi', fromName: 'Bob' });
    expect(r.matched).toBe(true);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].ok).toBe(true);
    const params = r.actions[0].resolvedParams as { sourceId?: string; text?: string };
    expect(params.sourceId).toBe('mt1');
    expect(params.text).toMatch(/^MC@.*: hi$/);
  });

  it('MC→MT then feeding the relayed text back through MT→MC: the loop guard breaks the cycle (0 actions)', async () => {
    const first = await simMeshCore(mcToMt.config, { sourceId: 'mc1', channelName: 'General', text: 'hi', fromName: 'Bob' });
    const relayedText = (first.actions[0].resolvedParams as { text: string }).text;
    expect(relayedText).toMatch(/^MC@/);

    const second = await simMeshtastic(mtToMc.config, { sourceId: 'mt1', channelName: 'General', text: relayedText });
    expect(second.matched).toBe(true);
    expect(second.conditionResults).toMatchObject({ c3: false }); // the notContains 'MC@' guard
    expect(second.actions).toHaveLength(0);
  });

  it('a Meshtastic DM never relays (isDM gate), even with a fresh, untagged text', async () => {
    // Trigger pre-filter (messageMatchesFilter) never inspects `to`/isDM at
    // all, so it still matches — the gate lives in the condition chain
    // (condition.numeric isDM==0), which is why this is 0 actions, not a
    // trigger miss.
    const r = await simMeshtastic(mtToMc.config, {
      sourceId: 'mt1', channelName: 'General', text: 'hello', to: 222, // an explicit non-broadcast recipient ⇒ isDM=1
    });
    expect(r.matched).toBe(true);
    expect(r.conditionResults).toMatchObject({ c1: false }); // isDM == 0 fails
    expect(r.actions).toHaveLength(0);
  });
});
