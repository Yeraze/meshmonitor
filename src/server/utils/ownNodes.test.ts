/**
 * Cross-source self-identity (#4593). See utils/ownNodes.ts for why an
 * `mqtt_bridge` needs this: it has no local node of its own, so the per-source
 * self-origin guard (#3914) cannot recognise our own traffic arriving there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getOwnNodeNums, isOwnNodeNum } from './ownNodes.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';

function fakeManager(sourceId: string, sourceType: any, nodeNum: number | null): ISourceManager {
  return {
    sourceId,
    sourceType,
    start: async () => undefined,
    stop: async () => undefined,
    getStatus: () => ({ sourceId, sourceName: sourceId, sourceType, connected: true }),
    getLocalNodeInfo: () =>
      nodeNum == null ? null : { nodeNum, nodeId: `!${nodeNum.toString(16)}`, longName: 'n', shortName: 'n' },
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
});
