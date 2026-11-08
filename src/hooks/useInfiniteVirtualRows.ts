/**
 * Virtualized rows with infinite load-more (#6262), extracted from
 * `PacketMonitorPanel`. The virtualizer renders only visible rows, so an
 * IntersectionObserver on a sentinel would never fire; instead we watch the
 * last rendered virtual index and load more when it nears the end of the data.
 */
import { useEffect } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';

export interface UseInfiniteVirtualRowsOptions {
  /** Loaded row count (excluding the trailing loader row). */
  count: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void | Promise<void>;
  /** Estimated row height in px. Default 36. */
  estimateSize?: number;
  getScrollElement: () => HTMLElement | null;
  /** Load when the last visible row is within this many rows of the end. Default 10. */
  loadThreshold?: number;
  overscan?: number;
}

/** The virtualizer has `count + 1` items while `hasMore` (the extra one is the loader row). */
export function useInfiniteVirtualRows({
  count,
  hasMore,
  loadingMore,
  loadMore,
  estimateSize = 36,
  getScrollElement,
  loadThreshold = 10,
  overscan = 10,
}: UseInfiniteVirtualRowsOptions): Virtualizer<HTMLElement, Element> {
  const rowVirtualizer = useVirtualizer({
    count: hasMore ? count + 1 : count,
    getScrollElement,
    estimateSize: () => estimateSize,
    overscan,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVirtualItemIndex = virtualItems[virtualItems.length - 1]?.index;

  useEffect(() => {
    if (lastVirtualItemIndex === undefined) return;
    if (lastVirtualItemIndex >= count - loadThreshold && hasMore && !loadingMore && count > 0) {
      void loadMore();
    }
  }, [lastVirtualItemIndex, count, hasMore, loadingMore, loadMore, loadThreshold]);

  return rowVirtualizer;
}
