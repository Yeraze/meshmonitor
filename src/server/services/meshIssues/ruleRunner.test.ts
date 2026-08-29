import { describe, it, expect, vi, afterEach } from 'vitest';
import { runRulesIsolated } from './ruleRunner.js';
import { logger } from '../../../utils/logger.js';
import type { MeshIssueFinding } from './types.js';

interface Ctx {
  value: number;
}

function finding(nodeNum: number): MeshIssueFinding {
  return {
    issueType: 'A1_deprecated_role',
    subjectKey: `node:${nodeNum}`,
    nodeNum,
    severity: 'info',
    confidence: 'low',
    evidence: {},
    sourceIds: ['src-a'],
    recommendation: 'test',
  };
}

describe('runRulesIsolated', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs every rule in order and concatenates their findings', () => {
    const calls: string[] = [];
    const rules: Array<[string, (ctx: Ctx) => MeshIssueFinding[]]> = [
      ['R1', (ctx) => { calls.push('R1'); return [finding(ctx.value)]; }],
      ['R2', (ctx) => { calls.push('R2'); return [finding(ctx.value + 1)]; }],
      ['R3', () => { calls.push('R3'); return []; }],
    ];

    const findings = runRulesIsolated('Tier A', rules, { value: 1 });

    expect(calls).toEqual(['R1', 'R2', 'R3']);
    expect(findings.map((f) => f.nodeNum)).toEqual([1, 2]);
  });

  it('isolates a throwing rule: the remaining rules still run and contribute findings', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const rules: Array<[string, (ctx: Ctx) => MeshIssueFinding[]]> = [
      ['Good1', () => [finding(1)]],
      ['Bad', () => { throw new Error('boom'); }],
      ['Good2', () => [finding(2)]],
    ];

    const findings = runRulesIsolated('Tier A', rules, { value: 0 });

    expect(findings.map((f) => f.nodeNum)).toEqual([1, 2]);
  });

  it('logs the exact message shape, naming the tier and the rule', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const rules: Array<[string, (ctx: Ctx) => MeshIssueFinding[]]> = [
      ['B3', () => { throw new Error('boom'); }],
    ];

    runRulesIsolated('Tier B', rules, { value: 0 });

    expect(warnSpy).toHaveBeenCalledWith(
      '[meshIssues] Tier B rule B3 threw during evaluation, skipping:',
      expect.any(Error),
    );
  });

  it('returns [] for an empty rule list without throwing', () => {
    expect(runRulesIsolated('Tier A', [], { value: 0 })).toEqual([]);
  });

  it('survives every rule throwing, returning []', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const rules: Array<[string, (ctx: Ctx) => MeshIssueFinding[]]> = [
      ['R1', () => { throw new Error('a'); }],
      ['R2', () => { throw new Error('b'); }],
    ];
    expect(runRulesIsolated('Tier A', rules, { value: 0 })).toEqual([]);
  });
});
