/**
 * action.aiSummarize (#6566): channel resolution, the time window, the run
 * output, and the "too quiet" stop.
 */
import { describe, it, expect, vi } from 'vitest';
import { executeAction, actionStepDetail, type ActionDeps } from './actionExecutor.js';
import { createStepOutputs, type EngineEvalContext } from './engineContext.js';
import { validateAutomationGraph, type AutomationNode } from '../../../types/automation.js';
import type { VariableResolver } from './variableResolver.js';
import type { SummarizeRequest, SummarizeResult } from '../aiSummaryService.js';

const NOW = 10 * 24 * 3_600_000;

function makeCtx(over: Partial<EngineEvalContext> = {}): EngineEvalContext {
  const protocols: Record<string, string> = { mt: 'meshtastic', mc: 'meshcore', rns: 'reticulum' };
  const channels: Record<string, Array<{ id: number; name: string; role?: number }>> = {
    mt: [{ id: 0, name: 'LongFast', role: 1 }, { id: 2, name: 'Gauntlet', role: 2 }],
    mc: [{ id: 1, name: 'gauntlet' }],
  };
  return {
    trigger: { triggerType: 'trigger.schedule', sourceId: null, subjectNodeNum: null, timestamp: NOW, fields: {} },
    vars: { getValue: async () => null } as unknown as VariableResolver,
    data: {
      getNode: async () => null,
      getTelemetry: async () => null,
      getSourceProtocol: async (sid: string) => protocols[sid] ?? null,
      getChannels: async (sid: string) => channels[sid] ?? [],
    } as any,
    varCtx: { sourceId: null, nodeNum: null },
    now: NOW,
    automationId: 'auto-1',
    stepOutputs: createStepOutputs(),
    ...over,
  };
}

function makeDeps(result: SummarizeResult, lastRun: number | null = null) {
  const summarizeChannels = vi.fn(async (_a: SummarizeRequest) => result);
  const lastCompletedRunAt = vi.fn(async () => lastRun);
  return { deps: { summarizeChannels, lastCompletedRunAt } as unknown as ActionDeps, summarizeChannels, lastCompletedRunAt };
}

const node = (params: Record<string, unknown>): AutomationNode => ({ id: 's', type: 'action.aiSummarize', params });

