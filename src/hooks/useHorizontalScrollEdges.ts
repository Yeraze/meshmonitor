/**
 * Which horizontal edges of a scroll box still hide content (#4173 review N3).
 *
 * A wide table in its own sideways scroller gives no hint on a phone that more
 * columns sit off-screen: mobile browsers draw no scrollbar until you touch
 * it. Callers fade whichever edge has content beyond it, the same cue the
 * mobile bottom tab bar uses (#4497, SourceNav).
 *
 * Re-measures on scroll, when the box resizes, and when its first child (the
 * table) resizes, since rows arriving widen the content without resizing the
 * box itself.
 */
import { useEffect, useState, type RefObject } from 'react';

export interface HorizontalScrollEdges {
  /** Content is hidden past the left edge. */
  start: boolean;
  /** Content is hidden past the right edge. */
  end: boolean;
}

/** Pure measurement, exported for tests. 1px slack absorbs fractional offsets. */
export function measureHorizontalScrollEdges(el: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): HorizontalScrollEdges {
  const scrollable = el.scrollWidth > el.clientWidth + 1;
  return {
    start: scrollable && el.scrollLeft > 1,
    end: scrollable && el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
  };
}

export function useHorizontalScrollEdges(ref: RefObject<HTMLElement | null>): HorizontalScrollEdges {
  const [edges, setEdges] = useState<HorizontalScrollEdges>({ start: false, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = measureHorizontalScrollEdges(el);
      setEdges(prev => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [ref]);

  return edges;
}
