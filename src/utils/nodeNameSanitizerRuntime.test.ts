/**
 * #6382 — runtime cache, local-node bypass and hit counter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetNodeNameSanitizerForTest,
  applyMeshCoreNodeNameSanitizer,
  applyMeshtasticNodeNameSanitizer,
  configureNodeNameSanitizer,
  getNodeNameSanitizerStats,
  isNodeNameSanitizerActive,
  setNodeNameLocalResolver,
} from './nodeNameSanitizerRuntime.js';

const ON = { enabled: true, builtins: true, customPatterns: [], placeholder: '[spammer]' };

describe('nodeNameSanitizerRuntime', () => {
  beforeEach(() => __resetNodeNameSanitizerForTest());

  it('is off by default and returns the same object untouched', () => {
    const node = { nodeNum: 1, nodeId: '!00000001', longName: 'A t.me/x' };
    expect(isNodeNameSanitizerActive()).toBe(false);
    expect(applyMeshtasticNodeNameSanitizer(node, 's')).toBe(node);
  });

  it('rewrites long and short names without mutating the input, and counts the hit', () => {
    configureNodeNameSanitizer({ ...ON, customPatterns: ['^SP$'] });
    const node = { nodeNum: 1, nodeId: '!00000001', longName: 'A t.me/x', shortName: 'SP' };
    const out = applyMeshtasticNodeNameSanitizer(node, 's');
    expect(out).toEqual({ nodeNum: 1, nodeId: '!00000001', longName: 'A [spammer]', shortName: '[spammer]' });
    expect(node.longName).toBe('A t.me/x');
    expect(getNodeNameSanitizerStats()).toMatchObject({ total: 1, meshtastic: 1, meshcore: 0 });
  });

  it('skips the local node, per source', () => {
    configureNodeNameSanitizer(ON);
    setNodeNameLocalResolver((q) => q.protocol === 'meshtastic' && q.sourceId === 'a' && q.nodeNum === 7);
    const node = { nodeNum: 7, nodeId: '!00000007', longName: 'Me t.me/x' };
    expect(applyMeshtasticNodeNameSanitizer(node, 'a')).toBe(node);
    expect(applyMeshtasticNodeNameSanitizer(node, 'b').longName).toBe('Me [spammer]');
  });

  it('treats a throwing resolver as "local" and leaves the name alone', () => {
    configureNodeNameSanitizer(ON);
    setNodeNameLocalResolver(() => { throw new Error('boom'); });
    const node = { nodeNum: 7, nodeId: '!00000007', longName: 'Me t.me/x' };
    expect(applyMeshtasticNodeNameSanitizer(node, 'a')).toBe(node);
  });

  it('MeshCore: honours the stored isLocalNode flag and the resolver', () => {
    configureNodeNameSanitizer(ON);
    setNodeNameLocalResolver((q) => q.protocol === 'meshcore' && q.publicKey === 'aa');
    expect(applyMeshCoreNodeNameSanitizer({ publicKey: 'bb', name: 'X t.me/y' }, 's', true).name).toBe('X t.me/y');
    expect(applyMeshCoreNodeNameSanitizer({ publicKey: 'aa', name: 'X t.me/y' }, 's', false).name).toBe('X t.me/y');
    expect(applyMeshCoreNodeNameSanitizer({ publicKey: 'bb', name: 'X t.me/y' }, 's', false).name).toBe('X [spammer]');
    expect(getNodeNameSanitizerStats().meshcore).toBe(1);
  });

  it('turning the setting off clears the rules', () => {
    configureNodeNameSanitizer(ON);
    configureNodeNameSanitizer({ ...ON, enabled: false });
    expect(isNodeNameSanitizerActive()).toBe(false);
  });
});
