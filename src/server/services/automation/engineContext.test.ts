import { describe, it, expect } from 'vitest';
import { cooldownKeyFor, varContextFromTrigger, type CooldownKeyResolution } from './engineContext.js';
import type { TriggerContext } from './triggerContext.js';
import { AutomationVariablesRepository } from '../../../db/repositories/automationVariables.js';

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
