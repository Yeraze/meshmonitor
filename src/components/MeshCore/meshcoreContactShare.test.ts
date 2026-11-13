import { describe, it, expect } from 'vitest';
import { filterShareableContacts, listShareableContacts, selfContactToken } from './meshcoreContactShare';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

const k = (b: string) => b.repeat(32);

describe('listShareableContacts', () => {
  const contacts: MeshCoreContact[] = [
    { publicKey: k('bb'), advName: 'Zed', advType: 1 },
    { publicKey: k('aa'), name: 'Alpha', advType: 3 },
    { publicKey: k('cc'), advName: 'Rpt', advType: 2 },
    { publicKey: k('dd'), advName: 'Sensor', advType: 4 },
    { publicKey: k('ee'), advName: 'Unknown', advType: 0 },
    { publicKey: k('ff'), advName: '   ', advType: 1 },
    { publicKey: 'abc123', advName: 'Short', advType: 1 },
    { publicKey: k('11'), advName: 'Me', advType: 1 },
    { publicKey: k('bb'), advName: 'Zed again', advType: 1 },
  ];

  it('keeps types 1-3 with a full key and a name, minus self and duplicates, sorted', () => {
    const out = listShareableContacts(contacts, k('11'));
    expect(out.map((c) => c.name)).toEqual(['Alpha', 'Rpt', 'Zed']);
    expect(out[0].token).toBe(`<${k('AA')}:3:Alpha>`);
  });

  it('filters by name or key prefix', () => {
    const all = listShareableContacts(contacts, null);
    expect(filterShareableContacts(all, 'rp').map((c) => c.name)).toEqual(['Rpt']);
    expect(filterShareableContacts(all, 'BB').map((c) => c.name)).toEqual(['Zed']);
    expect(filterShareableContacts(all, '  ')).toHaveLength(all.length);
  });
});

describe('selfContactToken', () => {
  it('is always type 1', () => {
    expect(selfContactToken({ publicKey: k('ab'), name: 'Base' })).toBe(`<${k('AB')}:1:Base>`);
  });

  it.each([
    ['no node', null],
    ['repeater placeholder key', { publicKey: 'repeater', name: 'Rpt' }],
    ['blank name', { publicKey: k('ab'), name: '  ' }],
    ['missing name', { publicKey: k('ab') }],
  ])('is null with %s', (_label, node) => {
    expect(selfContactToken(node)).toBeNull();
  });
});
