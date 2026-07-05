import { describe, it, expect } from 'vitest';
import { getMapHoverTooltipMeta } from './nodeHops';

describe('getMapHoverTooltipMeta (issue #3925)', () => {
  it('shows SNR when heard directly (0 hops) and SNR is known', () => {
    const meta = getMapHoverTooltipMeta(0, -8.5);
    expect(meta).toEqual({ hops: 0, showSnr: true, snr: -8.5 });
  });

  it('shows SNR for an SNR value of 0 (falsy but valid)', () => {
    const meta = getMapHoverTooltipMeta(0, 0);
    expect(meta).toEqual({ hops: 0, showSnr: true, snr: 0 });
  });

  it('does not show SNR when heard directly but SNR is null', () => {
    const meta = getMapHoverTooltipMeta(0, null);
    expect(meta).toEqual({ hops: 0, showSnr: false, snr: null });
  });

  it('does not show SNR when heard directly but SNR is undefined', () => {
    const meta = getMapHoverTooltipMeta(0, undefined);
    expect(meta).toEqual({ hops: 0, showSnr: false, snr: null });
  });

  it('does not show SNR for multi-hop nodes even when SNR is present', () => {
    const meta = getMapHoverTooltipMeta(2, -12);
    expect(meta).toEqual({ hops: 2, showSnr: false, snr: null });
  });

  it('reports unknown hops (>= 999) as null and hides SNR', () => {
    const meta = getMapHoverTooltipMeta(999, -5);
    expect(meta).toEqual({ hops: null, showSnr: false, snr: null });
  });

  it('preserves a known multi-hop count', () => {
    const meta = getMapHoverTooltipMeta(3, undefined);
    expect(meta).toEqual({ hops: 3, showSnr: false, snr: null });
  });
});
