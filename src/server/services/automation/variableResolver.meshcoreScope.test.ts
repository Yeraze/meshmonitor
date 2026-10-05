/**
 * Node-scoped variables on MeshCore (#5636). MeshCore has no node number, so
 * a node / sourceNode variable had no key and never saved. It now keys off the
 * public key, under a prefix no Meshtastic key can equal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutomationVariablesRepository, MESHCORE_SCOPE_PREFIX } from '../../../db/repositories/automationVariables.js';
import { VariableResolver } from './variableResolver.js';
import { varContextFromTrigger } from './engineContext.js';
import {
  buildMessageContext,
  buildMeshCoreMessageContext,
  buildMeshCoreNodeContext,
  buildReticulumMessageContext,
  buildNodeStaleContext,
  meshCoreSubjectKey,
} from './triggerContext.js';
import type { DbMessage } from '../../../services/database.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import { createTestDb } from '../../test-helpers/testDb.js';

const KEY = 'AB12'.repeat(16);
const key = AutomationVariablesRepository.buildScopeKey;

describe('buildScopeKey', () => {
  it('Meshtastic keys are unchanged', () => {
    expect(key('global', { sourceId: 's', nodeNum: 111 })).toBe('');
    expect(key('source', { sourceId: 's', nodeNum: 111 })).toBe('s');
    expect(key('node', { sourceId: 's', nodeNum: 111 })).toBe('111');
    expect(key('sourceNode', { sourceId: 's', nodeNum: 111 })).toBe('s:111');
    expect(key('node', { sourceId: 's', nodeNum: 0 })).toBe('0');
  });

  it('a node number wins over a node key', () => {
    expect(key('node', { nodeNum: 111, nodeKey: KEY })).toBe('111');
    expect(key('sourceNode', { sourceId: 's', nodeNum: 111, nodeKey: KEY })).toBe('s:111');
  });

  it('a MeshCore node keys off its public key, lower-cased, under mc:', () => {
    expect(MESHCORE_SCOPE_PREFIX).toBe('mc:');
    expect(key('node', { sourceId: 's', nodeKey: KEY })).toBe(`mc:${KEY.toLowerCase()}`);
    expect(key('sourceNode', { sourceId: 's', nodeKey: KEY })).toBe(`s:mc:${KEY.toLowerCase()}`);
    expect(key('node', { nodeKey: KEY.toLowerCase() })).toBe(key('node', { nodeKey: KEY }));
  });

  it('no node at all is still no key', () => {
    expect(key('node', { sourceId: 's' })).toBeNull();
    expect(key('node', { sourceId: 's', nodeKey: '' })).toBeNull();
    expect(key('node', { sourceId: 's', nodeKey: null })).toBeNull();
    expect(key('sourceNode', { nodeKey: KEY })).toBeNull(); // no source
  });

  it('a MeshCore key can never equal a Meshtastic one, even for an all-digit public key', () => {
    // A Meshtastic node key is decimal digits only; the prefix is not.
    for (const digits of ['1', '111', '4294967295', '1'.repeat(64)]) {
      expect(key('node', { nodeKey: digits })).toBe(`mc:${digits}`);
      expect(key('node', { nodeKey: digits })).not.toBe(key('node', { nodeNum: Number(digits) }));
      expect(key('sourceNode', { sourceId: 's', nodeKey: digits })).not.toBe(key('sourceNode', { sourceId: 's', nodeNum: Number(digits) }));
    }
    expect(/^\d+$/.test(key('node', { nodeKey: KEY })!)).toBe(false);
  });
});

describe('which triggers carry a MeshCore node key', () => {
  const mc = (over: Partial<MeshCoreMessage>): MeshCoreMessage => ({ id: 'm', text: 'hi', timestamp: 1, ...over } as MeshCoreMessage);

  it('a MeshCore DM: the sender\'s public key', () => {
    const ctx = buildMeshCoreMessageContext(mc({ fromPublicKey: KEY, toPublicKey: 'ee'.repeat(32) }), 'mc1', 1);
    expect(varContextFromTrigger(ctx)).toEqual({ sourceId: 'mc1', nodeNum: null, nodeKey: KEY });
  });

  it('a MeshCore channel post: none (the channel slot is not a sender)', () => {
    const ctx = buildMeshCoreMessageContext(mc({ fromPublicKey: 'channel-3' }), 'mc1', 1);
    expect(varContextFromTrigger(ctx)).toEqual({ sourceId: 'mc1', nodeNum: null, nodeKey: null });
  });

  it('MeshCore node discovered / updated / silent: the node\'s public key', () => {
    expect(meshCoreSubjectKey(buildMeshCoreNodeContext('trigger.nodeUpdated', KEY, [], 'mc1', 1))).toBe(KEY);
    const stale = buildNodeStaleContext(null, KEY, 5, 1, 0, 'mc1', 1);
    expect(stale.subjectNodeNum).toBeNull();
    expect(meshCoreSubjectKey(stale)).toBe(KEY);
  });

  it('Meshtastic: the node number only', () => {
    const msg = { id: 'x', fromNodeNum: 111, toNodeNum: 4294967295, text: 'hi', channel: 0, portnum: 1 } as unknown as DbMessage;
    expect(varContextFromTrigger(buildMessageContext(msg, 'default', 1))).toEqual({ sourceId: 'default', nodeNum: 111, nodeKey: null });
  });

  it('Reticulum is left as it was: no node key', () => {
    const ctx = buildReticulumMessageContext({ fromHash: 'f'.repeat(32), toHash: 't'.repeat(32), content: 'hi' } as any, 'ret1', 1);
    expect(varContextFromTrigger(ctx).nodeKey).toBeNull();
  });
});

describe('VariableResolver — MeshCore node scope, stored and read back', () => {
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let repo: AutomationVariablesRepository;
  let resolver: VariableResolver;

  beforeEach(() => {
    const t = createTestDb();
    sqlite = t.sqlite;
    repo = new AutomationVariablesRepository(t.db, 'sqlite');
    resolver = new VariableResolver(repo);
  });
  afterEach(() => sqlite.close());

  const mcCtx = (publicKey: string, sourceId = 'mc1') => ({ sourceId, nodeNum: null, nodeKey: publicKey });

  it('node scope: saved for one MeshCore node, read back for it, absent for another', async () => {
    await repo.createVariable({ name: 'seen', type: 'integer', scope: 'node' });
    expect(await resolver.setValue('seen', 3, mcCtx(KEY))).toEqual({ ok: true });
    expect(await resolver.getValue('seen', mcCtx(KEY))).toBe(3);
    expect(await resolver.getValue('seen', mcCtx(KEY.toLowerCase()))).toBe(3); // key case does not matter
    expect(await resolver.getValue('seen', mcCtx('cd'.repeat(32)))).toBeNull();
    expect((await resolver.increment('seen', 2, mcCtx(KEY))).ok).toBe(true);
    expect(await resolver.getValue('seen', mcCtx(KEY))).toBe(5);
  });

  it('sourceNode scope: the same MeshCore node on two sources is kept apart', async () => {
    await repo.createVariable({ name: 'last', type: 'string', scope: 'sourceNode' });
    await resolver.setValue('last', 'one', mcCtx(KEY, 'mc1'));
    await resolver.setValue('last', 'two', mcCtx(KEY, 'mc2'));
    expect(await resolver.getValue('last', mcCtx(KEY, 'mc1'))).toBe('one');
    expect(await resolver.getValue('last', mcCtx(KEY, 'mc2'))).toBe('two');
  });

  it('flags arm and clear per MeshCore node', async () => {
    await repo.createVariable({ name: 'welcomed', type: 'flag', scope: 'node' });
    await resolver.setFlag('welcomed', mcCtx(KEY));
    expect(await resolver.getValue('welcomed', mcCtx(KEY))).toBe(true);
    await resolver.clearFlag('welcomed', mcCtx(KEY));
    expect(await resolver.getValue('welcomed', mcCtx(KEY))).toBeNull();
  });

  it('no collision: a Meshtastic node and a MeshCore node with the "same" id hold separate values', async () => {
    const def = await repo.createVariable({ name: 'v', type: 'string', scope: 'node' });
    await resolver.setValue('v', 'meshtastic', { sourceId: 's', nodeNum: 12345 });
    await resolver.setValue('v', 'meshcore', { sourceId: 's', nodeNum: null, nodeKey: '12345' });
    expect(await resolver.getValue('v', { sourceId: 's', nodeNum: 12345 })).toBe('meshtastic');
    expect(await resolver.getValue('v', { sourceId: 's', nodeNum: null, nodeKey: '12345' })).toBe('meshcore');
    expect(await repo.getEffectiveValue(def.id, '12345')).toBe('meshtastic'); // the Meshtastic key is unchanged
    expect(await repo.getEffectiveValue(def.id, 'mc:12345')).toBe('meshcore');
  });

  it('still refuses a node-scoped write when there is no node of either kind', async () => {
    await repo.createVariable({ name: 'v', type: 'string', scope: 'node' });
    expect(await resolver.setValue('v', 'x', { sourceId: 's', nodeNum: null, nodeKey: null }))
      .toEqual({ ok: false, error: 'missing scope context for "v" (node)' });
  });

  it('checkSet reports what setValue would, and writes nothing', async () => {
    const def = await repo.createVariable({ name: 'n', type: 'integer', scope: 'global' });
    await repo.createVariable({ name: 'ro', type: 'string', scope: 'global', readonly: true });
    await repo.createVariable({ name: 'pn', type: 'string', scope: 'node' });
    await repo.createVariable({ name: 'fl', type: 'flag', scope: 'global' });
    expect(await resolver.checkSet('gone', 1, {})).toEqual({ ok: false, error: 'unknown variable "gone"' });
    expect(await resolver.checkSet('ro', 'x', {})).toEqual({ ok: false, error: 'variable "ro" is readonly' });
    expect(await resolver.checkSet('pn', 'x', {})).toEqual({ ok: false, error: 'missing scope context for "pn" (node)' });
    expect(await resolver.checkSet('n', 'abc', {})).toEqual({ ok: false, error: 'value not representable as integer' });
    expect(await resolver.checkSet('n', 7, {})).toEqual({ ok: true });
    expect(await resolver.checkSet('fl', undefined, {})).toEqual({ ok: true });
    expect(await repo.getRawValue(def.id, '')).toBeNull();
  });
});
