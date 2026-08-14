import { describe, it, expect } from 'vitest';
import { bridgeTemplate } from './bridge';
import { validateAutomationGraph, type AutomationGraph } from '../../../types/automation';
import type { BuiltAutomation } from './types';
import { UI_ICON_DEFINITIONS } from '../../icons';

function buildPair(values: Record<string, unknown>): [BuiltAutomation, BuiltAutomation] {
  const built = bridgeTemplate.build(values);
  expect(Array.isArray(built), 'the bridge template must always produce a pair').toBe(true);
  const arr = built as BuiltAutomation[];
  expect(arr).toHaveLength(2);
  return [arr[0], arr[1]];
}

function node(config: AutomationGraph, id: string) {
  const n = config.nodes.find((x) => x.id === id);
  expect(n, `node "${id}" not found in ${JSON.stringify(config.nodes)}`).toBeDefined();
  return n!;
}

function findByType(config: AutomationGraph, type: string) {
  return config.nodes.filter((n) => n.type === type);
}

const FULL_PARAMS = {
  mtSource: ['mt1'],
  mtChannel: [{ name: 'General', protocol: 'meshtastic' }],
  mcSource: ['mc1'],
  mcChannel: [{ name: 'General', protocol: 'meshcore' }],
};

describe('bridgeTemplate', () => {
  it('has the expected template metadata, including a real UiIcon name', () => {
    expect(bridgeTemplate.id).toBe('mt-mc-bridge');
    expect(bridgeTemplate.name).toBeTruthy();
    expect(bridgeTemplate.description).toBeTruthy();
    expect(bridgeTemplate.tags).toEqual(['Bridge', 'MeshCore', 'Relay']);
    expect(bridgeTemplate.icon in UI_ICON_DEFINITIONS).toBe(true);
    expect(bridgeTemplate.params.map((p) => p.name)).toEqual([
      'mtSource', 'mtChannel', 'mcSource', 'mcChannel', 'rateLimitMax',
    ]);
  });

  it('scopes each side’s source/channel pickers to its own protocol', () => {
    const byName = Object.fromEntries(bridgeTemplate.params.map((p) => [p.name, p]));
    // The Meshtastic pickers must not offer MeshCore options, and vice-versa.
    expect(byName.mtSource.protocolFilter).toBe('meshtastic');
    expect(byName.mtChannel.protocolFilter).toBe('meshtastic');
    expect(byName.mcSource.protocolFilter).toBe('meshcore');
    expect(byName.mcChannel.protocolFilter).toBe('meshcore');
  });

  it('build({}) does not throw and produces a valid pair with no filters', () => {
    const [mtToMc, mcToMt] = buildPair({});
    for (const a of [mtToMc, mcToMt]) {
      expect(a.name).toBeTruthy();
      expect(a.description).toBeTruthy();
      expect(findByType(a.config, 'condition.sourceFilter')).toHaveLength(0);
      expect(node(a.config, 't').params).not.toHaveProperty('channels');
      const result = validateAutomationGraph(a.config);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    }
  });

  it('always returns an array of exactly 2 automations, even with full params', () => {
    const [mtToMc, mcToMt] = buildPair(FULL_PARAMS);
    expect(mtToMc.name).toBe('MT_to_MC_Bridge');
    expect(mcToMt.name).toBe('MC_to_MT_Bridge');
  });

  describe('MT→MC direction', () => {
    it('threads the Meshtastic source/channel onto the trigger and the MeshCore source/channel onto the send', () => {
      const [mtToMc] = buildPair(FULL_PARAMS);
      const { config } = mtToMc;

      expect(node(config, 't').params).toMatchObject({
        channels: [{ name: 'General', protocol: 'meshtastic' }],
      });
      expect(node(config, 'c0')).toMatchObject({
        type: 'condition.sourceFilter',
        params: { sourceIds: ['mt1'] },
      });

      const sendNode = findByType(config, 'action.sendMessage')[0];
      expect(sendNode.params).toMatchObject({
        sourceIds: ['mc1'],
        channels: [{ name: 'General', protocol: 'meshcore' }],
      });
    });
  });

  describe('MC→MT direction', () => {
    it('threads the MeshCore source/channel onto the trigger and the Meshtastic source/channel onto the send', () => {
      const [, mcToMt] = buildPair(FULL_PARAMS);
      const { config } = mcToMt;

      expect(node(config, 't').params).toMatchObject({
        channels: [{ name: 'General', protocol: 'meshcore' }],
      });
      expect(node(config, 'c0')).toMatchObject({
        type: 'condition.sourceFilter',
        params: { sourceIds: ['mc1'] },
      });

      const sendNode = findByType(config, 'action.sendMessage')[0];
      expect(sendNode.params).toMatchObject({
        sourceIds: ['mt1'],
        channels: [{ name: 'General', protocol: 'meshtastic' }],
      });
    });
  });

  it('gates on isDM == 0 (channel broadcasts only) in both directions', () => {
    for (const a of buildPair(FULL_PARAMS)) {
      const numeric = findByType(a.config, 'condition.numeric');
      expect(numeric.some((n) => (n.params as any).field === 'isDM' && (n.params as any).op === '==' && (n.params as any).value === '0')).toBe(true);
    }
  });

  it('carries BOTH loop-guard notContains checks ("MT@" and "MC@") in BOTH directions', () => {
    for (const a of buildPair(FULL_PARAMS)) {
      const strings = findByType(a.config, 'condition.string').map((n) => n.params);
      expect(strings.some((p: any) => p.op === 'notContains' && p.field === 'text' && p.value === 'MT@')).toBe(true);
      expect(strings.some((p: any) => p.op === 'notContains' && p.field === 'text' && p.value === 'MC@')).toBe(true);
    }
  });

  it('send text always carries the cross-protocol tag + sender tokens', () => {
    for (const a of buildPair(FULL_PARAMS)) {
      const sendNode = findByType(a.config, 'action.sendMessage')[0];
      const text = String((sendNode.params as any).text);
      expect(text).toContain('{{ trigger.protocolShort }}');
      expect(text).toContain('{{ trigger.fromName }}');
      expect(text).toContain('{{ trigger.text }}');
    }
  });

  it('sets includeSelf:true on both triggers so the operator\'s own outgoing messages still relay (#4694)', () => {
    for (const a of buildPair(FULL_PARAMS)) {
      expect(node(a.config, 't').params.includeSelf).toBe(true);
    }
  });

  it('never emits a portnum trigger param on either direction (would silently go Meshtastic-only)', () => {
    for (const a of buildPair(FULL_PARAMS)) {
      expect(node(a.config, 't').params).not.toHaveProperty('portnum');
    }
  });

  it('applies the default rateLimit (20/60) on both triggers when no override is given', () => {
    for (const a of buildPair(FULL_PARAMS)) {
      expect(node(a.config, 't').params.rateLimit).toEqual({ maxActions: 20, windowSeconds: 60 });
    }
  });

  it('honors a valid rateLimitMax override on both directions', () => {
    for (const a of buildPair({ ...FULL_PARAMS, rateLimitMax: '5' })) {
      expect(node(a.config, 't').params.rateLimit).toEqual({ maxActions: 5, windowSeconds: 60 });
    }
  });

  it('falls back to the default rateLimit for a blank, non-numeric, or out-of-range override', () => {
    for (const bogus of ['', 'not-a-number', '0', '5000', -1, NaN]) {
      for (const a of buildPair({ ...FULL_PARAMS, rateLimitMax: bogus })) {
        expect(node(a.config, 't').params.rateLimit).toEqual({ maxActions: 20, windowSeconds: 60 });
      }
    }
  });

  it('omits condition.sourceFilter on a direction whose source is unselected', () => {
    const [mtToMc, mcToMt] = buildPair({
      mtChannel: FULL_PARAMS.mtChannel,
      mcChannel: FULL_PARAMS.mcChannel,
    });
    expect(findByType(mtToMc.config, 'condition.sourceFilter')).toHaveLength(0);
    expect(findByType(mcToMt.config, 'condition.sourceFilter')).toHaveLength(0);
  });

  it('omits the trigger channels param on a direction whose channel is unselected', () => {
    const [mtToMc, mcToMt] = buildPair({
      mtSource: FULL_PARAMS.mtSource,
      mcSource: FULL_PARAMS.mcSource,
    });
    expect(node(mtToMc.config, 't').params).not.toHaveProperty('channels');
    expect(node(mcToMt.config, 't').params).not.toHaveProperty('channels');
  });

  it('ignores non-string/blank entries and takes only the first selected source/channel', () => {
    const [mtToMc] = buildPair({
      mtSource: ['', null, undefined, 42, 'mt1', 'mt2'],
      mtChannel: [{ name: 'First' }, { name: 'Second' }],
      mcSource: ['mc1'],
      mcChannel: [{ name: 'General' }],
    });
    expect(node(mtToMc.config, 'c0').params).toEqual({ sourceIds: ['mt1'] });
    expect(node(mtToMc.config, 't').params.channels).toEqual([{ name: 'First' }]);
  });

  it('every edge leaving a condition node is an implicit-true gate (no `port` field)', () => {
    for (const values of [{}, FULL_PARAMS]) {
      for (const a of buildPair(values)) {
        for (const edge of a.config.edges) {
          expect(edge).not.toHaveProperty('port');
        }
      }
    }
  });

  it('always validates across a representative param matrix', () => {
    for (const values of [
      {},
      FULL_PARAMS,
      { mtSource: ['mt1'] },
      { mcSource: ['mc1'] },
      { mtChannel: [{ name: 'General' }] },
      { mcChannel: [{ name: 'General' }] },
      { ...FULL_PARAMS, rateLimitMax: '1' },
      { ...FULL_PARAMS, rateLimitMax: '1000' },
    ]) {
      for (const a of buildPair(values)) {
        const result = validateAutomationGraph(a.config);
        expect(result.valid, JSON.stringify(result.errors)).toBe(true);
      }
    }
  });
});
