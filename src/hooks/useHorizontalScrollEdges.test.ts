/**
 * Edge detection behind the sideways-scroll fade (#4173 review N3).
 */
import { describe, it, expect } from 'vitest';
import { measureHorizontalScrollEdges } from './useHorizontalScrollEdges';

describe('measureHorizontalScrollEdges', () => {
  it('reports no hidden edge when the content fits', () => {
    expect(measureHorizontalScrollEdges({ scrollLeft: 0, scrollWidth: 390, clientWidth: 390 }))
      .toEqual({ start: false, end: false });
  });

  it('reports the right edge at rest on a table wider than the box', () => {
    // The Reticulum destinations table: 743px in a 390px box.
    expect(measureHorizontalScrollEdges({ scrollLeft: 0, scrollWidth: 743, clientWidth: 390 }))
      .toEqual({ start: false, end: true });
  });

  it('reports both edges mid-scroll', () => {
    expect(measureHorizontalScrollEdges({ scrollLeft: 120, scrollWidth: 743, clientWidth: 390 }))
      .toEqual({ start: true, end: true });
  });

  it('reports only the left edge at the far end, with 1px slack for fractional offsets', () => {
    expect(measureHorizontalScrollEdges({ scrollLeft: 352.5, scrollWidth: 743, clientWidth: 390 }))
      .toEqual({ start: true, end: false });
  });

  it('ignores a sub-pixel overflow', () => {
    expect(measureHorizontalScrollEdges({ scrollLeft: 0, scrollWidth: 391, clientWidth: 390 }))
      .toEqual({ start: false, end: false });
  });
});
