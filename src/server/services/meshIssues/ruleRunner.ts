/**
 * Shared rule-runner for Mesh Issues Analysis (#4964, Phase 2 WP1).
 *
 * Runs a list of named rules against one context with per-rule throw
 * isolation: a rule that throws logs a warning and contributes no findings,
 * but the remaining rules still run. Extracted from Tier A's
 * `evaluateAllTierA` (Phase 1) so Tier B (`rulesTierB.ts`, Phase 2 WP4) does
 * not need a second copy of the same try/catch loop.
 *
 * Rules declare the protocols they understand (#6263 S5). A rule with no
 * declaration is Meshtastic-only, so a MeshCore node can never reach a rule
 * that reads Meshtastic roles or telemetry. The caller supplies `narrow` to
 * cut the context down to the declared protocols.
 *
 * Pure — no `databaseService` import, no I/O.
 */
import { logger } from '../../../utils/logger.js';
import type { MeshIssueFinding, MeshIssueProtocol } from './types.js';

export type RuleEntry<C> = readonly [
  name: string,
  rule: (ctx: C) => MeshIssueFinding[],
  protocols?: readonly MeshIssueProtocol[],
];

/**
 * Run `rules` in order against `ctx`, isolating each rule's failure from the
 * others. `tier` names the caller for the log line (`'Tier A'` / `'Tier B'`)
 * — the message shape is unchanged from the original inline
 * `evaluateAllTierA` loop: `` `[meshIssues] ${tier} rule ${name} threw during
 * evaluation, skipping:` ``.
 */
export function runRulesIsolated<C>(
  tier: string,
  rules: ReadonlyArray<RuleEntry<C>>,
  ctx: C,
  narrow?: (ctx: C, protocols: readonly MeshIssueProtocol[]) => C,
): MeshIssueFinding[] {
  const findings: MeshIssueFinding[] = [];
  for (const [name, rule, protocols] of rules) {
    try {
      const scoped = narrow ? narrow(ctx, protocols ?? ['meshtastic']) : ctx;
      findings.push(...rule(scoped));
    } catch (error) {
      logger.warn(`[meshIssues] ${tier} rule ${name} threw during evaluation, skipping:`, error);
    }
  }
  return findings;
}
