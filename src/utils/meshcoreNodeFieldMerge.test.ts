import { describe, it, expect } from 'vitest';
import { indexNodeFields, mergeNodeFields } from './meshcoreNodeFieldMerge';
import type { MeshCoreNode } from '../components/MeshCore/hooks/useMeshCore';

const PK = 'aa'.repeat(32);
const node = (extra: Partial<MeshCoreNode>): MeshCoreNode => ({ publicKey: PK, name: 'n', advType: 1, ...extra });

describe('mergeNodeFields', () => {
  it('copies battery and first heard only into gaps', () => {
    const idx = indexNodeFields([node({ batteryMv: 4000, firstHeard: 5 })]);
    expect(mergeNodeFields({ publicKey: PK }, idx)).toMatchObject({ batteryMv: 4000, firstHeard: 5 });
    expect(mergeNodeFields({ publicKey: PK, batteryMv: 3, firstHeard: 9 }, idx)).toMatchObject({ batteryMv: 3, firstHeard: 9 });
  });
  it('node row wins for advert position, falling back per field', () => {
    const idx = indexNodeFields([node({ lastAdvertHadPosition: false })]);
    const c = mergeNodeFields({ publicKey: PK, lastAdvertHadPosition: true, positionSource: 'telemetry' }, idx);
    expect(c.lastAdvertHadPosition).toBe(false);
    expect(c.positionSource).toBe('telemetry');
  });
  it('skips advert position when the row has neither field', () => {
    const idx = indexNodeFields([node({})]);
    const c = { publicKey: PK, lastAdvertHadPosition: true };
    expect(mergeNodeFields(c, idx)).toBe(c);
  });
  it('merges signature true/false and leaves null unchecked', () => {
    expect(mergeNodeFields({ publicKey: PK }, indexNodeFields([node({ advertSignatureVerified: true })])).advertSignatureVerified).toBe(true);
    expect(mergeNodeFields({ publicKey: PK }, indexNodeFields([node({ advertSignatureVerified: false })])).advertSignatureVerified).toBe(false);
    const unchecked = mergeNodeFields({ publicKey: PK }, indexNodeFields([node({ advertSignatureVerified: null })]));
    expect(unchecked.advertSignatureVerified).toBeUndefined();
  });
  it('honours a field subset (DM view does not copy battery / first heard)', () => {
    const idx = indexNodeFields([node({ batteryMv: 4000, firstHeard: 5, advertSignatureVerified: false })]);
    const c = mergeNodeFields({ publicKey: PK }, idx, ['advertPosition', 'advertSignatureVerified']);
    expect(c.batteryMv).toBeUndefined();
    expect(c.firstHeard).toBeUndefined();
    expect(c.advertSignatureVerified).toBe(false);
  });
});
