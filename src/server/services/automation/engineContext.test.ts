import { describe, it, expect } from 'vitest';
import {
  cooldownKeyFor,
  varContextFromTrigger,
  resolveFieldValue,
  getSubjectNode,
  NODE_COMPLETENESS,
  type CooldownKeyResolution,
  type EngineEvalContext,
  type NodeFacts,
} from './engineContext.js';
import type { TriggerContext } from './triggerContext.js';
import type { VariableResolver } from './variableResolver.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';
import { isNodeComplete } from '../../../utils/nodeHelpers.js';

/** Minimal TriggerContext builder for cooldownKeyFor truth-table tests. */
function ctx(over: Partial<TriggerContext> = {}): TriggerContext {
  return {
    triggerType: 'trigger.message',
    sourceId: 'src-1',
    subjectNodeNum: 111,
    timestamp: 1000,
    fields: {},
    ...over,
  };
}

const LONG_PUBKEY = 'a'.repeat(64);

describe('cooldownKeyFor (#4340 Phase 2)', () => {
  describe('scope: automation', () => {
    it('is always the automation-wide key, regardless of subject', () => {
      const r = cooldownKeyFor('automation', ctx());
      expect(r).toEqual<CooldownKeyResolution>({ key: '', label: 'automation-wide', degraded: false });
    });

    it('is automation-wide even with no subject at all', () => {
      const r = cooldownKeyFor('automation', ctx({ subjectNodeNum: null }));
      expect(r.key).toBe('');
      expect(r.degraded).toBe(false);
    });
  });

  describe('scope: node', () => {
    it('keys by the Meshtastic subject node number', () => {
      const r = cooldownKeyFor('node', ctx({ subjectNodeNum: 111 }));
      expect(r.key).toBe('111');
      expect(r.label).toContain('node 111');
      expect(r.degraded).toBe(false);
    });

    it('keys by an explicit MeshCore subject pubkey', () => {
      const r = cooldownKeyFor('node', ctx({ subjectNodeNum: null, subjectNodeKey: 'aabbccdd' }));
      expect(r.key).toBe('aabbccdd');
      expect(r.label).toContain('node aabbccdd');
      expect(r.degraded).toBe(false);
    });

    it('degrades to automation-wide when there is no subject (schedule/system/MeshCore-channel)', () => {
      const r = cooldownKeyFor('node', ctx({ subjectNodeNum: null }));
      expect(r.key).toBe('');
      expect(r.label).toContain('automation-wide');
      expect(r.degraded).toBe(true);
    });

    it('a long pubkey label truncates to 12 chars + ellipsis, but the KEY stays full-length', () => {
      const r = cooldownKeyFor('node', ctx({ subjectNodeNum: null, subjectNodeKey: LONG_PUBKEY }));
      expect(r.key).toBe(LONG_PUBKEY);
      expect(r.key.length).toBe(64);
      expect(r.label).toContain(`${LONG_PUBKEY.slice(0, 12)}…`);
      expect(r.label).not.toContain(LONG_PUBKEY);
    });
  });

  describe('scope: sourceNode', () => {
    it('keys by source + Meshtastic node number', () => {
      const r = cooldownKeyFor('sourceNode', ctx({ sourceId: 'src-1', subjectNodeNum: 111 }));
      expect(r.key).toBe('src-1:111');
      expect(r.label).toContain('src-1');
      expect(r.degraded).toBe(false);
    });

    it('keys by source + MeshCore pubkey', () => {
      const r = cooldownKeyFor('sourceNode', ctx({ sourceId: 'src-1', subjectNodeNum: null, subjectNodeKey: 'aabbccdd' }));
      expect(r.key).toBe('src-1:aabbccdd');
      expect(r.degraded).toBe(false);
    });

    it('degrades to automation-wide when there is no subject', () => {
      const r = cooldownKeyFor('sourceNode', ctx({ subjectNodeNum: null }));
      expect(r.key).toBe('');
      expect(r.degraded).toBe(true);
    });

    it('degrades to automation-wide when there is no sourceId', () => {
      const r = cooldownKeyFor('sourceNode', ctx({ sourceId: null, subjectNodeNum: 111 }));
      expect(r.key).toBe('');
      expect(r.label).toContain('automation-wide');
      expect(r.degraded).toBe(true);
    });
  });

  // Key-shape source of truth (spec §1, §2.4): cooldown keys must read identically
  // to AutomationVariablesRepository.buildScopeKey's node/sourceNode shapes.
  describe('cross-check against AutomationVariablesRepository.buildScopeKey', () => {
    it('node scope matches buildScopeKey("node", varContextFromTrigger(ctx))', () => {
      const c = ctx({ sourceId: 'src-1', subjectNodeNum: 111 });
      const expected = AutomationVariablesRepository.buildScopeKey('node', varContextFromTrigger(c));
      expect(cooldownKeyFor('node', c).key).toBe(expected);
    });

    it('sourceNode scope matches buildScopeKey("sourceNode", varContextFromTrigger(ctx))', () => {
      const c = ctx({ sourceId: 'src-1', subjectNodeNum: 111 });
      const expected = AutomationVariablesRepository.buildScopeKey('sourceNode', varContextFromTrigger(c));
      expect(cooldownKeyFor('sourceNode', c).key).toBe(expected);
    });
  });
});

