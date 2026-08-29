/**
 * Shared rule-runner for Mesh Issues Analysis (#4964, Phase 2 WP1).
 *
 * Runs a list of named rules against one context with per-rule throw
 * isolation: a rule that throws logs a warning and contributes no findings,
 * but the remaining rules still run. Extracted from Tier A's
 * `evaluateAllTierA` (Phase 1) so Tier B (`rulesTierB.ts`, Phase 2 WP4) does
 * not need a second copy of the same try/catch loop.
 *
 * Pure — no `databaseService` import, no I/O.
 */
import { logger } from '../../../utils/logger.js';
import type { MeshIssueFinding } from './types.js';

/**
 * Run `rules` in order against `ctx`, isolating each rule's failure from the
 * others. `tier` names the caller for the log line (`'Tier A'` / `'Tier B'`)
 * — the message shape is unchanged from the original inline
 * `evaluateAllTierA` loop: `` `[meshIssues] ${tier} rule ${name} threw during
 * evaluation, skipping:` ``.
 */
export function runRulesIsolated<C>(
  tier: string,
  rules: ReadonlyArray<readonly [name: string, rule: (ctx: C) => MeshIssueFinding[]]>,
  ctx: C,
): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  for (const [name, rule] of rules) {
    try {
      findings.push(...rule(ctx));
    } catch (error) {
      logger.warn(`[meshIssues] ${tier} rule ${name} threw during evaluation, skipping:`, error);
    }
  }
  return findings;
}
