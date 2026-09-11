/**
 * "Spread Nodes" toggle for the within-accuracy-cell marker offset (#5177).
 *
 * Low-precision nodes are drawn at a deterministic offset INSIDE their accuracy
 * cell so same-cell markers declutter (#4016/#4155). A reporter compared a pin
 * to the node's reported GPS on OpenStreetMap and read the offset as the map
 * lying about the position — both readings are fair, so it became a per-user
 * choice. These tests pin the contract of the `enabled` flag: off means every
 * node sits exactly where it said it was, and on is byte-for-byte the old
 * behaviour.
 */
import { describe, it, expect } from 'vitest';
import { applyPrecisionCellOffsets, type PrecisionOffsetInput } from './precisionOffset';

/** Two nodes sharing one coarse (offsettable) accuracy cell. */
function sameCellPair(): Array<PrecisionOffsetInput<string>> {
  const latLng: [number, number] = [40.5, -74.25];
  return [
    { item: 'a', id: 'node-a', latLng, bits: 16, isOverride: false },
    { item: 'b', id: 'node-b', latLng, bits: 16, isOverride: false },
  ];
}

describe('applyPrecisionCellOffsets — Spread Nodes toggle (#5177)', () => {
  it('offsets same-cell nodes when enabled (unchanged behaviour)', () => {
    const out = applyPrecisionCellOffsets(sameCellPair(), { enabled: true });
    expect(out[0].latLng).not.toEqual([40.5, -74.25]);
    expect(out[1].latLng).not.toEqual([40.5, -74.25]);
    // ...and to different spots, which is the whole point of spreading.
    expect(out[0].latLng).not.toEqual(out[1].latLng);
  });

  it('leaves every node on its reported position when disabled', () => {
    const out = applyPrecisionCellOffsets(sameCellPair(), { enabled: false });
    expect(out[0].latLng).toEqual([40.5, -74.25]);
    expect(out[1].latLng).toEqual([40.5, -74.25]);
  });

  it('defaults to enabled, so a caller that passes no options is unaffected', () => {
    const withDefault = applyPrecisionCellOffsets(sameCellPair());
    const explicit = applyPrecisionCellOffsets(sameCellPair(), { enabled: true });
    expect(withDefault.map(o => o.latLng)).toEqual(explicit.map(o => o.latLng));
    // An empty options object is also "enabled".
    const emptyOpts = applyPrecisionCellOffsets(sameCellPair(), {});
    expect(emptyOpts.map(o => o.latLng)).toEqual(explicit.map(o => o.latLng));
  });

  it('preserves item identity and input order when disabled', () => {
    const out = applyPrecisionCellOffsets(sameCellPair(), { enabled: false });
    expect(out.map(o => o.item)).toEqual(['a', 'b']);
  });

  it('disabling changes nothing for nodes that were never offset anyway', () => {
    // Fine GPS (bits above the obscured threshold) is never offset in either mode.
    const fine: Array<PrecisionOffsetInput<string>> = [
      { item: 'x', id: 'node-x', latLng: [1.5, 2.5], bits: 32, isOverride: false },
      { item: 'y', id: 'node-y', latLng: [1.5, 2.5], bits: 32, isOverride: false },
    ];
    const on = applyPrecisionCellOffsets(fine, { enabled: true });
    const off = applyPrecisionCellOffsets(fine, { enabled: false });
    expect(on.map(o => o.latLng)).toEqual([[1.5, 2.5], [1.5, 2.5]]);
    expect(off.map(o => o.latLng)).toEqual(on.map(o => o.latLng));
  });
});
