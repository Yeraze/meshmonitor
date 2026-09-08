/**
 * #5137: Philly Mesh moved the region to "MeshCore 500" on 2026-09-02 to get
 * inside FCC 15.247(a)(2). These lock the published parameters, and guard the
 * table-wide invariants that `findPresetId` depends on.
 *
 * https://phillymesh.net/2026/09/02/fcc-regulations/
 */
import { describe, it, expect } from 'vitest';
import { RADIO_PRESETS, findPresetId } from './radioPresets';

describe('RADIO_PRESETS', () => {
  it('carries the Philadelphia MeshCore 500 parameters exactly as published', () => {
    const philly = RADIO_PRESETS.find(p => p.id === 'us-philly');
    expect(philly).toBeDefined();
    expect({
      freq: philly!.freq,
      bw: philly!.bw,
      sf: philly!.sf,
      cr: philly!.cr,
    }).toEqual({ freq: 902.25, bw: 500, sf: 11, cr: 5 });
  });

  it('tells the user about the 2-byte path hash the preset cannot set itself', () => {
    // A preset only carries freq/bw/sf/cr. Philly also standardises on a
    // 2-byte path hash, which lives in Settings — without the note a user
    // lands on a node that looks configured and still mis-routes.
    const philly = RADIO_PRESETS.find(p => p.id === 'us-philly');
    expect(philly?.note).toMatch(/path hash/i);
  });

  it('has no duplicate ids', () => {
    const ids = RADIO_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('adds no NEW preset that shadows another by radio parameters', () => {
    // findPresetId resolves by value and returns the FIRST match, so a
    // duplicate tuple makes the later preset unselectable — the picker
    // silently jumps to its twin.
    //
    // One such pair already exists: 'ch' (Switzerland) is identical to
    // 'eu-uk-narrow' at 869.618/62.5/SF8/CR8, so picking Switzerland snaps the
    // dropdown back to EU/UK (Narrow). That predates #5137 and de-duplicating
    // it is a call about what Swiss users should see, not a test fix — so this
    // records it as the ONLY tolerated collision and fails on any new one.
    const KNOWN_COLLISIONS = [['eu-uk-narrow', 'ch']];

    const byTuple = new Map<string, string[]>();
    for (const p of RADIO_PRESETS) {
      const key = `${p.freq}|${p.bw}|${p.sf}|${p.cr}`;
      byTuple.set(key, [...(byTuple.get(key) ?? []), p.id]);
    }
    const collisions = [...byTuple.values()].filter(ids => ids.length > 1);
    expect(collisions).toEqual(KNOWN_COLLISIONS);
  });
});

describe('findPresetId', () => {
  it('round-trips every preset', () => {
    // 'ch' is excluded: it is parameter-identical to the earlier
    // 'eu-uk-narrow' and can never resolve to itself. See the collision test
    // above for why that is recorded rather than fixed here.
    for (const p of RADIO_PRESETS.filter(p => p.id !== 'ch')) {
      expect(findPresetId(p.freq, p.bw, p.sf, p.cr)).toBe(p.id);
    }
  });

  it('resolves the Philadelphia parameters to us-philly', () => {
    expect(findPresetId(902.25, 500, 11, 5)).toBe('us-philly');
  });

  it('returns custom for parameters no preset covers', () => {
    // Same frequency, narrower bandwidth — must NOT fall through to Philly.
    expect(findPresetId(902.25, 250, 11, 5)).toBe('custom');
  });
});
