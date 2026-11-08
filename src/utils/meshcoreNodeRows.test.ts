import { describe, it, expect } from 'vitest';
import {
  mergeNodesAndContacts,
  meshcoreNodeSortKey,
  toMeshCoreFilterSubject,
  MESHCORE_NODE_EXPORT_COLUMNS,
  MESHCORE_NODE_SORT_FIELDS,
  MESHCORE_ROLE_FILTER_OPTIONS,
} from './meshcoreNodeRows';
import { sortByKey } from './nodeSort';

const PK = 'AB'.repeat(32);

describe('mergeNodesAndContacts', () => {
  it('carries battery, uptime, hops, position and first heard', () => {
    const [row] = mergeNodesAndContacts(
      [{ publicKey: PK, name: 'N', advType: 2, batteryMv: 4000, uptimeSecs: 5, firstHeard: 123 }],
      [{ publicKey: PK, pathLen: 2, latitude: 1, longitude: 2 }],
      new Set([PK.toLowerCase()]),
    );
    expect(row).toMatchObject({
      batteryMv: 4000, uptimeSecs: 5, pathLen: 2, latitude: 1, longitude: 2,
      firstHeard: 123, hasPosition: true, isIgnored: true, isMeshCore: true,
    });
  });
  it('builds a row from a contact only', () => {
    const [row] = mergeNodesAndContacts([], [{ publicKey: PK, advName: 'C', batteryMv: 3900 }]);
    expect(row).toMatchObject({ name: 'C', batteryMv: 3900, isIgnored: false });
  });
});

describe('meshcoreNodeSortKey', () => {
  const base = { publicKey: PK, name: 'x', hasName: true, hasPosition: false, isFavorite: false, isIgnored: false, isRepeaterNeighbor: false, isLocal: false, isMeshCore: true as const };
  it('offers the 7 MeshCore fields', () => {
    expect(MESHCORE_NODE_SORT_FIELDS).toHaveLength(7);
  });
  it('lowercases public key (#6185) and defaults missing values', () => {
    expect(meshcoreNodeSortKey(base, 'id')).toBe(PK.toLowerCase());
    expect(meshcoreNodeSortKey(base, 'lastHeard')).toBe(0);
    expect(meshcoreNodeSortKey(base, 'snr')).toBe(-999);
    expect(meshcoreNodeSortKey(base, 'battery')).toBe(-1);
    expect(meshcoreNodeSortKey(base, 'uptime')).toBe(-1);
    expect(meshcoreNodeSortKey(base, 'hops')).toBe(999);
    expect(meshcoreNodeSortKey(base, 'shortName')).toBeUndefined();
  });
  it('sorts missing battery last when descending', () => {
    const rows = [base, { ...base, name: 'b', batteryMv: 3000 }];
    expect(sortByKey(rows, (r) => meshcoreNodeSortKey(r, 'battery'), 'desc').map((r) => r.name)).toEqual(['b', 'x']);
  });
});

describe('filter subject, export and roles', () => {
  const row = mergeNodesAndContacts([{ publicKey: PK, name: '', advType: 3 }], [])[0];
  it('maps role, unknown and hops', () => {
    expect(toMeshCoreFilterSubject(row)).toMatchObject({ role: 3, isUnknown: true, channel: -1, isIgnored: false });
  });
  it('exports battery in volts', () => {
    const cols = Object.fromEntries(MESHCORE_NODE_EXPORT_COLUMNS.map((c) => [c.key, c]));
    expect(cols.battery.value({ ...row, batteryMv: 4120 })).toBe('4.12');
    expect(cols.type.value(row)).toBe('Room Server');
    expect(cols.hops.value(row)).toBe('');
  });
  it('lists advType 0-4', () => {
    expect(MESHCORE_ROLE_FILTER_OPTIONS.map((o) => o.value)).toEqual([0, 1, 2, 3, 4]);
  });
});
