import { describe, it, expect } from 'vitest';
import { isMeshCoreRowComplete } from './meshcoreNodeCompleteness';

describe('isMeshCoreRowComplete', () => {
  it('is complete with a name and a known type', () => {
    expect(isMeshCoreRowComplete({ rawName: 'Alpha', advType: 1 })).toBe(true);
    expect(isMeshCoreRowComplete({ rawName: 'Rpt', advType: 2 })).toBe(true);
  });
  it('is incomplete without a name', () => {
    expect(isMeshCoreRowComplete({ rawName: null, advType: 1 })).toBe(false);
    expect(isMeshCoreRowComplete({ advType: 1 })).toBe(false);
    expect(isMeshCoreRowComplete({ rawName: '', advType: 1 })).toBe(false);
    expect(isMeshCoreRowComplete({ rawName: '   ', advType: 1 })).toBe(false);
  });
  it('is incomplete with an unknown type', () => {
    expect(isMeshCoreRowComplete({ rawName: 'Alpha' })).toBe(false);
    expect(isMeshCoreRowComplete({ rawName: 'Alpha', advType: 0 })).toBe(false);
  });
});