describe('action.aiSummarize', () => {
  it('resolves unified channels to local slots per source and protocol', async () => {
    const { deps, summarizeChannels } = makeDeps({ messageCount: 3, summary: 'all quiet' });
    await executeAction(
      node({ sourceIds: ['mt', 'mc', 'rns'], channels: [{ name: 'gauntlet', protocol: 'meshtastic' }, { name: 'Gauntlet', protocol: 'meshcore' }], outputName: 'summary' }),
      makeCtx(),
      deps,
    );
    const req = summarizeChannels.mock.calls[0][0];
    expect(req.targets).toEqual([
      { sourceId: 'mt', protocol: 'meshtastic', channel: 2, channelName: 'Gauntlet' },
      { sourceId: 'mc', protocol: 'meshcore', channel: 1, channelName: 'gauntlet' },
    ]);
    expect(req.sinceMs).toBe(NOW - 24 * 3_600_000);
    expect(req.excludeAutomated).toBe(true);
    expect(req.minMessages).toBe(1);
  });

  it('stores the summary for later steps and keeps the text out of the run-log detail', async () => {
    const ctx = makeCtx();
    const { deps } = makeDeps({ messageCount: 4, summary: 'Bob asked about the repeater', model: 'm' });
    const value = await executeAction(
      node({ sourceIds: ['mt'], channels: [{ name: 'LongFast' }], outputName: 'summary' }),
      ctx,
      deps,
    );
    expect(ctx.stepOutputs!.get('summary')).toEqual({ ok: true, output: 'Bob asked about the repeater' });
    expect(ctx.halt).toBeUndefined();
    expect(actionStepDetail(node({}), value)).toEqual({ messageCount: 4, model: 'm' });
    expect(JSON.stringify(value)).not.toContain('repeater');
  });

  it('stops the run, as an idle action, when the window is too quiet', async () => {
    const ctx = makeCtx();
    const { deps, summarizeChannels } = makeDeps({ messageCount: 1, skipped: true });
    const value = await executeAction(
      node({ sourceIds: ['mt'], channels: [{ name: 'LongFast' }], outputName: 'summary', minMessages: 5 }),
      ctx,
      deps,
    );
    expect(summarizeChannels.mock.calls[0][0].minMessages).toBe(5);
    expect(ctx.halt?.reason).toMatch(/only 1 message/);
    expect(ctx.idleActions).toBe(1);
    expect(ctx.stepOutputs!.get('summary')).toEqual({ ok: false });
    expect(value).toEqual({ skipped: true, messageCount: 1 });
  });

  it('"since last run" reads from the last completed run, else the lookback', async () => {
    const last = NOW - 3 * 3_600_000;
    const a = makeDeps({ messageCount: 2, summary: 'x' }, last);
    await executeAction(node({ sourceIds: ['mt'], channels: [{ name: 'LongFast' }], window: 'sinceLastRun', lookbackHours: 48 }), makeCtx(), a.deps);
    expect(a.lastCompletedRunAt).toHaveBeenCalledWith('auto-1');
    expect(a.summarizeChannels.mock.calls[0][0].sinceMs).toBe(last);

    const b = makeDeps({ messageCount: 2, summary: 'x' }, null);
    await executeAction(node({ sourceIds: ['mt'], channels: [{ name: 'LongFast' }], window: 'sinceLastRun', lookbackHours: 48 }), makeCtx(), b.deps);
    expect(b.summarizeChannels.mock.calls[0][0].sinceMs).toBe(NOW - 48 * 3_600_000);
  });

  it('marks the output failed and rethrows when the endpoint fails', async () => {
    const ctx = makeCtx();
    const deps = { summarizeChannels: async () => { throw new Error('AI endpoint error (401)'); } } as unknown as ActionDeps;
    await expect(executeAction(node({ sourceIds: ['mt'], channels: [{ name: 'LongFast' }], outputName: 'summary' }), ctx, deps))
      .rejects.toThrow('401');
    expect(ctx.stepOutputs!.get('summary')).toEqual({ ok: false });
  });

  it('fails when no selected channel exists on the selected sources', async () => {
    const { deps } = makeDeps({ messageCount: 0, skipped: true });
    await expect(executeAction(node({ sourceIds: ['mt'], channels: [{ name: 'nope' }] }), makeCtx(), deps))
      .rejects.toThrow(/none of the selected channels/);
  });

  it('passes untick, prompt and limits through', async () => {
    const { deps, summarizeChannels } = makeDeps({ messageCount: 2, summary: 'x' });
    await executeAction(
      node({ sourceIds: ['mt'], channels: [{ name: 'LongFast' }], excludeAutomated: false, prompt: 'Use bullets', maxLength: 500, maxInputChars: 2000 }),
      makeCtx(),
      deps,
    );
    expect(summarizeChannels.mock.calls[0][0]).toMatchObject({ excludeAutomated: false, prompt: 'Use bullets', maxLength: 500, maxInputChars: 2000 });
  });
});

describe('validateAutomationGraph: action.aiSummarize', () => {
  const graph = (params: Record<string, unknown>) => ({
    version: 1,
    nodes: [
      { id: 't', type: 'trigger.schedule', params: { cron: '0 8 * * *' } },
      { id: 's', type: 'action.aiSummarize', params },
    ],
    edges: [{ from: 't', to: 's' }],
  });

  it('accepts a complete step', () => {
    const r = validateAutomationGraph(graph({ sourceIds: ['mt'], channels: [{ name: 'LongFast' }], outputName: 'summary', window: 'hours', lookbackHours: 12 }));
    expect(r.errors).toEqual([]);
  });

  it('requires sources, channels and an output name', () => {
    const r = validateAutomationGraph(graph({}));
    expect(r.errors.join('\n')).toMatch(/sourceIds/);
    expect(r.errors.join('\n')).toMatch(/channels/);
    expect(r.errors.join('\n')).toMatch(/outputName/);
  });

  it('rejects an unknown window and a non-positive lookback', () => {
    const r = validateAutomationGraph(graph({ sourceIds: ['mt'], channels: [{ name: 'x' }], outputName: 'summary', window: 'forever', lookbackHours: -1 }));
    expect(r.errors.join('\n')).toMatch(/window/);
    expect(r.errors.join('\n')).toMatch(/lookbackHours/);
  });

  it('rejects non-positive counts and sizes', () => {
    const r = validateAutomationGraph(graph({ sourceIds: ['mt'], channels: [{ name: 'x' }], outputName: 'summary', minMessages: 0, maxLength: -5, maxInputChars: 'abc' }));
    const all = r.errors.join('\n');
    expect(all).toMatch(/minMessages/);
    expect(all).toMatch(/maxLength/);
    expect(all).toMatch(/maxInputChars/);
  });
});
