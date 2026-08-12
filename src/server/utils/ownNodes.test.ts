/**
 * Cross-source self-identity (#4593). See utils/ownNodes.ts for why an
 * `mqtt_bridge` needs this: it has no local node of its own, so the per-source
 * self-origin guard (#3914) cannot recognise our own traffic arriving there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getOwnNodeNums, isOwnNodeNum, getOwnPublicKeys, isOwnPublicKey } from './ownNodes.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

function fakeManager(
  sourceId: string,
  sourceType: any,
  nodeNum: number | null,
  publicKey: string | null = null,
): ISourceManager {
  return {
    sourceId,
    sourceType,
    start: async () => undefined,
    stop: async () => undefined,
    getStatus: () => ({ sourceId, sourceName: sourceId, sourceType, connected: true }),
    getLocalNodeInfo: () =>
      nodeNum == null ? null : { nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'n', shortName: 'n' },
    getLocalNode: () => (publicKey == null ? null : { publicKey, name: 'n', advType: 1 }),
    startDistanceDeleteScheduler: async () => undefined,
    stopDistanceDeleteScheduler: () => undefined,
  } as ISourceManager;
}

describe('ownNodes', () => {
  const added: string[] = [];
  const add = async (m: ISourceManager) => { added.push(m.sourceId); await sourceManagerRegistry.addManager(m); };

  afterEach(async () => {
    while (added.length) await sourceManagerRegistry.removeManager(added.pop()!);
  });

  it('is empty (and drops nothing) when no source is registered', () => {
    expect(getOwnNodeNums()).toEqual([]);
    expect(isOwnNodeNum(0x11223344)).toBe(false);
  });

  it('collects the local node of every source that has one', async () => {
    await add(fakeManager('tcp-a', 'meshtastic_tcp', 0x11223344));
    await add(fakeManager('tcp-b', 'meshtastic_tcp', 0x55667788));

    expect(getOwnNodeNums().sort()).toEqual([0x11223344, 0x55667788].sort());
    expect(isOwnNodeNum(0x11223344)).toBe(true);
    expect(isOwnNodeNum(0x55667788)).toBe(true);
    expect(isOwnNodeNum(0x0a0b0c0d)).toBe(false);
  });

  it('ignores identity-less sources (an mqtt_bridge contributes nothing)', async () => {
    await add(fakeManager('bridge-1', 'mqtt_bridge', null));
    expect(getOwnNodeNums()).toEqual([]);
  });

  it('recognises a node owned by ANY source, not just the one asking', async () => {
    await add(fakeManager('bridge-1', 'mqtt_bridge', null));
    await add(fakeManager('tcp-a', 'meshtastic_tcp', 0x11223344));

    // The message arrived on bridge-1, but the node belongs to tcp-a → still ours.
    expect(isOwnNodeNum(0x11223344)).toBe(true);
  });

  it('survives a manager that throws while reporting its local node', async () => {
    const broken = fakeManager('broken', 'meshtastic_tcp', 1);
    (broken as any).getLocalNodeInfo = () => { throw new Error('mid-connect'); };
    await add(broken);
    await add(fakeManager('tcp-a', 'meshtastic_tcp', 0x11223344));

    expect(getOwnNodeNums()).toEqual([0x11223344]);
  });

  it('treats null/undefined/NaN node numbers as not ours', async () => {
    await add(fakeManager('tcp-a', 'meshtastic_tcp', 0x11223344));
    expect(isOwnNodeNum(null)).toBe(false);
    expect(isOwnNodeNum(undefined)).toBe(false);
    expect(isOwnNodeNum(Number.NaN)).toBe(false);
  });

  describe('MeshCore public keys (#4577 P2)', () => {
    it('is empty (and drops nothing) when no source is registered', () => {
      expect(getOwnPublicKeys()).toEqual([]);
      expect(isOwnPublicKey('abcd')).toBe(false);
    });

    it('collects the local public key of every MeshCore source that has one', async () => {
      await add(fakeManager('mc-a', 'meshcore', null, 'AABBCC'));
      await add(fakeManager('mc-b', 'meshcore', null, 'DDEEFF'));

      expect(getOwnPublicKeys().sort()).toEqual(['aabbcc', 'ddeeff'].sort());
      expect(isOwnPublicKey('AABBCC')).toBe(true);
      expect(isOwnPublicKey('ddeeff')).toBe(true);
      expect(isOwnPublicKey('112233')).toBe(false);
    });

    it('ignores non-MeshCore sources (meshtastic/mqtt contribute nothing)', async () => {
      await add(fakeManager('tcp-a', 'meshtastic_tcp', 0x11223344));
      await add(fakeManager('bridge-1', 'mqtt_bridge', null));
      expect(getOwnPublicKeys()).toEqual([]);
      expect(isOwnPublicKey('anything')).toBe(false);
    });

    it('matches case-insensitively', async () => {
      await add(fakeManager('mc-a', 'meshcore', null, 'AaBbCc'));
      expect(isOwnPublicKey('aabbcc')).toBe(true);
      expect(isOwnPublicKey('AABBCC')).toBe(true);
    });

    it('recognises a key owned by ANY MeshCore source, not just the one asking', async () => {
      await add(fakeManager('mc-a', 'meshcore', null, 'AABBCC'));
      await add(fakeManager('mc-b', 'meshcore', null, 'DDEEFF'));

      // A message that arrived via mc-b but carries mc-a's own key is still ours.
      expect(isOwnPublicKey('aabbcc')).toBe(true);
    });

    it('dedupes when two sources report the same key', async () => {
      await add(fakeManager('mc-a', 'meshcore', null, 'AABBCC'));
      await add(fakeManager('mc-b', 'meshcore', null, 'aabbcc'));
      expect(getOwnPublicKeys()).toEqual(['aabbcc']);
    });

    it('survives a manager that throws while reporting its local node', async () => {
      const broken = fakeManager('broken', 'meshcore', null, 'AABBCC');
      (broken as any).getLocalNode = () => { throw new Error('mid-connect'); };
      await add(broken);
      await add(fakeManager('mc-a', 'meshcore', null, 'DDEEFF'));

      expect(getOwnPublicKeys()).toEqual(['ddeeff']);
    });

    it('treats null/undefined/empty pubkeys as not ours', async () => {
      await add(fakeManager('mc-a', 'meshcore', null, 'AABBCC'));
      expect(isOwnPublicKey(null)).toBe(false);
      expect(isOwnPublicKey(undefined)).toBe(false);
      expect(isOwnPublicKey('')).toBe(false);
    });
  });
});
