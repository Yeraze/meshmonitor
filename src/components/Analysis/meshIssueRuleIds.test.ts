/**
 * Tests for the rule-id list and rule-mute settings-patch helper (report
 * reorg #4964 WP2, spec §5.2/§9.5-§9.10).
 */
import { describe, it, expect } from 'vitest';
import {
  MESH_ISSUE_TYPE_IDS,
  MESH_ISSUE_RULE_IDS,
  ruleShortId,
  tierOfRule,
  ruleIdsByTier,
  buildRuleMuteSettingsPatch,
  ISSUE_TYPE_LABELS,
} from './meshIssueRuleIds';

describe('MESH_ISSUE_RULE_IDS', () => {
  it('has exactly 18 entries, matching MESH_ISSUE_TYPE_IDS', () => {
    expect(MESH_ISSUE_RULE_IDS).toHaveLength(18);
    expect(MESH_ISSUE_RULE_IDS).toEqual(Object.values(MESH_ISSUE_TYPE_IDS));
  });

  it('every id has an ISSUE_TYPE_LABELS entry', () => {
    for (const id of MESH_ISSUE_RULE_IDS) {
      expect(ISSUE_TYPE_LABELS[id]).toBeTruthy();
    }
  });
});

describe('ruleShortId', () => {
  it('derives the tier+number prefix', () => {
    expect(ruleShortId('B7_coverage_shadow')).toBe('B7');
    expect(ruleShortId('A2b_congested_area')).toBe('A2b');
    expect(ruleShortId('C1_time_offset')).toBe('C1');
  });
});

describe('tierOfRule', () => {
  it('maps every rule id to its tier letter', () => {
    expect(tierOfRule('A1_deprecated_role')).toBe('A');
    expect(tierOfRule('B7_coverage_shadow')).toBe('B');
    expect(tierOfRule('C2_over_broadcasting')).toBe('C');
  });
});

describe('ruleIdsByTier', () => {
  it('partitions every rule id into exactly one of A/B/C, covering all 18', () => {
    const groups = ruleIdsByTier();
    const total = groups.A.length + groups.B.length + groups.C.length;
    expect(total).toBe(18);
    expect(groups.A).toHaveLength(7);
    expect(groups.B).toHaveLength(7);
    expect(groups.C).toHaveLength(4);
    expect(groups.B).toContain(MESH_ISSUE_TYPE_IDS.B7_COVERAGE_SHADOW);
  });
});

describe('buildRuleMuteSettingsPatch', () => {
  it('writes an empty CSV and b7Enabled=true when nothing is muted', () => {
    expect(buildRuleMuteSettingsPatch([])).toEqual({
      mesh_issues_disabled_rules: '',
      mesh_issues_b7_enabled: 'true',
    });
  });

  it('sorts and dedupes the CSV', () => {
    const patch = buildRuleMuteSettingsPatch([
      'C1_time_offset',
      'A1_deprecated_role',
      'A1_deprecated_role',
    ]);
    expect(patch.mesh_issues_disabled_rules).toBe('A1_deprecated_role,C1_time_offset');
  });

  it('writes mesh_issues_b7_enabled=false when B7 is in the mute list (TRAP §5.2)', () => {
    const patch = buildRuleMuteSettingsPatch(['B7_coverage_shadow']);
    expect(patch.mesh_issues_b7_enabled).toBe('false');
  });

  it('writes mesh_issues_b7_enabled=true when B7 is NOT in the mute list, even with other rules muted', () => {
    const patch = buildRuleMuteSettingsPatch(['C1_time_offset', 'A1_deprecated_role']);
    expect(patch.mesh_issues_b7_enabled).toBe('true');
  });

  it('un-muting B7 (removing it from the list) writes both keys so the legacy fold-in cannot re-mute it', () => {
    // Simulates: B7 was muted, user re-checks it in the UI.
    const muted = buildRuleMuteSettingsPatch(['B7_coverage_shadow']);
    expect(muted.mesh_issues_b7_enabled).toBe('false');

    const unmuted = buildRuleMuteSettingsPatch([]);
    expect(unmuted.mesh_issues_disabled_rules).toBe('');
    expect(unmuted.mesh_issues_b7_enabled).toBe('true');
  });
});