describe('resolveFieldValue: node.* (#4340 Phase 3)', () => {
  const FAKE_VARS = { getValue: async () => null } as unknown as VariableResolver;

  /** Minimal EngineEvalContext builder. `node: undefined` means "no row for this subject". */
  function evalCtx(opts: {
    node?: NodeFacts | null;
    subjectNodeNum?: number | null;
    now?: number;
    getNodeSpy?: { calls: number };
  } = {}): EngineEvalContext {
    const trigger: TriggerContext = {
      triggerType: 'trigger.message',
      sourceId: 'src-1',
      subjectNodeNum: opts.subjectNodeNum === undefined ? 111 : opts.subjectNodeNum,
      timestamp: 1000,
      fields: {},
    };
    return {
      trigger,
      vars: FAKE_VARS,
      data: {
        getNode: async () => {
          if (opts.getNodeSpy) opts.getNodeSpy.calls += 1;
          return opts.node ?? null;
        },
        getTelemetry: async () => null,
      },
      varCtx: { sourceId: trigger.sourceId, nodeNum: trigger.subjectNodeNum },
      now: opts.now ?? 1000,
    };
  }

  const COMPLETE_NODE: NodeFacts = { nodeNum: 111, longName: 'Base Station', shortName: 'BASE', hwModel: 9 };

  it('NODE_COMPLETENESS contains exactly the three tri-state values', () => {
    expect(NODE_COMPLETENESS).toEqual(['complete', 'incomplete', 'unknown']);
  });

  it('truth table: a fully-hydrated node is "complete"', async () => {
    const c = evalCtx({ node: COMPLETE_NODE });
    expect(await resolveFieldValue(c, 'node.completeness')).toBe('complete');
  });

  it('truth table: a default "Node !xxxxxxxx" longName is "incomplete"', async () => {
    const c = evalCtx({ node: { ...COMPLETE_NODE, longName: 'Node !aabbccdd' } });
    expect(await resolveFieldValue(c, 'node.completeness')).toBe('incomplete');
  });

  it('truth table: a missing hwModel is "incomplete"', async () => {
    const c = evalCtx({ node: { ...COMPLETE_NODE, hwModel: undefined } });
    expect(await resolveFieldValue(c, 'node.completeness')).toBe('incomplete');
  });

  it('truth table: a missing shortName is "incomplete"', async () => {
    const c = evalCtx({ node: { ...COMPLETE_NODE, shortName: undefined } });
    expect(await resolveFieldValue(c, 'node.completeness')).toBe('incomplete');
  });

  it('truth table: no row for the subject (provider returns null) is "unknown"', async () => {
    const c = evalCtx({ node: null });
    expect(await resolveFieldValue(c, 'node.completeness')).toBe('unknown');
  });

  it('truth table: no subject node at all (schedule/system context) is "unknown"', async () => {
    const c = evalCtx({ subjectNodeNum: null });
    expect(await resolveFieldValue(c, 'node.completeness')).toBe('unknown');
  });

  it('cross-check: never re-implements isNodeComplete — value tracks the helper directly for every row that exists', async () => {
    const rows: NodeFacts[] = [
      COMPLETE_NODE,
      { ...COMPLETE_NODE, longName: 'Node !aabbccdd' },
      { ...COMPLETE_NODE, hwModel: undefined },
      { ...COMPLETE_NODE, shortName: undefined },
    ];
    for (const row of rows) {
      const c = evalCtx({ node: row });
      const expected = isNodeComplete(row) ? 'complete' : 'incomplete';
      expect(await resolveFieldValue(c, 'node.completeness')).toBe(expected);
    }
  });

  it('does not shadow existing node.* behaviour: ageMinutes, roleName, and passthrough still work', async () => {
    const now = 10_000_000;
    const c = evalCtx({
      node: { nodeNum: 111, lastHeard: now / 1000 - 60 * 60, role: 2, batteryLevel: 42 },
      now,
    });
    expect(await resolveFieldValue(c, 'node.ageMinutes')).toBe(60);
    expect(await resolveFieldValue(c, 'node.roleName')).toBe('ROUTER');
    expect(await resolveFieldValue(c, 'node.batteryLevel')).toBe(42);
  });

  it('node.<missing prop> still returns undefined when the row exists', async () => {
    const c = evalCtx({ node: COMPLETE_NODE });
    expect(await resolveFieldValue(c, 'node.notARealProp')).toBeUndefined();
  });

  it('node.<anything> still returns undefined when there is no row', async () => {
    const c = evalCtx({ node: null });
    expect(await resolveFieldValue(c, 'node.batteryLevel')).toBeUndefined();
  });

  it('getSubjectNode is memoised: reading node.completeness and node.batteryLevel on the same ctx performs one DB read', async () => {
    const spy = { calls: 0 };
    const c = evalCtx({ node: COMPLETE_NODE, getNodeSpy: spy });
    await resolveFieldValue(c, 'node.completeness');
    await resolveFieldValue(c, 'node.batteryLevel');
    await getSubjectNode(c);
    expect(spy.calls).toBe(1);
  });
});
