import { describe, it, expect } from 'vitest';
import {
  findPathHashCollisions,
  collisionCountsByWidth,
  listSignatureFailures,
  findNameReuse,
  nameReuseSuspectKeys,
} from './meshcoreSecurityFindings.js';

const key = (prefix: string, fill = '0') => prefix + fill.repeat(64 - prefix.length);
const NOW = 1_000_000;

describe('findPathHashCollisions', () => {
  const nodes = [
    { publicKey: key('ab12', '1'), advType: 2 },
    { publicKey: key('ab34', '2'), advType: 3 },
    { publicKey: key('ab12', '3'), advType: 2 },
    { publicKey: key('ab56', '4'), advType: 1 }, // companion: ignored
    { publicKey: key('cd00', '5'), advType: 2 },
    { publicKey: key('ab99', '6'), advType: null }, // unknown type: ignored
  ];

  it('groups routing nodes by hash at each width', () => {
    const w1 = findPathHashCollisions(nodes, 1);
    expect(w1).toHaveLength(1);
    expect(w1[0].hash).toBe('ab');
    expect(w1[0].nodes.map((n) => n.publicKey.slice(0, 4))).toEqual(['ab12', 'ab12', 'ab34']);

    const w2 = findPathHashCollisions(nodes, 2);
    expect(w2.map((g) => g.hash)).toEqual(['ab12']);
    expect(findPathHashCollisions(nodes, 3)).toEqual([]);
  });

  it('only counts advType 2 and 3', () => {
    const onlyOthers = [
      { publicKey: key('ab01'), advType: 1 },
      { publicKey: key('ab02', '1'), advType: 4 },
    ];
    expect(findPathHashCollisions(onlyOthers, 1)).toEqual([]);
  });

  it('countsByWidth reports groups at 1, 2 and 3 bytes', () => {
    const three = [
      { publicKey: key('aabbcc', '1'), advType: 2 },
      { publicKey: key('aabbcc', '2'), advType: 2 },
      { publicKey: key('aabbdd', '3'), advType: 3 },
      { publicKey: key('aaeeff', '4'), advType: 2 },
    ];
    expect(collisionCountsByWidth(three)).toEqual({ 1: 1, 2: 1, 3: 1 });
  });

  it('heardSinceMs drops stale nodes and one row per key counts once', () => {
    const list = [
      { publicKey: key('ab01', '1'), advType: 2, lastHeard: NOW },
      { publicKey: key('ab02', '2'), advType: 2, lastHeard: NOW - 100 },
      { publicKey: key('ab02', '2').toUpperCase(), advType: 2, lastHeard: NOW },
    ];
    expect(findPathHashCollisions(list, 1, { heardSinceMs: NOW - 10 })).toHaveLength(1);
    expect(findPathHashCollisions(list.slice(0, 2), 1, { heardSinceMs: NOW - 10 })).toEqual([]);
    expect(findPathHashCollisions([list[1], list[2]], 1)).toEqual([]);
  });
});

describe('listSignatureFailures', () => {
  it('lists only false; null and true never count', () => {
    const rows = [
      { publicKey: 'a', advertSignatureVerified: false },
      { publicKey: 'b', advertSignatureVerified: null },
      { publicKey: 'c', advertSignatureVerified: true },
      { publicKey: 'd' },
      { publicKey: 'e', advertSignatureVerified: 0 },
    ];
    expect(listSignatureFailures(rows).map((n) => n.publicKey)).toEqual(['a', 'e']);
  });
});

describe('findNameReuse', () => {
  it('matches trimmed and case-insensitive; original is the earliest firstHeard', () => {
    const rows = [
      { publicKey: key('bb'), name: '  Hilltop ', firstHeard: 200 },
      { publicKey: key('aa'), name: 'hilltop', firstHeard: 100 },
      { publicKey: key('cc'), name: 'HILLTOP', firstHeard: 300 },
      { publicKey: key('dd'), name: 'Valley', firstHeard: 50 },
    ];
    const groups = findNameReuse(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('hilltop');
    expect(groups[0].original.publicKey).toBe(key('aa'));
    expect(groups[0].suspects.map((s) => s.publicKey)).toEqual([key('bb'), key('cc')]);
    expect([...nameReuseSuspectKeys(groups)].sort()).toEqual([key('bb'), key('cc')]);
  });

  it('ignores empty / blank names and a single key seen twice', () => {
    const rows = [
      { publicKey: key('aa'), name: '' },
      { publicKey: key('bb'), name: '   ' },
      { publicKey: key('cc'), name: null },
      { publicKey: key('dd'), name: 'Same' },
      { publicKey: key('dd').toUpperCase(), name: 'same' },
    ];
    expect(findNameReuse(rows)).toEqual([]);
  });

  it('a node with no firstHeard loses to one with it, ties break by key', () => {
    const rows = [
      { publicKey: key('bb'), name: 'x' },
      { publicKey: key('aa'), name: 'x' },
      { publicKey: key('cc'), name: 'x', firstHeard: 5 },
    ];
    const [g] = findNameReuse(rows);
    expect(g.original.publicKey).toBe(key('cc'));
    expect(g.suspects.map((s) => s.publicKey)).toEqual([key('aa'), key('bb')]);
  });
});
